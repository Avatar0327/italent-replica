/**
 * PR #107 第 1 轮审查（数据正确性类 P2-6～P2-8 与同时补齐项）的回归：
 * P2-6 导入 sync:true 对已挂接人员按组织刷新；P2-7 同步改上级推进 revision、写审计、计入 updated；
 * P2-8 Lastest360Cent 按 DEC-262 只取已结束且报告已生成的活动，按结束时间倒序、同值按报告生成时间；
 * 另：等级评定 HTTP 闭环且能区分加权求和与加权平均；忽略冲突后再同步不重复登记；同步分批游标。
 */
import { sql, withTenant } from '@italent/db';
import { evaluateFormula, inMemorySubject } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { loadSurvey360Port } from '../../apps/api/src/modules/survey360/port.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { overall, type PersonView, type QuestionnaireView, world360, type World360 } from './AC-360-support.js';

const testDb = useTestDb();
const ALL = { ...EMPTY_SCOPE, all: true, hasDataPermission: true };

interface SyncResult {
  created: { personId: string; employeeId: string }[];
  updated: { personId: string; employeeId: string }[];
  conflicts: string[];
  skipped: { employeeId: string; reason: string }[];
  nextCursor?: string | null;
}

async function hire(w: World360, name: string, orgId: string, managerId?: string) {
  const employee = await w.session.employee(name);
  await w.session.business(
    employee.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2025-01-01',
      fields: { departmentId: orgId, ...(managerId ? { directManagerId: managerId } : {}) },
    },
    employee.revision,
  );
  return employee;
}

const sync = (w: World360, body: Record<string, unknown> = {}) =>
  w.ok<SyncResult>(w.request('POST', '/people/sync', { body }));

async function rows<T>(w: World360, query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await withTenant(w.db, w.tenantId, (tx) => tx.execute(query));
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

describe('P2-6 导入评价者选择“同步”：已挂接人员按组织员工刷新', () => {
  it('360 端改过姓名与部门的已挂接人员，sync:true 导入后恢复为组织值', async () => {
    const w = await world360(testDb().db, 'r2f');
    const org = await w.session.org('组织部门', { establishedOn: '2025-01-01' });
    await hire(w, '组织姓名', org.id);
    const personId = (await sync(w)).created[0]!.personId;
    const before = await w.ok<PersonView>(w.request('GET', `/people/${personId}`));
    await w.ok(
      w.request('PUT', `/people/${personId}`, {
        ifMatch: before.revision,
        body: { name: '360改名', department: '360改部门' },
      }),
    );
    const q = await w.enableQuestionnaire(await w.keyBehavior({ self: 0, peer: 1 }));
    const activity = await w.activity();
    const target = await w.person('导入对象');
    await w.object(activity.id, target.id, [q.id]);
    await w.ok(
      w.request('POST', `/activities/${activity.id}/appraisers/import`, {
        ifMatch: 0,
        body: {
          sync: true,
          rows: [{ objectEmail: target.email, roleId: w.role('peer'), name: '上传姓名', email: before.email }],
        },
      }),
    );
    expect(await w.ok<PersonView>(w.request('GET', `/people/${personId}`))).toMatchObject({
      name: '组织姓名',
      department: org.name,
    });
  });
});

describe('P2-7 同步改变上级：推进 revision、写审计、计入 updated', () => {
  it('直线经理变化后再同步；用同步前的 revision 修改返回 409 且数据不变', async () => {
    const w = await world360(testDb().db, 'r2g');
    const org = await w.session.org('部门', { establishedOn: '2025-01-01' });
    const m1 = await hire(w, '经理一', org.id);
    const m2 = await hire(w, '经理二', org.id);
    const e = await hire(w, '员工', org.id, m1.id);
    const first = await sync(w);
    const personOf = (id: string) => first.created.find((c) => c.employeeId === id)!.personId;
    const before = await w.ok<PersonView>(w.request('GET', `/people/${personOf(e.id)}`));
    expect(before.superiorPersonId).toBe(personOf(m1.id));
    const audits = async () =>
      (
        await rows<{ n: number }>(
          w,
          sql`SELECT count(*)::int AS n FROM audit_events WHERE object_type = 'survey360-person'
            AND object_id = ${before.id}`,
        )
      )[0]!.n;
    const auditBefore = await audits();
    const current = await w.session.getEmployee(e.id);
    await w.session.business(
      e.id,
      { kind: 'org_adjustment', mode: 'direct', effectiveDate: '2026-09-01', fields: { directManagerId: m2.id } },
      current.revision,
    );
    const second = await sync(w);
    expect(second.updated.map((u) => u.personId)).toEqual([before.id]);
    const after = await w.ok<PersonView>(w.request('GET', `/people/${before.id}`));
    expect(after).toMatchObject({ superiorPersonId: personOf(m2.id), revision: before.revision + 1 });
    expect(await audits()).toBe(auditBefore + 1);
    const stale = await w.request('PUT', `/people/${before.id}`, {
      ifMatch: before.revision,
      body: { superiorPersonId: personOf(m1.id) },
    });
    expect(stale.status).toBe(409);
    expect(await w.ok<PersonView>(w.request('GET', `/people/${before.id}`))).toEqual(after);
  });
});

describe('P2-8 Lastest360Cent 按 DEC-262 取“最近一次”', () => {
  async function scored(w: World360, employeeId: string, personId: string, name: string, pick: string) {
    const q = await w.enableQuestionnaire(await w.keyBehavior({ self: 0, superior: 1 }));
    const activity = await w.activity({ name });
    const object = await w.object(activity.id, personId, [q.id]);
    const rater = await w.person(`${name}评价者`);
    const relation = await w.appraiser(activity.id, object.id, rater.id, 'superior');
    void employeeId;
    return { q, activity, object, rater, relation, pick };
  }
  const markReport = (w: World360, objectId: string, at: string) =>
    withTenant(w.db, w.tenantId, (tx) =>
      tx.execute(
        sql`UPDATE survey360_objects SET report_generated_at = ${at}::timestamptz WHERE id = ${objectId}::uuid`,
      ),
    );
  const evaluate = async (w: World360, employeeId: string) => {
    const port = await withTenant(w.db, w.tenantId, (tx) =>
      loadSurvey360Port(tx, { tenantId: w.tenantId, employeeIds: [employeeId], scope: ALL }),
    );
    const result = evaluateFormula('Lastest360Cent(360结果.问卷-他评总分)', {
      subject: inMemorySubject(employeeId, {}),
      calendar: { today: '2026-12-31', timeZone: 'Asia/Shanghai' },
      project: { endAt: new Date('2026-12-31T00:00:00Z') },
      ports: { survey360: port },
    });
    return { port, value: result.ok ? result.value : result };
  };

  it('A 10-01 开始、10-10 结束；B 10-03 开始、10-05 结束：取 A；未出报告、重新启用的活动不计', async () => {
    const w = await world360(testDb().db, 'r2h');
    const org = await w.session.org('部门', { establishedOn: '2025-01-01' });
    const e = await hire(w, '被评员工', org.id);
    const personId = (await sync(w)).created[0]!.personId;
    const a = await scored(w, e.id, personId, '活动A', 'v5');
    const b = await scored(w, e.id, personId, '活动B', 'v1');
    w.setNow('2026-10-01T01:00:00Z');
    await w.transition(a.activity.id, 'enable');
    w.setNow('2026-10-03T01:00:00Z');
    await w.transition(b.activity.id, 'enable');
    for (const x of [a, b])
      await w.answer(await w.token(x.activity.id, x.rater.id), x.relation.id, x.q, [x.pick, x.pick]);
    w.setNow('2026-10-05T01:00:00Z');
    await w.transition(b.activity.id, 'disable');
    w.setNow('2026-10-10T01:00:00Z');
    await w.transition(a.activity.id, 'disable');
    // 报告未生成：两个活动都不计
    expect((await evaluate(w, e.id)).port.records(e.id)).toEqual({ ok: true, data: [] });
    await markReport(w, a.object.id, '2026-10-11T00:00:00Z');
    await markReport(w, b.object.id, '2026-10-12T00:00:00Z');
    // 按结束时间倒序：A（10-10）晚于 B（10-05），取 A 的 5 分，不按开始时间取 B 的 1 分
    expect((await evaluate(w, e.id)).value).toEqual({ kind: 'number', value: 5 });
    // A 重新启用（进行中）：A 不计，取 B
    w.setNow('2026-10-13T01:00:00Z');
    await w.transition(a.activity.id, 'enable');
    expect((await evaluate(w, e.id)).value).toEqual({ kind: 'number', value: 1 });
    // A 再次停用但报告没有重新生成（报告早于本次结束）：仍不计
    w.setNow('2026-10-14T01:00:00Z');
    await w.transition(a.activity.id, 'disable');
    expect((await evaluate(w, e.id)).value).toEqual({ kind: 'number', value: 1 });
  });

  it('结束时间相同：按报告生成时间取较晚的一个', async () => {
    const w = await world360(testDb().db, 'r2i');
    const org = await w.session.org('部门', { establishedOn: '2025-01-01' });
    const e = await hire(w, '被评员工', org.id);
    const personId = (await sync(w)).created[0]!.personId;
    const a = await scored(w, e.id, personId, '活动A', 'v5');
    const b = await scored(w, e.id, personId, '活动B', 'v1');
    for (const x of [a, b]) {
      await w.transition(x.activity.id, 'enable');
      await w.answer(await w.token(x.activity.id, x.rater.id), x.relation.id, x.q, [x.pick, x.pick]);
      await w.transition(x.activity.id, 'disable');
    }
    await markReport(w, a.object.id, '2026-10-02T00:00:00Z');
    await markReport(w, b.object.id, '2026-10-03T00:00:00Z');
    expect((await evaluate(w, e.id)).value).toEqual({ kind: 'number', value: 1 });
    await markReport(w, a.object.id, '2026-10-04T00:00:00Z');
    expect((await evaluate(w, e.id)).value).toEqual({ kind: 'number', value: 5 });
  });
});

describe('等级评定 HTTP 闭环：加权求和与加权平均可区分', () => {
  it('同事只评基础指标一（限定角色），加权求和得 20×30% = 6，不是加权平均的 20', async () => {
    const w = await world360(testDb().db, 'r2j');
    const created = await w.ok<QuestionnaireView>(
      w.request('POST', '/questionnaires', {
        ifMatch: 0,
        body: { name: '等级评定套卷', type: 'rating', scoreMethod: 'weighted_sum' },
      }),
      201,
    );
    const q = await w.ok<QuestionnaireView>(
      w.request('PUT', `/questionnaires/${created.id}`, {
        ifMatch: created.revision,
        body: {
          content: {
            roles: [
              { key: 'self', roleId: w.role('self'), weight: 0 },
              { key: 'superior', roleId: w.role('superior'), weight: 1 },
              { key: 'peer', roleId: w.role('peer'), weight: 1 },
            ],
            scales: [
              {
                key: 'lv',
                name: '等级',
                options: [
                  { key: 'low', label: '一般', value: 10 },
                  { key: 'high', label: '优秀', value: 20 },
                ],
              },
            ],
            dimensions: [
              { key: 'c', name: '复合', weight: 100 },
              { key: 'b1', parentKey: 'c', name: '基础一', weight: 30, scaleKey: 'lv' },
              { key: 'b2', parentKey: 'c', name: '基础二', weight: 70, scaleKey: 'lv', roleIds: [w.role('superior')] },
            ],
            questions: [],
          },
        },
      }),
    );
    await w.enableQuestionnaire(q);
    const activity = await w.activity();
    const object = await w.object(activity.id, (await w.person('对象')).id, [q.id]);
    const boss = await w.person('上级');
    const peer = await w.person('同事');
    const bossRel = await w.appraiser(activity.id, object.id, boss.id, 'superior');
    const peerRel = await w.appraiser(activity.id, object.id, peer.id, 'peer');
    await w.transition(activity.id, 'enable');
    const dim = (key: string) => q.dimensions.find((d) => d.key === key)!.id;
    const opt = (key: string) => q.scales[0]!.options.find((o) => o.key === key)!.id;
    const submit = async (personId: string, relationId: string, answers: { itemId: string; optionId: string }[]) => {
      const call = w.link(await w.token(activity.id, personId));
      const detail = await w.ok<{ questionnaire: { items: { id: string }[] } }>(
        call('GET', `/tasks/${relationId}/questionnaires/${q.id}`),
      );
      expect(detail.questionnaire.items.map((i) => i.id).sort()).toEqual(answers.map((a) => a.itemId).sort());
      const saved = await w.ok<{ revision: number }>(
        call('PUT', `/tasks/${relationId}/questionnaires/${q.id}`, { ifMatch: 0, body: { answers } }),
      );
      await w.ok(call('POST', `/tasks/${relationId}/questionnaires/${q.id}/submit`, { ifMatch: saved.revision }));
    };
    await submit(boss.id, bossRel.id, [
      { itemId: dim('b1'), optionId: opt('high') },
      { itemId: dim('b2'), optionId: opt('low') },
    ]);
    await submit(peer.id, peerRel.id, [{ itemId: dim('b1'), optionId: opt('high') }]);
    await w.transition(activity.id, 'disable');
    const rows = await w.scores(activity.id, object.id);
    expect(overall(rows, 'role', w.role('superior'))).toBeCloseTo(13, 9);
    expect(overall(rows, 'role', w.role('peer'))).toBeCloseTo(6, 9);
    expect(overall(rows, 'other')).toBeCloseTo(9.5, 9);
  });
});

describe('同步：忽略的冲突不再重复登记；分批游标', () => {
  it('忽略冲突后再同步：不再产生冲突，跳过原因为 CONFLICT_IGNORED', async () => {
    const w = await world360(testDb().db, 'r2k');
    const org = await w.session.org('部门', { establishedOn: '2025-01-01' });
    const e = await hire(w, '员工', org.id);
    await w.person('同工号', { staffCode: e.code });
    const [conflictId] = (await sync(w)).conflicts;
    await w.ok(
      w.request('POST', `/people/sync-conflicts/${conflictId}/resolve`, { ifMatch: 1, body: { action: 'ignore' } }),
    );
    const again = await sync(w);
    expect(again.conflicts).toEqual([]);
    expect(again.skipped).toEqual([{ employeeId: e.id, reason: 'CONFLICT_IGNORED' }]);
    const count = await rows<{ n: number }>(w, sql`SELECT count(*)::int AS n FROM survey360_sync_conflicts`);
    expect(count[0]!.n).toBe(1);
  });

  it('分批同步：limit 截断后返回游标，按游标续同步，不漏不重', async () => {
    const w = await world360(testDb().db, 'r2l');
    const org = await w.session.org('部门', { establishedOn: '2025-01-01' });
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await hire(w, `员工${i}`, org.id)).id);
    const first = await sync(w, { limit: 2 });
    expect(first.created).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await sync(w, { limit: 2, after: first.nextCursor });
    expect(second.created).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect([...first.created, ...second.created].map((c) => c.employeeId).sort()).toEqual(ids.sort());
  });
});
