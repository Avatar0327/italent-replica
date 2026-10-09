/**
 * R3-T02 C1-3 当前资格与申报上一条资格（设计 §6.2 (3)(4)，拆分方案 C1-3；DEC-335①，规格 23 §13）：
 * - currentQualification：每人的任职资格是一条不分类型、不重叠、无断档的单一时间轴，自动同步与手工混排；当前资格 =
 *   覆盖 asOf（开始日 ≤ asOf 且结束日为空或 ≥ asOf）、开始日最晚的那一条；记录都已结束的人没有当前资格；
 * - priorQualificationForApply：先取子集（同一时间轴，不分来源、不分活动类型，选项 c），取不到再回退评定记录
 *   （回退分支由 C2-8 登记，本 PR 先建接口与子集分支）。
 */
import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { currentWorld } from './AC-QL-current-support.js';
import {
  currentQualification,
  priorQualificationForApply,
  registerEvaluationPriorProvider,
} from '../../apps/api/src/modules/qualification/current.js';

const database = useTestDb();

describe('AC-QL-current 当前资格：单一时间轴（DEC-335①）', () => {
  it('无断档两段：asOf 落在哪段取哪段；起止日边界都包含', async () => {
    const { w, tx, employee, record, category, otherCategory, p1, p2 } = await currentWorld(database, 'qc-axis');
    const id = await employee();
    const first = await record(id, { startDate: '2025-01-01', endDate: '2025-12-31' });
    const second = await record(id, {
      categoryId: otherCategory.id,
      levelId: p2.id,
      startDate: '2026-01-01',
    });
    const at = (asOf: string) => tx((t) => currentQualification(t, w.tenant.id, id, asOf));
    expect(await at('2025-06-01')).toMatchObject({ recordId: first.id, categoryId: category.id, levelId: p1.id });
    expect(await at('2025-01-01')).toMatchObject({ recordId: first.id });
    expect(await at('2025-12-31')).toMatchObject({ recordId: first.id });
    expect(await at('2026-01-01')).toMatchObject({ recordId: second.id, categoryId: otherCategory.id });
    expect(await at('2030-01-01')).toMatchObject({ recordId: second.id });
    expect(await at('2024-12-31')).toBeNull();
  });

  it('记录都已结束 → 没有当前资格；未来才开始的记录不算当前', async () => {
    const { w, tx, employee, record } = await currentWorld(database, 'qc-ended');
    const ended = await employee();
    await record(ended, { startDate: '2025-01-01', endDate: '2025-06-30' });
    expect(await tx((t) => currentQualification(t, w.tenant.id, ended, '2026-01-01'))).toBeNull();
    const future = await employee();
    await record(future, { startDate: '2027-01-01' });
    expect(await tx((t) => currentQualification(t, w.tenant.id, future, '2026-06-01'))).toBeNull();
  });

  it('自动同步与手工记录混排在同一条时间轴上，不看来源', async () => {
    const { w, tx, employee, record, systemRecord } = await currentWorld(database, 'qc-mixed');
    const id = await employee();
    const auto = await systemRecord(id, 'employment_sync', {
      isAutoSync: true,
      startDate: '2025-01-01',
      endDate: '2025-04-30',
    });
    const manual = await record(id, { startDate: '2025-05-01' });
    const at = (asOf: string) => tx((t) => currentQualification(t, w.tenant.id, id, asOf));
    expect(await at('2025-03-01')).toMatchObject({ recordId: auto.id, isAutoSync: true });
    expect(await at('2025-06-01')).toMatchObject({ recordId: manual.id, isAutoSync: false });
  });

  it('不分类型：跨类别的记录按日期排，不按类别分组', async () => {
    const { w, tx, employee, record, otherCategory, p3 } = await currentWorld(database, 'qc-types');
    const id = await employee();
    await record(id, { startDate: '2025-01-01', endDate: '2025-12-31' });
    const later = await record(id, { categoryId: otherCategory.id, levelId: p3.id, startDate: '2026-01-01' });
    expect(await tx((t) => currentQualification(t, w.tenant.id, id, '2026-03-01'))).toMatchObject({
      recordId: later.id,
      categoryId: otherCategory.id,
      levelId: p3.id,
    });
  });

  it('数据有重叠时取开始日最晚的一条；开始日相同取后建的（每人最多一条）', async () => {
    const { w, tx, employee, record, p2 } = await currentWorld(database, 'qc-overlap');
    const id = await employee();
    await record(id, { startDate: '2025-01-01' });
    const later = await record(id, { levelId: p2.id, startDate: '2025-06-01' });
    expect(await tx((t) => currentQualification(t, w.tenant.id, id, '2026-01-01'))).toMatchObject({
      recordId: later.id,
    });
    const tie = await employee();
    await record(tie, { startDate: '2025-06-01' });
    const newer = await record(tie, { levelId: p2.id, startDate: '2025-06-01' });
    expect(await tx((t) => currentQualification(t, w.tenant.id, tie, '2026-01-01'))).toMatchObject({
      recordId: newer.id,
    });
  });

  it('删除的记录不参与；他人与其他租户的记录不串', async () => {
    const { w, tx, employee, record, remove } = await currentWorld(database, 'qc-isolation');
    const id = await employee();
    const other = await employee();
    const gone = await record(id, { startDate: '2025-01-01' });
    await record(other, { startDate: '2025-01-01' });
    await remove(id, gone);
    expect(await tx((t) => currentQualification(t, w.tenant.id, id, '2026-01-01'))).toBeNull();
    // 其他租户的租户 ID 查不到本租户员工的记录
    const foreign = await currentWorld(database, 'qc-isolation-b');
    expect(await foreign.tx((t) => currentQualification(t, foreign.w.tenant.id, other, '2026-01-01'))).toBeNull();
  });

  it('asOf 必须是 YYYY-MM-DD 的合法日期，否则抛错而不是静默放宽', async () => {
    const { w, tx, employee } = await currentWorld(database, 'qc-asof');
    const id = await employee();
    for (const bad of ['2026-13-01', '2026-02-30', '2026/01/01', '', 'now']) {
      await expect(
        tx((t) => currentQualification(t, w.tenant.id, id, bad)),
        bad,
      ).rejects.toThrow();
    }
  });
});

describe('AC-QL-current 申报专用的上一条资格（设计 §6.2 (4)，选项 c 🟡）', () => {
  it('子集分支：取申报时点的当前资格，不分来源、不分活动类型；手工行 lastResult 为空，评定写入的行带结果', async () => {
    const { w, tx, employee, record, systemRecord, category, p1, p2 } = await currentWorld(database, 'qp-subset');
    const id = await employee();
    await record(id, { startDate: '2025-01-01', endDate: '2025-12-31' });
    const prior = (activity = randomUUID(), asOf = '2025-06-01') =>
      tx((t) => priorQualificationForApply(t, w.tenant.id, id, activity, asOf));
    expect(await prior()).toEqual({
      categoryId: category.id,
      levelId: p1.id,
      lastResult: null,
      obtainedDate: '2025-01-01',
      source: 'subset',
    });
    await systemRecord(id, 'evaluation', {
      levelId: p2.id,
      startDate: '2026-01-01',
      evaluationId: randomUUID(),
      result: '通过',
      finalScore: 88.5,
    });
    const first = randomUUID();
    const second = randomUUID();
    const a = await prior(first, '2026-06-01');
    const b = await prior(second, '2026-06-01');
    expect(a).toEqual({
      categoryId: category.id,
      levelId: p2.id,
      lastResult: '通过',
      obtainedDate: '2026-01-01',
      source: 'subset',
    });
    expect(b).toEqual(a);
  });

  it('子集取不到：没有登记评定回退时为 null；登记后回退到评定记录（C2-8 接入），子集有记录时不调用回退', async () => {
    const { w, tx, employee, record, category, p1, p3 } = await currentWorld(database, 'qp-fallback');
    const none = await employee();
    const activity = randomUUID();
    expect(await tx((t) => priorQualificationForApply(t, w.tenant.id, none, activity, '2026-06-01'))).toBeNull();

    const calls: unknown[][] = [];
    const dispose = registerEvaluationPriorProvider(async (_tx, tenantId, employeeId, activityTypeId, asOf) => {
      calls.push([tenantId, employeeId, activityTypeId, asOf]);
      return {
        categoryId: category.id,
        levelId: p3.id,
        lastResult: '未通过',
        obtainedDate: '2024-05-01',
        source: 'evaluation',
      };
    });
    try {
      expect(await tx((t) => priorQualificationForApply(t, w.tenant.id, none, activity, '2026-06-01'))).toEqual({
        categoryId: category.id,
        levelId: p3.id,
        lastResult: '未通过',
        obtainedDate: '2024-05-01',
        source: 'evaluation',
      });
      expect(calls).toEqual([[w.tenant.id, none, activity, '2026-06-01']]);

      const has = await employee();
      await record(has, { startDate: '2025-01-01' });
      const result = await tx((t) => priorQualificationForApply(t, w.tenant.id, has, activity, '2026-06-01'));
      expect(result).toMatchObject({ source: 'subset', levelId: p1.id });
      expect(calls).toHaveLength(1);
    } finally {
      dispose();
    }
    expect(await tx((t) => priorQualificationForApply(t, w.tenant.id, none, activity, '2026-06-01'))).toBeNull();
  });

  it('回退登记只能有一份（同 P0 登记表规则），重复登记抛错', async () => {
    const dispose = registerEvaluationPriorProvider(async () => null);
    try {
      expect(() => registerEvaluationPriorProvider(async () => null)).toThrow();
    } finally {
      dispose();
    }
  });

  it('端口只读：不写任何表', async () => {
    const { w, tx, employee, record, count } = await currentWorld(database, 'qp-readonly');
    const id = await employee();
    await record(id);
    const counts = () =>
      count(sql`SELECT (SELECT count(*) FROM personnel_qualification)
        + (SELECT count(*) FROM personnel_qualification_versions)
        + (SELECT count(*) FROM audit_events) AS n`);
    const before = await counts();
    await tx((t) => currentQualification(t, w.tenant.id, id, '2026-06-01'));
    await tx((t) => priorQualificationForApply(t, w.tenant.id, id, randomUUID(), '2026-06-01'));
    expect(await counts()).toBe(before);
  });
});
