/**
 * AC-EMP-F565 第 2 轮（#rf565_r1）：F-565 第 1 轮遗留的同根因收口。
 *
 * P1-1 通用入口新建离职 / 退休（POST /employees/:id/businesses）进入离职守卫后，锁内只复验了范围与离职专属按钮，漏验通用新建按钮
 *      Employment.Create 与实际请求字段：首次执行与同键重放都要在命令事务内复验。
 * P1-2 撤销回执 / 离职编辑的下游明细投影必须按命令事务内采用的当前范围裁剪（runWrite 传入的 current），不能捕获入口旧范围。
 * P2-1 离职 / 退休编辑的公共预锁必须覆盖执行体会规划的全部参与人（请求新增下属、F-140b2 剩余失败职责），合法请求不得 409。
 * P2-2 执行体才会等待的业务头（改期、生效重试的 lockOtherBusinessHeads）与撤销记录行必须在读授权之前取齐并封口。
 *
 * 屏障用例只在真 PG 下有意义（TEST_DATABASE_URL，普通角色 app_owner）；其余用例在 PGlite 下同样运行。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { cancelWorld } from './AC-EXIT-cancel-support.js';
import { downstreamWorld } from './AC-EXIT-downstream-support.js';
import { gateWorld, leaveBody } from './AC-EXIT-gate-support.js';
import { dutyExitWorld } from './AC-DT-exit-support.js';
import { retireBody, retirementWorld } from './AC-RT-support.js';
import { withRehire } from './AC-RT-rehire-support.js';
import { emptyRange, pg, race, refused, state, type Db, type Scenario } from './support/lock-barrier.js';
import './support/exit-gate-enforced.js';
import { isButton, orgScope, revocable, snapshot } from './support/revocable-rights.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const BASE = '/api/tenant/employment';
const TODAY = '2026-10-06';
const LATER = '2026-10-20';

/** 入口放行、事务内可撤权的 API：clock 由调用方给（各夹具的“今天”不同）。 */
function revocableOn(
  w: { readonly db: Db; readonly session: { readonly tenant: { id: string }; readonly user: { id: string } } },
  clock: () => Date,
) {
  const as = { user: w.session.user.id, tenant: w.session.tenant.id };
  const { rights, authorize } = revocable();
  const api = tenantApi(w.db, { authorize, clock });
  const request = (method: string, path: string, options: Parameters<typeof api.request>[2] = {}) =>
    api.request(method, `${BASE}${path}`, { ...as, ...options });
  return { rights, request };
}

/**
 * 命令内把范围收窄到“只含离职员工所在部门”：被转交的下属 / 接收人、联动子项、调动单所在部门不在其内。
 * 员工所在部门之外的人由 {@link employeeIn} 建在另一个部门。
 */
const fromOnly = (w: { session: { tenant: { id: string } }; from: { id: string } }, asOf: string) =>
  orgScope(w.session.tenant.id, asOf, w.from.id);

/** 在指定部门入职的合成员工（可指定直线经理）。 */
async function employeeIn(
  w: {
    session: {
      employee: (n: string) => Promise<{ id: string; revision: number }>;
      business: (...a: never[]) => unknown;
    };
  },
  departmentId: string,
  name: string,
  directManagerId?: string,
) {
  const employee = await w.session.employee(name);
  await (w.session.business as (...a: unknown[]) => Promise<unknown>)(
    employee.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-09-01',
      fields: { departmentId, ...(directManagerId ? { directManagerId } : {}) },
    },
    employee.revision,
  );
  return employee;
}

const textOf = async (response: Response) => response.clone().text();

// ───────────────────────── P1-1 通用入口新建离职：锁内复验 Employment.Create ─────────────────────────

describe('F-565 R2 P1-1 通用新建离职（POST /employees/:id/businesses kind=leave）锁内复验 Employment.Create', () => {
  const clock = () => new Date(`${TODAY}T01:00:00.000Z`);
  async function scene(label: string) {
    const w = await gateWorld(database().db, label, { today: TODAY });
    const { employee } = await w.hired();
    const { rights, request } = revocableOn(w, clock);
    const revision = (await w.session.getEmployee(employee.id)).revision;
    const send = (key = randomUUID()) =>
      request('POST', `/employees/${employee.id}/businesses`, {
        ifMatch: revision,
        body: leaveBody(LATER),
        idempotencyKey: key,
      });
    return { w, employee, rights, send, snap: () => snapshot(w.db, w.session.tenant.id) };
  }
  /** 只收回通用新建按钮，保留离职申请按钮 Employment.DimissionApproval。 */
  const denyGenericCreate: Scenario['rights']['deny'] = isButton('Employment.Create');

  it('首次执行：命令事务内只撤通用新建按钮 → 403，零写入', async () => {
    const x = await scene(`f565r2-p11-first-${uniqueSuffix()}`);
    const before = await x.snap();
    x.rights.deny = denyGenericCreate;
    const response = await x.send();
    expect(response.status, await textOf(response)).toBe(403);
    expect(await x.snap()).toEqual(before);
  });

  it('同键重放：首次 201 之后只撤通用新建按钮 → 同键重放 403，不返回台账里的原 201', async () => {
    const x = await scene(`f565r2-p11-replay-${uniqueSuffix()}`);
    const key = randomUUID();
    const first = await x.send(key);
    expect(first.status, await textOf(first)).toBe(201);
    const after = await x.snap();
    x.rights.deny = denyGenericCreate;
    const replay = await x.send(key);
    expect(replay.status, await textOf(replay)).toBe(403);
    expect(await x.snap()).toEqual(after);
  });

  it('对照：没撤任何权限 → 201；同键重放仍是同一回执', async () => {
    const x = await scene(`f565r2-p11-ok-${uniqueSuffix()}`);
    const key = randomUUID();
    const first = await x.send(key);
    expect(first.status, await textOf(first)).toBe(201);
    const replay = await x.send(key);
    expect(replay.status, await textOf(replay)).toBe(201);
    expect(((await replay.json()) as { id: string }).id).toBe(((await first.json()) as { id: string }).id);
  });

  describe.runIf(pg)('PG16 屏障：等员工行锁期间只撤通用新建按钮', () => {
    const build = async (label: string) => {
      const x = await scene(label);
      return {
        x,
        s: {
          w: x.w,
          rights: x.rights,
          hold: { table: 'employees', id: x.employee.id },
          extraTables: ['exit_requests'],
          send: () => x.send(),
        } satisfies Scenario,
      };
    };
    it('放锁后 403，业务 / 审计 / 台账零写入', async () => {
      const { x, s } = await build(`f565r2-p11-pg-${uniqueSuffix()}`);
      const before = await state(s.w, s.extraTables);
      const r = await race(s, (rights) => void (rights.deny = denyGenericCreate));
      expect(r.waited, '请求没有排到锁上，屏障没有生效').toBe(true);
      expect(r.response.status, await textOf(r.response)).toBe(403);
      expect(await state(s.w, s.extraTables)).toEqual(before);
      expect(x.employee.id).toBeTruthy();
    });
    it('对照：不撤权 → 等完锁后 201', async () => {
      const { s } = await build(`f565r2-p11-pg-ok-${uniqueSuffix()}`);
      const r = await race(s, false);
      expect(r.waited, '请求没有排到锁上，屏障没有生效').toBe(true);
      expect(r.response.status, await textOf(r.response)).toBe(201);
    });
  });
});

// ───────────────────────── P1-2 投影按锁内当前范围裁剪 ─────────────────────────

describe('F-565 R2 P1-2 撤销回执 / 离职编辑提示按命令内当前范围裁剪下游明细', () => {
  const clock = () => new Date(`${TODAY}T01:00:00.000Z`);

  /** 已执行职责转交（approval_passed 时机）的直接离职单：撤销回执的“职责转交”清单含下属、接收人与联动子项。 */
  async function dutyCancelScene(label: string) {
    const x = await cancelWorld(database().db, label, TODAY);
    const subordinate = await employeeIn(x, x.to.id, '合成下属', x.employee.id);
    const receiver = await employeeIn(x, x.to.id, '合成接收人');
    await x.useTiming('approval_passed');
    const leave = await x.createdLeave(
      x.employee.id,
      leaveBody('2026-10-20', 'direct', {
        dutyTransfer: {
          subordinates: [{ employeeId: subordinate.id, receiverId: receiver.id, relation: 'direct' }],
          orgRoles: [],
        },
      }),
    );
    const { rights, request } = revocableOn(x, clock);
    // 同键重放必须同 If-Match 同内容，否则是 IDEMPOTENCY_CONFLICT：revision 只在首次前读一次。
    const revision = (await x.business(leave.id)).revision;
    const cancel = async (key: string) =>
      request('POST', `/exits/${leave.id}/cancel`, {
        ifMatch: revision,
        body: { reason: '合成撤销', confirmed: true },
        idempotencyKey: key,
      });
    return { x, leave, subordinate, receiver, rights, request, revision, cancel };
  }
  type Receipt = {
    downstream: {
      items: { kind: string; targets: { id: string }[]; hiddenCount: number }[];
      additional: { targets: { id: string }[]; hiddenCount: number }[];
    };
  };
  // 只看 items：additional 里的编制占用（establishment-capacity）按对象授权可见，不随员工范围裁剪
  const targetIds = (receipt: Receipt) => receipt.downstream.items.flatMap((entry) => entry.targets.map((t) => t.id));
  const duty = (receipt: Receipt) => receipt.downstream.items.find((item) => item.kind === 'duty_transfer')!;

  it('首次执行：命令内范围只保留离职员工 → 回执省略范围外下属 / 接收人 / 联动子项，hiddenCount 计入', async () => {
    const s = await dutyCancelScene(`f565r2-p12-cancel-${uniqueSuffix()}`);
    s.rights.scope = fromOnly(s.x, TODAY);
    const response = await s.cancel(randomUUID());
    expect(response.status, await textOf(response)).toBe(200);
    const receipt = (await response.json()) as Receipt;
    expect(targetIds(receipt), '回执泄露了范围外的下属 / 接收人 / 联动子项').toEqual([]);
    expect(duty(receipt).hiddenCount).toBeGreaterThan(0);
    expect(JSON.stringify(receipt.downstream)).not.toContain(s.subordinate.id);
    expect(JSON.stringify(receipt.downstream)).not.toContain(s.receiver.id);
  });

  it('同键重放：首次范围完整，重放时命令内范围已收窄 → 重放回执同样按收窄后的范围裁剪', async () => {
    const s = await dutyCancelScene(`f565r2-p12-cancel-replay-${uniqueSuffix()}`);
    const key = randomUUID();
    const first = await s.cancel(key);
    expect(first.status, await textOf(first)).toBe(200);
    const firstReceipt = (await first.json()) as Receipt;
    expect(targetIds(firstReceipt).length, '对照：完整范围的首次回执应带明细').toBeGreaterThan(0);
    s.rights.scope = fromOnly(s.x, TODAY);
    const replay = await s.cancel(key);
    expect(replay.status, await textOf(replay)).toBe(200);
    const replayed = (await replay.json()) as Receipt;
    expect(targetIds(replayed), '重放回执泄露了已收回范围的明细').toEqual([]);
    expect(duty(replayed).hiddenCount).toBeGreaterThan(0);
  });

  /** 同一张已转交职责的离职单，改到更晚的最后工作日：改期提示里的“职责转交”探针列出下属 / 接收人 / 联动子项。 */
  async function hintScene(label: string) {
    const s = await dutyCancelScene(label);
    const patch = async (key: string) =>
      s.request('PATCH', `/exits/${s.leave.id}`, {
        ifMatch: s.revision,
        body: { lastWorkDate: '2026-10-25' },
        idempotencyKey: key,
      });
    return { ...s, patch };
  }
  type Hints = { downstreamHints: { items: { kind: string; targets: { id: string }[]; hiddenCount: number }[] } };
  const hintIds = (body: Hints) =>
    body.downstreamHints.items.flatMap((item) => item.targets.map((target) => target.id));

  it('离职编辑首次执行：命令内范围只保留离职员工 → downstreamHints 不带范围外的下属 / 接收人 / 联动子项', async () => {
    const s = await hintScene(`f565r2-p12-edit-${uniqueSuffix()}`);
    const control = await hintScene(`f565r2-p12-edit-ok-${uniqueSuffix()}`);
    const full = await control.patch(randomUUID());
    expect(full.status, await textOf(full)).toBe(200);
    expect(hintIds((await full.json()) as Hints).length, '对照：完整范围应带职责转交明细').toBeGreaterThan(0);

    s.rights.scope = fromOnly(s.x, TODAY);
    const response = await s.patch(randomUUID());
    expect(response.status, await textOf(response)).toBe(200);
    const hints = (await response.json()) as Hints;
    expect(hintIds(hints), '编辑提示泄露了范围外的明细').toEqual([]);
    expect(hints.downstreamHints.items.find((item) => item.kind === 'duty_transfer')?.hiddenCount).toBeGreaterThan(0);
  });
});

// ───────────────────────── P2-1 公共预锁覆盖执行体参与人 ─────────────────────────

describe('F-565 R2 P2-1 离职 / 退休编辑：预锁闭包与执行体一致，合法请求不得 409', () => {
  const world = (label: string) => dutyExitWorld(database().db, `ZZ_F565R2_${label}_${uniqueSuffix()}`);
  const last = '2026-10-20';
  type World = Awaited<ReturnType<typeof world>>;
  const planOf = (x: World, subordinateId: string, receiverId: string) =>
    x.plan({ subordinates: [{ employeeId: subordinateId, receiverId }] });

  it('退休草稿首次添加合法下属（原来没有转交计划）→ 200，不报 TRANSFER_LOCK_PLAN_CHANGED', async () => {
    const x = await world('ret-add');
    const subordinate = await x.subordinateOf(x.employee.id, 'ZZ_F565R2_下属');
    const receiver = await x.peer('ZZ_F565R2_接收人');
    const draft = await x.createdRetire(x.employee.id, retireBody(last));
    const response = await x.patchExit(
      draft.id,
      draft.revision,
      { dutyTransfer: planOf(x, subordinate.id, receiver.id) },
      'retirement',
    );
    expect(response.status, await textOf(response)).toBe(200);
  });

  it('同时返聘的退休草稿首次添加合法下属 → 200', async () => {
    const x = withRehire(database().db, await world('rehire-add'));
    const subordinate = await x.subordinateOf(x.employee.id, 'ZZ_F565R2_返聘下属');
    const receiver = await x.peer('ZZ_F565R2_返聘接收人');
    const draft = await x.createdRehire(x.rehireBody(last, 'direct', x.rehirePlan()));
    const response = await x.patchExit(
      draft.id,
      draft.revision,
      { dutyTransfer: planOf(x, subordinate.id, receiver.id) },
      'retirement',
    );
    expect(response.status, await textOf(response)).toBe(200);
  });

  it('保留原口径：新增下属不存在 / 跨租户 → 仍是 400 TRANSFER_PERSON_NOT_ELIGIBLE，不是 409', async () => {
    const x = await world('ret-missing');
    const other = await world('ret-foreign');
    const receiver = await x.peer('ZZ_F565R2_校验接收人');
    const draft = await x.createdRetire(x.employee.id, retireBody(last));
    for (const missing of [randomUUID(), other.employee.id]) {
      const response = await x.patchExit(
        draft.id,
        draft.revision,
        { dutyTransfer: planOf(x, missing, receiver.id) },
        'retirement',
      );
      expect(await x.problem(response)).toMatchObject({
        status: 400,
        code: 'VALIDATION_FAILED',
        reason: 'TRANSFER_PERSON_NOT_ELIGIBLE',
      });
    }
  });

  it('F-140b2：已生效离职单留有失败职责，恢复接收人后改期 → 200（非 PG 路径同样不得 409）', async () => {
    const x = await downstreamWorld(database().db, `f565r2-f140b2-${uniqueSuffix()}`);
    await x.useTiming('approval_passed');
    const receiver = await x.peer('合成接收人');
    const sub = await x.subordinateOf(x.employee.id, '合成下属');
    const draft = await x.submittedLeave('2026-10-15');
    await x.planDuties(draft.id, [{ employeeId: sub.id, receiverId: receiver.id }]);
    const badLeave = await x.directLeave('2026-10-05', undefined, receiver.id);
    await x.runScheduler('2026-10-06T02:00:00Z');
    await x.approveInReview(draft.id);
    expect((await x.items(draft.id))[0]!.status).toBe('failed');
    await x.runScheduler('2026-10-16T02:00:00Z');
    x.setNow('2026-11-05T02:00:00Z');
    const cancelBad = await x.session.request('POST', `/exits/${badLeave.id}/cancel`, {
      ifMatch: (await x.business(badLeave.id)).revision,
      body: { reason: '合成恢复接收人' },
    });
    expect(cancelBad.status, await textOf(cancelBad)).toBe(200);
    const replacing = await x.session.request('PATCH', `/exits/${draft.id}`, {
      ifMatch: (await x.business(draft.id)).revision,
      body: { lastWorkDate: '2026-11-20' },
    });
    expect(replacing.status, await textOf(replacing)).toBe(200);
  });

  describe.runIf(pg)('PG16 屏障：新增下属的员工行被另一事务持有', () => {
    async function build(label: string) {
      const x = withRehire(database().db, await world(label));
      const subordinate = await x.subordinateOf(x.employee.id, 'ZZ_F565R2_屏障下属');
      const receiver = await x.peer('ZZ_F565R2_屏障接收人');
      const draft = await x.createdRehire(x.rehireBody(last, 'direct', x.rehirePlan()));
      const { rights, request } = revocableOn(x, () => new Date(`${TODAY}T01:00:00.000Z`));
      return {
        w: x,
        rights,
        hold: { table: 'employees', id: subordinate.id },
        extraTables: ['exit_requests', 'retirement_requests'],
        send: () =>
          request('PATCH', `/retirements/${draft.id}`, {
            ifMatch: draft.revision,
            body: { dutyTransfer: planOf(x, subordinate.id, receiver.id) },
          }),
      } satisfies Scenario;
    }
    it('等锁期间收回范围：请求必须排到新增下属的员工行锁上，放锁后 403 / 404，零写入', async () => {
      const s = await build('pg-add-revoke');
      const before = await state(s.w, s.extraTables);
      const r = await race(s, emptyRange);
      expect(refused(r.response.status), `应 403 / 404，实际 ${r.response.status}：${await textOf(r.response)}`).toBe(
        true,
      );
      expect(r.waited, '请求没有排到新增下属的员工行锁上（预锁闭包漏了请求新增的下属）').toBe(true);
      expect(await state(s.w, s.extraTables)).toEqual(before);
    });
    it('对照：不撤权 → 等完锁后 200', async () => {
      const s = await build('pg-add-ok');
      const r = await race(s, false);
      expect(r.response.status, await textOf(r.response)).toBe(200);
      expect(r.waited, '请求没有排到新增下属的员工行锁上').toBe(true);
    });
  });
});

// ───────────────────────── P2-2 执行体才会等的业务头 / 撤销记录行 ─────────────────────────

describe.runIf(pg)('F-565 R2 P2-2 其他业务头与撤销记录行在读授权之前取齐', () => {
  const clock = () => new Date('2026-11-05T02:00:00Z');

  it('已生效离职改期：另一张业务头被持有 → 排队，收回范围后 403 / 404 且零写入', async () => {
    const x = await downstreamWorld(database().db, `f565r2-p22-resched-${uniqueSuffix()}`);
    const leave = await x.directLeave('2026-10-15');
    const other = await x.transferIn('draft', '2026-10-20');
    await x.runScheduler('2026-10-16T02:00:00Z');
    x.setNow('2026-11-05T02:00:00Z');
    const { rights, request } = revocableOn(x, clock);
    const revision = (await x.business(leave.id)).revision;
    const s = {
      w: x,
      rights,
      hold: { table: 'heads', id: other.id },
      extraTables: ['exit_requests'],
      send: () => request('PATCH', `/exits/${leave.id}`, { ifMatch: revision, body: { lastWorkDate: '2026-10-25' } }),
    } satisfies Scenario;
    const before = await state(s.w, s.extraTables);
    const r = await race(s, emptyRange);
    expect(r.waited, '请求没有排到另一张业务头的行锁上').toBe(true);
    expect(refused(r.response.status), `应 403 / 404，实际 ${r.response.status}：${await textOf(r.response)}`).toBe(
      true,
    );
    expect(await state(s.w, s.extraTables)).toEqual(before);
  });

  it('对照：已生效离职改期不撤权 → 等完另一张业务头的锁后 200', async () => {
    const x = await downstreamWorld(database().db, `f565r2-p22-resched-ok-${uniqueSuffix()}`);
    const leave = await x.directLeave('2026-10-15');
    const other = await x.transferIn('draft', '2026-10-20');
    await x.runScheduler('2026-10-16T02:00:00Z');
    x.setNow('2026-11-05T02:00:00Z');
    const { rights, request } = revocableOn(x, clock);
    const revision = (await x.business(leave.id)).revision;
    const r = await race(
      {
        w: x,
        rights,
        hold: { table: 'heads', id: other.id },
        send: () => request('PATCH', `/exits/${leave.id}`, { ifMatch: revision, body: { lastWorkDate: '2026-10-25' } }),
      },
      false,
    );
    expect(r.waited, '请求没有排到另一张业务头的行锁上').toBe(true);
    expect(r.response.status, await textOf(r.response)).toBe(200);
  });

  /** 生效重试夹具：直接退休因顺延区间内有未落地调动而生效失败；删除阻塞调动后重试（阻塞调动的业务头仍在，是“另一张业务头”）。 */
  async function retryScene(label: string) {
    const x = await retirementWorld(database().db, label, TODAY);
    const retire = await x.directRetire('2026-10-15');
    const blocker = await x.transferIn('draft', '2026-10-17');
    expect(await x.runScheduler('2026-10-18T01:00:00Z')).toMatchObject({ failed: [retire.id] });
    x.setNow('2026-10-18T02:00:00Z');
    const removed = await x.session.request('DELETE', `/businesses/${blocker.id}`, { ifMatch: blocker.revision });
    expect(removed.status, await textOf(removed)).toBe(200);
    const { rights, request } = revocableOn(x, () => new Date('2026-10-18T03:00:00Z'));
    const revision = (await x.business(retire.id)).revision;
    return {
      w: x,
      rights,
      hold: { table: 'heads', id: blocker.id },
      extraTables: ['exit_requests', 'retirement_requests'],
      send: () => request('POST', `/businesses/${retire.id}/activation/retry`, { ifMatch: revision, body: {} }),
    } satisfies Scenario;
  }

  it('退休生效重试：另一张业务头被持有 → 排队，收回范围后 403 / 404 且零写入', async () => {
    const s = await retryScene(`f565r2-p22-retry-${uniqueSuffix()}`);
    const before = await state(s.w, s.extraTables);
    const r = await race(s, emptyRange);
    expect(r.waited, '请求没有排到另一张业务头的行锁上').toBe(true);
    expect(refused(r.response.status), `应 403 / 404，实际 ${r.response.status}：${await textOf(r.response)}`).toBe(
      true,
    );
    expect(await state(s.w, s.extraTables)).toEqual(before);
  });

  it('对照：退休生效重试不撤权 → 等完另一张业务头的锁后 200', async () => {
    const s = await retryScene(`f565r2-p22-retry-ok-${uniqueSuffix()}`);
    const r = await race(s, false);
    expect(r.waited, '请求没有排到另一张业务头的行锁上').toBe(true);
    expect(r.response.status, await textOf(r.response)).toBe(200);
  });

  /** 已撤销离职单的撤销记录：PATCH exits/cancellations/:id 改撤销原因（范围按所属员工）。 */
  async function cancellationScene(label: string) {
    const x = await cancelWorld(database().db, label, TODAY);
    const leave = await x.createdLeave(x.employee.id, leaveBody('2026-10-20', 'application'));
    const cancelled = await x.cancelled(leave.id, { reason: '录入有误' });
    const { rights, request } = revocableOn(x, () => new Date(`${TODAY}T01:00:00.000Z`));
    return {
      w: x,
      rights,
      hold: { table: 'cancellations', id: cancelled.cancellation.id },
      extraTables: ['exit_requests', 'exit_cancellations'],
      send: () =>
        request('PATCH', `/exits/cancellations/${cancelled.cancellation.id}`, {
          ifMatch: cancelled.cancellation.revision,
          body: { reason: '改写后的撤销原因' },
        }),
    } satisfies Scenario;
  }

  it('修改撤销原因：撤销记录行被持有 → 排队，按所属员工收回范围后 403 / 404 且零写入', async () => {
    const s = await cancellationScene(`f565r2-p22-cancellation-${uniqueSuffix()}`);
    const before = await state(s.w, s.extraTables);
    const r = await race(s, emptyRange);
    expect(r.waited, '请求没有排到撤销记录的行锁上').toBe(true);
    expect(refused(r.response.status), `应 403 / 404，实际 ${r.response.status}：${await textOf(r.response)}`).toBe(
      true,
    );
    expect(await state(s.w, s.extraTables)).toEqual(before);
  });

  it('对照：修改撤销原因不撤权 → 等完撤销记录行锁后 200', async () => {
    const s = await cancellationScene(`f565r2-p22-cancellation-ok-${uniqueSuffix()}`);
    const r = await race(s, false);
    expect(r.waited, '请求没有排到撤销记录的行锁上').toBe(true);
    expect(r.response.status, await textOf(r.response)).toBe(200);
  });
});
