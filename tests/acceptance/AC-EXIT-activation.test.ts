/**
 * R2-T03 B3-1 / AC-DM-12、13（主链）、26、27：离职生效主链（设计 §5.1 步骤 0a / 0 / 0b / 0c / 2 / 3 / 7 / 8），
 * 只经内部编排器入口 activateExit 验证（§18.1 五个关口保持关闭，公开入口仍不落地）。
 * 覆盖 B-01～B-05c、B-55d / B-56（0b）、B-63e、B-69、B-75（状态钩子）与 DEC-593 免审批直接生效来源。
 */
import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { exitPostEffectHooks } from '../../apps/api/src/modules/employment/exit-confirmation.js';
import {
  registerEmployeeStatusHooks,
  resetEmployeeStatusHooksForTest,
  type EmploymentRecordEvent,
} from '../../apps/api/src/modules/employment/status-hooks.js';
import { exitActivationWorld, type ExitActivationWorld } from './AC-EXIT-activation-support.js';
import { seedLegacyOrgDeactivation } from './AC-TRF-activation-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const world = (label: string, today = TODAY) => exitActivationWorld(database().db, label, today);

afterEach(() => resetEmployeeStatusHooksForTest());

/** 未落地的整体断言：时间轴、合同、审批、扩展行、效果台账与前后相等，载荷版本数不变，业务仍是 approved。 */
async function expectUnlanded(
  x: ExitActivationWorld,
  businessId: string,
  before: Awaited<ReturnType<typeof x.stateOf>>,
) {
  const after = await x.stateOf(x.employee.id);
  for (const key of ['timeline', 'contracts', 'instances', 'exits', 'effects', 'approvalLogs'] as const)
    expect(after[key], key).toEqual(before[key]);
  expect(await x.versions(businessId)).toHaveLength(1);
  expect(await x.stateOfBusiness(businessId)).toBe('approved');
}

describe('AC-DM-13 主链：直接离职与申请离职原子生效', () => {
  it('B-01 L = 昨天：不迟到，前一条止于 L，状态 8，台账含 confirmed 预减与 effective 修正行', async () => {
    const x = await world('b01');
    const leave = await x.directLeave('2026-10-05');
    expect(leave.status).toBe('approved');
    const result = await x.activate(leave.id, TODAY);
    expect(result).toMatchObject({ outcome: 'effective', lastWorkDate: '2026-10-05', effectiveDate: TODAY });
    expect((await x.timeline()).map((row) => [row.kind, row.start_date, row.valid])).toEqual([
      ['hire', '2026-09-01', '[2026-09-01,2026-10-06)'],
      ['leave', TODAY, '[2026-10-06,)'],
    ]);
    expect(await x.stateOfBusiness(leave.id)).toBe('effective');
    expect(
      (
        await x.sqlRows<{ s: number }>(
          sql`SELECT employee_status AS s FROM employment_records WHERE id=${leave.id}::uuid`,
        )
      )[0]!.s,
    ).toBe(8);
    const effects = await x.effects(leave.id);
    expect(effects.map((row) => [row.phase, row.kind])).toEqual([
      ['confirmed', 'establishment_pre_released'],
      ['effective', 'establishment_pre_released'],
    ]);
    expect(effects[1]!.detail).toMatchObject({ lastWorkDate: '2026-10-05', effectiveDate: TODAY, releasedFrom: TODAY });
    expect((await x.audits(leave.id, 'employment.exit.effective'))[0]!.after).toMatchObject({ source: 'direct' });
  });

  it('B-02 L ≥ 今天：到期前编排器 409 不落地；到期当天原子生效，到期前只有 confirmed 预减行', async () => {
    const x = await world('b02');
    const leave = await x.directLeave('2026-10-20');
    const before = await x.stateOf(x.employee.id);
    await expect(x.activate(leave.id, '2026-10-20')).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'EFFECTIVE_DATE_NOT_REACHED' },
    });
    expect(await x.stateOf(x.employee.id)).toEqual(before);
    expect((await x.effects(leave.id)).map((row) => row.phase)).toEqual(['confirmed']);
    expect(await x.activate(leave.id, '2026-10-21')).toMatchObject({
      outcome: 'effective',
      effectiveDate: '2026-10-21',
    });
    expect((await x.effects(leave.id)).map((row) => row.phase)).toEqual(['confirmed', 'effective']);
  });

  it('B-03 / B-04 申请离职：审批通过停在 approved；到期生效（B-03），审批当天 a = E 不算迟到（B-04）', async () => {
    const x = await world('b03');
    const later = await x.approvedLeave('2026-10-20', TODAY);
    expect(later.status).toBe('approved');
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire']);
    expect(await x.activate(later.id, '2026-10-21')).toMatchObject({
      outcome: 'effective',
      effectiveDate: '2026-10-21',
    });
    const same = await world('b04');
    const approved = await same.approvedLeave('2026-10-05', TODAY);
    const result = await same.activate(approved.id, TODAY, { trigger: 'approval' });
    expect(result).toMatchObject({ outcome: 'effective', lastWorkDate: '2026-10-05', effectiveDate: TODAY });
    expect(await same.versions(approved.id)).toHaveLength(1);
  });
});

describe('AC-DM-26 步骤 0：迟到判定与简单顺延', () => {
  it.each([
    ['B-05 调度延迟两天', '2026-10-15', '2026-10-18', '2026-10-17'],
    ['B-05a 跨月', '2026-10-30', '2026-11-02', '2026-11-01'],
  ])('%s：L′ = a − 1、E′ = a，追加系统修订版本，原人工日期保留，审计含原定两日期', async (_name, last, at, newLast) => {
    const x = await world(`late-${at}`);
    const leave = await x.directLeave(last);
    const result = await x.activate(leave.id, at);
    expect(result).toMatchObject({ outcome: 'effective', lastWorkDate: newLast, effectiveDate: at, postponed: true });
    const versions = await x.versions(leave.id);
    expect(versions.map((v) => [v.version_no, v.effective_date, v.last_work_date])).toEqual([
      [1, expect.any(String), last],
      [2, at, newLast],
    ]);
    // 计划日只读首版本（§5.0A）：顺延版本沿用，不随执行日变化
    expect(versions.map((v) => v.planned)).toEqual([versions[0]!.effective_date, versions[0]!.effective_date]);
    expect((await x.audits(leave.id, 'employment.leave.rescheduled'))[0]!.after).toMatchObject({
      reason: 'late-execution',
      originalLastWorkDate: last,
      originalEffectiveDate: versions[0]!.effective_date,
      lastWorkDate: newLast,
      effectiveDate: at,
    });
    expect((await x.timeline()).at(-1)).toMatchObject({ kind: 'leave', start_date: at });
  });

  it('B-05a 当天执行不顺延（a = E），无顺延审计', async () => {
    const x = await world('late-none');
    const leave = await x.directLeave('2026-10-15');
    expect(await x.activate(leave.id, '2026-10-16')).toMatchObject({ postponed: false, effectiveDate: '2026-10-16' });
    expect(await x.audits(leave.id, 'employment.leave.rescheduled')).toEqual([]);
  });
});

describe('AC-DM-26 B-05b / B-39 区间非空：fail-closed REBUILD_REQUIRED', () => {
  const cases = [
    ['① 已生效记录（B-39 已落地调动）', 'landed'],
    ['② 草稿', 'draft'],
    ['③ 审批中', 'in_review'],
    ['④ 已驳回', 'rejected'],
    ['⑤ 已批准未落地', 'approved'],
  ] as const;
  it.each(cases)('%s 在 [E, a) 内：不落地，记 failed，前后时间轴 / 版本 / 台账相等', async (_name, shape) => {
    const x = await world(`rebuild-${shape}`);
    const leave = await x.directLeave('2026-10-15');
    let blocker: string;
    if (shape === 'landed') {
      const created = await x.session.getEmployee(x.employee.id);
      blocker = (
        await x.session.business(
          x.employee.id,
          { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-17', fields: { departmentId: x.to.id } },
          created.revision,
        )
      ).id;
    } else {
      blocker = await x.synthetic(x.employee.id, { kind: 'transfer', state: shape, effectiveDate: '2026-10-17' });
    }
    const before = await x.stateOf(x.employee.id);
    const result = await x.activate(leave.id, '2026-10-18');
    expect(result).toMatchObject({ outcome: 'failed', reason: 'REBUILD_REQUIRED' });
    await expectUnlanded(x, leave.id, before);
    expect(await x.attempts(leave.id)).toMatchObject([{ outcome: 'failed', reason: 'REBUILD_REQUIRED' }]);
    const detail = (await x.attempts(leave.id))[0]!.detail as { blockers: { id: string; materialized: boolean }[] };
    expect(detail.blockers).toMatchObject([{ id: blocker, materialized: shape === 'landed' }]);
    expect((await x.audits(leave.id, 'employment.activation.failed')).length).toBe(1);
  });

  it('HR 删除阻塞的草稿后重试：简单顺延成功（DEC-278）', async () => {
    const x = await world('rebuild-retry');
    const leave = await x.directLeave('2026-10-15');
    const employee = await x.session.getEmployee(x.employee.id);
    const draft = await x.session.business(
      x.employee.id,
      { kind: 'transfer', mode: 'application', effectiveDate: '2026-10-17', fields: { departmentId: x.to.id } },
      employee.revision,
    );
    expect(await x.activate(leave.id, '2026-10-18')).toMatchObject({ outcome: 'failed', reason: 'REBUILD_REQUIRED' });
    x.setNow('2026-10-18T01:00:00Z');
    const removed = await x.session.request('DELETE', `/businesses/${draft.id}`, { ifMatch: draft.revision });
    expect(removed.status).toBe(200);
    expect(await x.activate(leave.id, '2026-10-18', { trigger: 'retry' })).toMatchObject({
      outcome: 'effective',
      effectiveDate: '2026-10-18',
      postponed: true,
    });
  });
});

describe('AC-DM-26 B-05c 区间边界（F-007 §2-2 位置规则）', () => {
  it('记录生效日 = a（右端不含）→ 简单顺延；记录在 E 之前 → 不计', async () => {
    const x = await world('edge-landed');
    const leave = await x.directLeave('2026-10-15');
    const employee = await x.session.getEmployee(x.employee.id);
    await x.session.business(
      x.employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-18', fields: { departmentId: x.to.id } },
      employee.revision,
    );
    expect(await x.activate(leave.id, '2026-10-18')).toMatchObject({ outcome: 'effective', postponed: true });
  });

  it('未落地申请计划日 = E：操作序号更早 = 排在离职之前，是前序（pending）而不是区间成员；更晚 → 区间成员，REBUILD_REQUIRED', async () => {
    for (const [name, eventSeq, outcome] of [
      ['earlier', 0, 'pending'],
      ['later', 900000, 'failed'],
    ] as const) {
      const x = await world(`edge-${name}`);
      const leave = await x.directLeave('2026-10-15');
      await x.synthetic(x.employee.id, { kind: 'transfer', state: 'approved', effectiveDate: '2026-10-16', eventSeq });
      expect((await x.activate(leave.id, '2026-10-18', { trigger: 'approval' })).outcome, name).toBe(outcome);
    }
  });
});

describe('AC-DM-25 / B-55d、B-56 步骤 0b：顺延后重验转正在途', () => {
  it('输入 L = 10-10、实际执行 10-16（L′ = 10-15），计划日 = E 的审批中实习转正 → failed 且离职不变', async () => {
    const x = await world('b55d');
    const leave = await x.directLeave('2026-10-10');
    await x.synthetic(x.employee.id, {
      kind: 'intern_regularization',
      state: 'in_review',
      effectiveDate: '2026-10-11',
      eventSeq: 0,
    });
    const before = await x.stateOf(x.employee.id);
    expect(await x.activate(leave.id, '2026-10-16')).toMatchObject({
      outcome: 'failed',
      reason: 'EXIT_REGULARIZATION_IN_FLIGHT',
    });
    await expectUnlanded(x, leave.id, before);
  });

  it('B-56 L′ = L（未顺延）时同一转正（计划日 > L）不触发 0b：离职照常落地', async () => {
    const x = await world('b56');
    const leave = await x.directLeave('2026-10-10');
    await x.synthetic(x.employee.id, {
      kind: 'intern_regularization',
      state: 'in_review',
      effectiveDate: '2026-10-11',
      eventSeq: 0,
    });
    expect(await x.activate(leave.id, '2026-10-11')).toMatchObject({ outcome: 'effective', postponed: false });
  });
});

describe('AC-DM-27 部门可用性：B-69 跳过、B-63e 步骤 0c', () => {
  it('B-69 生效日部门起停用：离职照常生效（不因部门停用失败）', async () => {
    const x = await world('b69');
    const leave = await x.directLeave('2026-10-20');
    await seedLegacyOrgDeactivation(x, '2026-10-21', x.from);
    expect(await x.activate(leave.id, '2026-10-21')).toMatchObject({ outcome: 'effective', postponed: false });
  });

  it('B-63e 顺延延长在职段跨过停用日：生效失败 EMPLOYMENT_DEPARTMENT_DISABLED，撤销停用后重试成功', async () => {
    const x = await world('b63e');
    const leave = await x.directLeave('2026-10-15');
    await seedLegacyOrgDeactivation(x, '2026-10-17', x.from);
    const before = await x.stateOf(x.employee.id);
    expect(await x.activate(leave.id, '2026-10-20')).toMatchObject({
      outcome: 'failed',
      reason: 'EMPLOYMENT_DEPARTMENT_DISABLED',
    });
    await expectUnlanded(x, leave.id, before);
    await seedLegacyOrgDeactivation(x, '2026-10-17', x.from, true);
    expect(await x.activate(leave.id, '2026-10-20', { trigger: 'retry' })).toMatchObject({
      outcome: 'effective',
      lastWorkDate: '2026-10-19',
    });
  });
});

describe('AC-DM-29 B-75 状态钩子与 DEC-593 免审批直接生效来源', () => {
  it('落地后 onRecordMaterialized 恰一次（effectiveDate = E′、状态 8），订阅方收到顺延后的日期', async () => {
    const x = await world('b75');
    const events: EmploymentRecordEvent[] = [];
    registerEmployeeStatusHooks('b31-capture', {
      onRecordMaterialized: async (_tx, _ctx, event) => void events.push(event),
    });
    const leave = await x.directLeave('2026-10-15');
    await x.activate(leave.id, '2026-10-18');
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'leave',
        effectiveDate: '2026-10-18',
        lastWorkDate: '2026-10-17',
        employeeStatus: 8,
      }),
    ]);
  });

  it('DEC-593 free_direct：离职类型 / 原因为空、次日生效，同一条生效链，来源写入审计与生效端口', async () => {
    const x = await world('dec593');
    const sources: string[] = [];
    exitPostEffectHooks.onEffective(async (_tx, _ctx, event) => void sources.push(event.source));
    const leave = await x.directLeave(TODAY);
    expect((await x.exitRow(leave.id))!.exit_type_code).toBeNull();
    expect(await x.activate(leave.id, '2026-10-07', { trigger: 'approval', source: 'free_direct' })).toMatchObject({
      outcome: 'effective',
      effectiveDate: '2026-10-07',
    });
    expect((await x.audits(leave.id, 'employment.exit.effective'))[0]!.after).toMatchObject({ source: 'free_direct' });
    expect(sources).toContain('free_direct');
  });
});
