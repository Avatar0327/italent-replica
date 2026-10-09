/** F-046 / DEC-304：真实 360 端口的时间契约与两个分数字段别名；AC-EXP-08 / 11。 */
import { sql, withTenant } from '@italent/db';
import { evaluateBatch, evaluateFormula, inMemorySubject, type Survey360Record } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadSurvey360Port } from '../../apps/api/src/modules/survey360/port.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { type QuestionnaireView, type World360, world360 } from './AC-360-support.js';

const testDb = useTestDb();
const ALL: ModuleScope = { ...EMPTY_SCOPE, all: true, hasDataPermission: true };
const only = (employeeId: string): ModuleScope => ({
  ...EMPTY_SCOPE,
  hasDataPermission: true,
  terms: [{ dimension: 'reporting', orgIds: [], personIds: [employeeId] }],
});

async function fixture() {
  const w = await world360(testDb().db, 'f046');
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
  const employeeId = await hire('被评价员工');
  const noDataId = await hire('未参加员工');
  const synced = await w.ok<{ created: { employeeId: string; personId: string }[] }>(
    w.request('POST', '/people/sync', { body: {} }),
  );
  const personId = synced.created.find((p) => p.employeeId === employeeId)!.personId;
  const weights = { self: 0, superior: 1, peer: 1 };
  const content = w.keyBehaviorContent(weights);
  const created = await w.keyBehavior(weights);
  const q = await w.enableQuestionnaire(
    await w.ok<QuestionnaireView>(
      w.request('PUT', `/questionnaires/${created.id}`, {
        ifMatch: created.revision,
        body: {
          content: {
            ...content,
            dimensions: [
              { key: 'd1', name: '价值观', weight: 50 },
              { key: 'd2', name: '担当', weight: 50 },
            ],
            questions: content.questions.map((question, i) => ({ ...question, dimensionKey: `d${i + 1}` })),
          },
        },
      }),
    ),
  );
  const raters = { superior: await w.person('上级评价者'), peer: await w.person('同事评价者') };
  const activities = [];
  for (const [i, picks] of [
    { superior: ['v5', 'v1'], peer: ['v1', 'v3'] },
    { superior: ['v1', 'v5'], peer: ['v3', 'v1'] },
  ].entries()) {
    const activity = await w.activity({ name: `端口活动${i + 1}` });
    const object = await w.object(activity.id, personId, [q.id]);
    const relations = [];
    for (const role of ['superior', 'peer'] as const)
      relations.push({ role, relation: await w.appraiser(activity.id, object.id, raters[role].id, role) });
    w.setNow(`2026-10-0${i + 1}T01:00:00Z`);
    await w.transition(activity.id, 'enable');
    for (const { role, relation } of relations)
      await w.ok(await w.answer(await w.token(activity.id, raters[role].id), relation.id, q, picks[role]));
    const endAt = `2026-10-0${i + 4}T01:00:00Z`;
    const reportGeneratedAt = `2026-10-0${i + 6}T01:00:00Z`;
    w.setNow(endAt);
    await w.transition(activity.id, 'disable');
    // 报告生成能力属 R3-T03 PR-B；按既有端口验收方式模拟报告生成。
    await withTenant(w.db, w.tenantId, (tx) =>
      tx.execute(sql`UPDATE survey360_objects SET report_generated_at = ${reportGeneratedAt}::timestamptz
        WHERE id = ${object.id}::uuid`),
    );
    activities.push({ id: activity.id, endAt, reportGeneratedAt });
  }
  return { w, employeeId, noDataId, activities };
}

const load = (w: World360, employeeIds: readonly string[], scope = ALL) =>
  withTenant(w.db, w.tenantId, (tx) => loadSurvey360Port(tx, { tenantId: w.tenantId, employeeIds, scope }));

const formulas = [
  ['Lastest360Cent(360结果.维度角色得分, 360结果.维度名称="价值观", 360结果.角色名称="上级")', 1],
  ['获取最近一次360总分(360结果.题目-他评总分, 360结果.题目名称="主动沟通")', 2],
] as const;

describe('F-046 / DEC-304：360 真实端口字段', () => {
  let s: Awaited<ReturnType<typeof fixture>>;
  let port: Awaited<ReturnType<typeof load>>;
  let records: readonly Survey360Record[];
  beforeAll(async () => {
    s = await fixture();
    port = await load(s.w, [s.employeeId, s.noDataId]);
    const result = port.records(s.employeeId);
    expect(result.ok).toBe(true);
    records = result.ok ? result.data : [];
    expect(records.length).toBeGreaterThan(0);
  });

  it('AC-EXP-08 / DEC-262②：每条聚合记录携带所属活动的结束、报告时间与 activityId', () => {
    expect(new Set(records.map((row) => row.activityId))).toEqual(new Set(s.activities.map((a) => a.id)));
    for (const row of records) {
      const activity = s.activities.find((a) => a.id === row.activityId)!;
      expect(row.endAt).toEqual(new Date(activity.endAt));
      expect(row.reportGeneratedAt).toEqual(new Date(activity.reportGeneratedAt));
    }
  });

  it('DEC-304：维度角色得分只在维度角色行取角色分，题目-他评总分兼容旧题目-他评分', () => {
    const latest = records.filter((row) => row.activityId === s.activities[1]!.id);
    const dimensionRole = latest.find((row) => row.fields.维度名称 === '价值观' && row.fields.角色名称 === '上级')!;
    expect(dimensionRole.fields.维度角色得分).toBe(1);
    expect(dimensionRole.fields.角色得分).toBe(1);
    const questionnaireRole = latest.find((row) => row.fields.维度名称 === null && row.fields.角色名称 === '上级')!;
    expect(questionnaireRole.fields.角色得分).toBe(3);
    const question = latest.find((row) => row.fields.题目名称 === '主动沟通' && row.fields.角色名称 === null)!;
    expect(question.fields['题目-他评总分']).toBe(2);
    const total = latest.find((row) => row.fields.维度名称 === null && row.fields.题目名称 === null)!;
    expect(total.fields['问卷-他评总分']).toBe(2.5);
    for (const { fields } of records) {
      expect(fields).toHaveProperty('维度角色得分');
      expect(fields).toHaveProperty('题目-他评总分');
      expect(fields.维度角色得分).toBe(fields.维度名称 !== null && fields.角色名称 !== null ? fields.角色得分 : null);
      expect(fields['题目-他评总分']).toBe(fields.题目名称 !== null ? fields['题目-他评分'] : null);
    }
  });

  it.each(formulas)('AC-EXP-08 / DEC-304：逐人和批量从真实端口求值 %s', (formula, value) => {
    const subject = inMemorySubject(s.employeeId, {});
    const context = {
      calendar: { today: '2026-10-31' as const, timeZone: 'Asia/Shanghai' },
      project: { endAt: new Date('2026-10-31T00:00:00Z') },
      ports: { survey360: port },
    };
    const expected = { ok: true, value: { kind: 'number', value } };
    expect(evaluateFormula(formula, { ...context, subject })).toEqual(expected);
    const batch = evaluateBatch([{ field: '盘点对象.得分', priority: 1, formula }], [subject], context);
    expect(batch.ok && batch.results[s.employeeId]!['盘点对象.得分']).toEqual(expected);
  });

  it('AC-EXP-08 / DEC-262②：项目结束时间按活动结束划界，保留边界内活动，即使报告生成更晚', () => {
    const formula = formulas[0][0];
    expect(
      evaluateFormula(formula, {
        subject: inMemorySubject(s.employeeId, {}),
        calendar: { today: '2026-10-31', timeZone: 'Asia/Shanghai' },
        project: { endAt: new Date(s.activities[0]!.endAt) },
        ports: { survey360: port },
      }),
    ).toEqual({ ok: true, value: { kind: 'number', value: 5 } });
  });

  it('AC-EXP-11 / DEC-262②：范围外、空范围、未预读与跨租户仍 forbidden；记录仅有匿名聚合字段', async () => {
    const scoped = await load(s.w, [s.employeeId, s.noDataId], only(s.noDataId));
    const empty = await load(s.w, [s.employeeId], EMPTY_SCOPE);
    const unrequested = await load(s.w, [s.noDataId]);
    const otherTenant = await world360(testDb().db, 'f046-other');
    const foreign = await load(otherTenant, [s.employeeId]);
    for (const denied of [scoped, empty, unrequested, foreign]) {
      expect(denied.records(s.employeeId)).toEqual({ ok: false, reason: 'forbidden' });
      const result = evaluateFormula(formulas[0][0], {
        subject: inMemorySubject(s.employeeId, {}),
        calendar: { today: '2026-10-31', timeZone: 'Asia/Shanghai' },
        ports: { survey360: denied },
      });
      expect(result).toMatchObject({ ok: false, failure: { code: 'DATA_FORBIDDEN' } });
      expect(JSON.stringify(result)).not.toContain('端口活动');
    }
    expect(scoped.records(s.noDataId)).toEqual({ ok: true, data: [] });
    expect(port.records(s.employeeId.toUpperCase())).toEqual(port.records(s.employeeId));
    expect(
      records.every((row) => Object.keys(row).sort().join(',') === 'activityId,endAt,fields,reportGeneratedAt,startAt'),
    ).toBe(true);
    const fields = [
      '活动名称',
      '套卷名称',
      '角色名称',
      '角色得分',
      '问卷-自评总分',
      '问卷-他评总分',
      '维度名称',
      '维度-自评分',
      '维度-他评分',
      '维度角色得分',
      '题目名称',
      '题目-自评分',
      '题目-他评分',
      '题目-他评总分',
    ];
    for (const row of records) expect(Object.keys(row.fields).sort()).toEqual(fields.toSorted());
  });
});
