/**
 * PR #73 第三轮修改清单（astra 第二轮）：
 * - 1：可见的前驱在删除恢复时不应被拒（DEC-177 ② 员工当前部门在范围内；DEC-178 联动按可见判定），不可见的仍拒；
 *   首次提交与幂等重放一致。
 * - 2：恢复区间跨两个编制周期时，每个周期都按严格控编校验（原 P2-4 的残留）。
 * - 3：循环汇报拒绝信息服从人员范围与经理字段查看权，不暴露操作人看不到的人员。
 * - P3：撤销与审批同意的确定性交错（真 PostgreSQL，屏障固定谁先持员工锁）。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, TRANSFER_NODES, transferScene, type InstanceView } from './AC-APV-support.js';
import { activationWorld } from './AC-TRF-activation-support.js';
import { NOW, RECORD_FIELDS, scopedWorld } from './AC-TRF-delete-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();

describe('第三轮 1：可见前驱的恢复不被误拒（DEC-177 / 178）', () => {
  it('只管 B、员工当前仍在 B：A 的前驱经 DEC-177 ② 可见，删除 9/10 记录成功；同键重放返回原结果', async () => {
    const w = await scopedWorld(database().db, 'r3-visible');
    await w.addBusiness({
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-09-25',
      fields: { departmentId: w.b.id, place: '仍在 B' },
    });
    const onlyB = w.operator([w.b.id], RECORD_FIELDS, { personIds: [w.subject.employee.id] });
    const as = { user: w.session.user.id, tenant: w.session.tenant.id };
    for (const id of [w.subject.hire.id, w.toB.id]) {
      const readable = await onlyB.request('GET', `/api/tenant/employment/businesses/${id}`, as);
      expect(readable.status, `前驱与被删记录都可见：${id}`).toBe(200);
    }
    const key = randomUUID();
    const revision = (await w.business(w.toB.id)).revision;
    const request = () =>
      onlyB.request('DELETE', `/api/tenant/employment/businesses/${w.toB.id}`, {
        ...as,
        ifMatch: revision,
        idempotencyKey: key,
      });
    const deleted = await request();
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    const body = await deleted.json();
    expect((await w.timeline())[0]).toEqual({ id: w.subject.hire.id, stopDate: '2026-09-24' });
    const replay = await request();
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toEqual(body);
  });
});

describe('自查：同日后一条时前一条区间不变，不按联动复核', () => {
  it('只管 B：删除 9/10 当日较早的 B 记录（当日还有一条 B），A 的前驱不可见但区间不变，允许删除', async () => {
    const w = await scopedWorld(database().db, 'r3-same-day');
    const later = await w.addBusiness({
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-09-10',
      fields: { departmentId: w.b.id, place: '当日第二条' },
    });
    const before = (await w.timeline()).find((item) => item.id === w.subject.hire.id);
    const onlyB = w.operator([w.b.id]);
    const deleted = await w.remove(onlyB, w.toB.id);
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(await w.timeline()).toEqual([before, { id: later.id, stopDate: '9999-12-31' }]);
  });
});

describe('第三轮 2：恢复区间跨编制周期时每期都校验严格编制', () => {
  async function monthlyWorld(label: string) {
    const w = await activationWorld(database().db, label);
    const api = tenantApi(w.db, { clock: NOW });
    const establishment = (path: string, body: object) =>
      api.request('POST', `/api/tenant/establishment${path}`, {
        user: w.session.user.id,
        tenant: w.session.tenant.id,
        ifMatch: 0,
        body,
      });
    const scheme = await establishment('/schemes', {
      name: '合成月度严格控编',
      periodType: 'monthly',
      maintenanceMode: 'local',
      startDate: '2026-01-01',
      occupancyRanges: [{ employmentType: 'internal' }],
    });
    expect(scheme.status, await scheme.clone().text()).toBe(201);
    const schemeId = ((await scheme.json()) as { id: string }).id;
    // 逆序创建，9 月的自动带出不覆盖已明确维护的 10 月。
    for (const periodStart of ['2026-10-01', '2026-09-01']) {
      const capacity = await establishment('/capacities', {
        orgId: w.to.id,
        schemeId,
        periodStart,
        localCapacity: 1,
        strictControl: true,
      });
      expect(capacity.status, await capacity.clone().text()).toBe(201);
    }
    const third = await w.session.org('第三部门', { establishedOn: '2026-01-01' });
    const transfer = async (employeeId: string, date: string, departmentId: string) => {
      const employee = await w.session.getEmployee(employeeId);
      return w.session.business(
        employeeId,
        { kind: 'transfer', mode: 'direct', effectiveDate: date, fields: { departmentId } },
        employee.revision,
      );
    };
    const jia = await w.session.employee('甲');
    await w.session.business(
      jia.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { departmentId: w.to.id } },
      jia.revision,
    );
    const out = await transfer(jia.id, '2026-09-10', w.from.id);
    await transfer(jia.id, '2026-11-01', third.id);
    return { ...w, out, transfer, jia };
  }

  it.each([
    ['10 月有人调入：恢复段 9/10～10/31 在 10 月超编，整单拒绝', '2026-10-15', 409],
    ['他人 11/1 才调入（恢复段之后），不超编', '2026-11-01', 200],
  ] as const)('%s', async (_label, otherDate, expected) => {
    const w = await monthlyWorld(`r3-period-${otherDate}`);
    const yi = await w.hired('乙');
    await w.transfer(yi.employee.id, otherDate, w.to.id);
    const before = await w.session.records(w.jia.id);
    const response = await w.session.request('DELETE', `/businesses/${w.out.id}`, {
      ifMatch: (await w.business(w.out.id)).revision,
    });
    expect(response.status, await response.clone().text()).toBe(expected);
    if (expected === 409) {
      expect(await response.json()).toMatchObject({ error: { details: { reason: 'ESTABLISHMENT_EXCEEDED' } } });
      expect(await w.session.records(w.jia.id)).toEqual(before);
    }
  });
});

describe('第三轮 3：循环汇报拒绝不暴露操作人看不到的人员', () => {
  async function cycleWorld(label: string) {
    const w = await scopedWorld(database().db, label);
    const yi = await w.session.employee('范围外机密经理乙');
    await w.session.business(
      yi.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-08-01', fields: { departmentId: w.c.id } },
      yi.revision,
    );
    // 甲 9/1 入职 A 的经理是乙；9/10 调入 B 清空经理；9/25 再调回 A 仍无经理；乙 9/15 起经理为甲。
    const edit = await w.session.request('PATCH', `/records/${w.subject.hire.id}`, {
      ifMatch: (await w.business(w.subject.hire.id)).revision,
      body: { fields: { directManagerId: yi.id } },
    });
    expect(edit.status, await edit.clone().text()).toBe(200);
    const middle = await w.business(w.toB.id);
    const cleared = await w.session.request('PATCH', `/records/${middle.id}`, {
      ifMatch: middle.revision,
      body: { fields: { directManagerId: null } },
    });
    expect(cleared.status, await cleared.clone().text()).toBe(200);
    await w.addBusiness({
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-09-25',
      fields: { departmentId: w.a.id, directManagerId: null },
    });
    const yiNow = await w.session.getEmployee(yi.id);
    await w.session.business(
      yi.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-09-15',
        fields: { departmentId: w.c.id, directManagerId: w.subject.employee.id },
      },
      yiNow.revision,
    );
    return { ...w, yi };
  }

  it('只管 A、B 且无经理字段权限：仍拒绝删除，提示不含乙的姓名、ID 与成环日期；看全部且有经理字段时给出完整路径', async () => {
    const w = await cycleWorld('r3-cycle');
    const before = await w.timeline();
    const limited = w.operator([w.a.id, w.b.id]);
    const refused = await w.remove(limited, w.toB.id);
    const text = await refused.text();
    expect(refused.status, text).toBe(400);
    expect(JSON.parse(text)).toMatchObject({ error: { details: { reason: 'REPORTING_CYCLE' } } });
    expect(text).not.toContain('范围外机密经理乙');
    expect(text).not.toContain(w.yi.id);
    expect(text).not.toContain('2026-09-15');
    expect(await w.timeline()).toEqual(before);

    const full = w.operator([], [...RECORD_FIELDS, 'directManagerId'], { all: true });
    const disclosed = await w.remove(full, w.toB.id);
    const fullText = await disclosed.text();
    expect(disclosed.status, fullText).toBe(400);
    expect(fullText).toContain('范围外机密经理乙');
    expect(await w.timeline()).toEqual(before);
  });
});

async function waitForLockWaiters(db: Db, count: number) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const result = await db.execute(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND query ILIKE '%employment_employees%'`);
    const rows = (Array.isArray(result) ? result : (result as { rows: { n: number }[] }).rows) as { n: number }[];
    if (Number(rows[0]?.n) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`未等到 ${count} 个员工锁等待`);
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('P3：撤销与最后节点同意的确定性交错（真 PG）', () => {
  function current(view: InstanceView) {
    const tasks = view.tasks.filter((task) => task.status === 'pending');
    expect(tasks).toHaveLength(1);
    return tasks[0]!;
  }

  it.each(['revoke', 'approve'] as const)('%s 先排上员工锁：先者成功，后者 409，状态一致', async (first) => {
    const w = await approvalWorld(database().db, `r3-race-${first}`);
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!] });
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
    const view = await w.submit(draft);
    const business = await w.business(draft.id);
    const revoke = () =>
      w.request(w.hr.id, 'POST', `/api/tenant/employment/businesses/${draft.id}/revoke`, {
        ifMatch: business.revision,
      });
    const approve = () => w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision);
    const [firstResponse, secondResponse] = await withTenant(w.db, w.tenant.id, async (barrier) => {
      await barrier.execute(sql`SELECT id FROM employment_employees
        WHERE tenant_id=${w.tenant.id} AND id=${s.subject.employeeId}::uuid FOR UPDATE`);
      const one = first === 'revoke' ? revoke() : approve();
      await waitForLockWaiters(w.db, 1);
      const two = first === 'revoke' ? approve() : revoke();
      await waitForLockWaiters(w.db, 2);
      return [one, two] as const;
    });
    const [a, b] = [await firstResponse, await secondResponse];
    expect(a.status, await a.clone().text()).toBe(200);
    expect(b.status, await b.clone().text()).toBe(409);
    const final = await w.detail(view.id);
    const after = await w.business(draft.id);
    if (first === 'revoke') expect([final.status, after.status]).toEqual(['cancelled', 'voided']);
    else expect([final.status, after.status]).toEqual(['approved', 'effective']);
  });
});
