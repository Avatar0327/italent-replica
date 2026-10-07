/**
 * R3-T00 Lastest360Cent 端口的真实数据源（REQ-EXP-001 第 4 条；`26` §3.5 TR-R28）：
 * - 按员工挂接的 360 人员取已计分活动的聚合分（问卷他评 / 自评总分、角色得分、维度与题目分）；
 * - 按查看人的数据范围裁剪：范围外的员工返回 forbidden；记录里没有任何评价者标识；
 * - 未计分（未停用）的活动不返回；DEC-262 的结束 / 报告资格与排序见 AC-360-R2-data.test.ts。
 */
import { sql, withTenant } from '@italent/db';
import { evaluateFormula, inMemorySubject } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { loadSurvey360Port } from '../../apps/api/src/modules/survey360/port.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { type World360, world360 } from './AC-360-support.js';

const testDb = useTestDb();
const ALL: ModuleScope = { ...EMPTY_SCOPE, all: true, hasDataPermission: true };
const only = (employeeId: string): ModuleScope => ({
  ...EMPTY_SCOPE,
  hasDataPermission: true,
  terms: [{ dimension: 'reporting', orgIds: [], personIds: [employeeId] }],
});

async function scored(w: World360) {
  const org = await w.session.org('端口部门', { establishedOn: '2025-01-01' });
  const hire = async (name: string) => {
    const employee = await w.session.employee(name);
    await w.session.business(
      employee.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2025-01-01', fields: { departmentId: org.id } },
      employee.revision,
    );
    return employee.id;
  };
  const E = await hire('被评价员工');
  const F = await hire('另一员工');
  const sync = await w.ok<{ created: { personId: string; employeeId: string }[] }>(
    w.request('POST', '/people/sync', { body: {} }),
  );
  const personOf = (id: string) => sync.created.find((c) => c.employeeId === id)!.personId;
  const q = await w.enableQuestionnaire(await w.keyBehavior());
  const activity = await w.activity({ name: '年度360' });
  const object = await w.object(activity.id, personOf(E), [q.id]);
  const raters = [
    { role: 'superior', picks: ['v3.5', 'v3.5'] },
    { role: 'peer', picks: ['v4', 'v4'] },
    { role: 'subordinate', picks: ['v4.3', 'v4.3'] },
    { role: 'self', picks: ['v5', 'v4'] },
  ] as const;
  const relations = [];
  for (const [i, rater] of raters.entries()) {
    const person = rater.role === 'self' ? { id: personOf(E) } : await w.person(`评价者${i}`);
    relations.push({ person, relation: await w.appraiser(activity.id, object.id, person.id, rater.role), rater });
  }
  await w.transition(activity.id, 'enable');
  for (const { person, relation, rater } of relations)
    await w.answer(await w.token(activity.id, person.id), relation.id, q, rater.picks);
  return { E, F, q, activity, object };
}

/** DEC-262 只取报告已生成的活动；报告生成属 PR-B，这里直接写报告生成时间模拟。 */
async function reported(w: World360, objectId: string) {
  await withTenant(w.db, w.tenantId, (tx) =>
    tx.execute(
      sql`UPDATE survey360_objects SET report_generated_at = '2026-10-02T00:00:00Z' WHERE id = ${objectId}::uuid`,
    ),
  );
}

function evaluate(formula: string, port: Awaited<ReturnType<typeof loadSurvey360Port>>, subjectId: string) {
  return evaluateFormula(formula, {
    subject: inMemorySubject(subjectId, {}),
    calendar: { today: '2026-12-31', timeZone: 'Asia/Shanghai' },
    project: { endAt: new Date('2026-12-31T00:00:00Z') },
    ports: { survey360: port },
  });
}

describe('Lastest360Cent 数据源', () => {
  it('取最近一次已计分活动的问卷他评 / 自评总分与角色得分', async () => {
    const w = await world360(testDb().db, 'p1');
    const s = await scored(w);
    const before = await withTenant(w.db, w.tenantId, (tx) =>
      loadSurvey360Port(tx, { tenantId: w.tenantId, employeeIds: [s.E], scope: ALL }),
    );
    // 活动未停用（未计分）时没有记录
    expect(before.records(s.E)).toEqual({ ok: true, data: [] });
    await w.transition(s.activity.id, 'disable');
    await reported(w, s.object.id);
    const port = await withTenant(w.db, w.tenantId, (tx) =>
      loadSurvey360Port(tx, { tenantId: w.tenantId, employeeIds: [s.E, s.F], scope: ALL }),
    );
    const name = s.q.name;
    const other = evaluate(`Lastest360Cent(360结果.问卷-他评总分, 360结果.套卷名称="${name}")`, port, s.E);
    expect(other.ok && other.value.kind === 'number' ? Number(other.value.value.toFixed(2)) : other).toBe(3.81);
    const self = evaluate(`获取最近一次360总分(360结果.问卷-自评总分, 360结果.活动名称="年度360")`, port, s.E);
    expect(self).toEqual({ ok: true, value: { kind: 'number', value: 4.5 } });
    const boss = evaluate(
      `Lastest360Cent(360结果.角色得分, 360结果.套卷名称="${name}", 360结果.角色名称="上级")`,
      port,
      s.E,
    );
    expect(boss).toEqual({ ok: true, value: { kind: 'number', value: 3.5 } });
    const question = evaluate(`Lastest360Cent(360结果.题目-他评分, 360结果.题目名称="主动沟通")`, port, s.E);
    expect(question.ok && question.value.kind === 'number' ? Number(question.value.value.toFixed(2)) : question).toBe(
      3.81,
    );
    // 没参加 360 的员工：空值（语义以 semantics.ts 为准，本任务不改）
    expect(evaluate(`Lastest360Cent(360结果.问卷-他评总分)`, port, s.F)).toEqual({
      ok: true,
      value: { kind: 'empty' },
    });
  });

  it('记录只有聚合分，没有评价者标识', async () => {
    const w = await world360(testDb().db, 'p2');
    const s = await scored(w);
    await w.transition(s.activity.id, 'disable');
    await reported(w, s.object.id);
    const port = await withTenant(w.db, w.tenantId, (tx) =>
      loadSurvey360Port(tx, { tenantId: w.tenantId, employeeIds: [s.E], scope: ALL }),
    );
    const result = port.records(s.E);
    expect(result.ok).toBe(true);
    const rows = result.ok ? result.data : [];
    expect(rows.length).toBeGreaterThan(0);
    const allowed = new Set([
      '活动名称',
      '套卷名称',
      '角色名称',
      '角色得分',
      '问卷-自评总分',
      '问卷-他评总分',
      '维度名称',
      '维度-自评分',
      '维度-他评分',
      '题目名称',
      '题目-自评分',
      '题目-他评分',
    ]);
    for (const row of rows) for (const key of Object.keys(row.fields)) expect(allowed.has(key), key).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('评价者');
  });

  it('按查看人范围裁剪：范围外员工 forbidden，空范围全部 forbidden', async () => {
    const w = await world360(testDb().db, 'p3');
    const s = await scored(w);
    await w.transition(s.activity.id, 'disable');
    await reported(w, s.object.id);
    const scopedToF = await withTenant(w.db, w.tenantId, (tx) =>
      loadSurvey360Port(tx, { tenantId: w.tenantId, employeeIds: [s.E, s.F], scope: only(s.F) }),
    );
    expect(scopedToF.records(s.E)).toEqual({ ok: false, reason: 'forbidden' });
    expect(scopedToF.records(s.F)).toEqual({ ok: true, data: [] });
    const failure = evaluate(`Lastest360Cent(360结果.问卷-他评总分)`, scopedToF, s.E);
    expect(failure.ok).toBe(false);
    expect(JSON.stringify(failure)).not.toContain('3.8');
    const empty = await withTenant(w.db, w.tenantId, (tx) =>
      loadSurvey360Port(tx, { tenantId: w.tenantId, employeeIds: [s.E], scope: EMPTY_SCOPE }),
    );
    expect(empty.records(s.E)).toEqual({ ok: false, reason: 'forbidden' });
    const scopedToE = await withTenant(w.db, w.tenantId, (tx) =>
      loadSurvey360Port(tx, { tenantId: w.tenantId, employeeIds: [s.E], scope: only(s.E) }),
    );
    expect(scopedToE.records(s.E).ok).toBe(true);
    // 没有预读的员工同样 forbidden（不回落为“无数据”）
    expect(scopedToE.records(s.F)).toEqual({ ok: false, reason: 'forbidden' });
  });
});
