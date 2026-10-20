/**
 * R2 BE-5c2（R2-T04 §9.2，AC-RT-17、AC-RT-02、AC-RT-21 批处理部分、AC-RT-23 批处理部分）：
 * 预计退休日期 / 弹性范围的每日批次——
 * - 同一业务日只完成一次；对应开关关闭的日子不建行；本地 03:00 之前不跑；
 * - 租约过期后从 position_employee_id 续跑，已处理员工零写入；
 * - 锁忙员工记入跳过清单，第二遍重试：锁已释放 → 写入并删除跳过行；仍忙 → given_up 并计入 skipped_count；
 *   位置提交后崩溃、第二遍中途崩溃，接管者都能续上；
 * - 预计退休日期已核准不写 P（AC-RT-02）；弹性范围已核准只冻结上下限，P 为空时清空（A-20，AC-RT-21）；
 * - P 重算后移出已核准旧范围的顺序与版本号（AC-RT-23）；审计 actor = 系统，reason = retirement_rule 并带规则 ID。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as locks from '../../apps/api/src/modules/employment/transfer-locks.js';
import {
  RETIREMENT_BATCH_LIMITS,
  runRetirementBatches,
  type RetirementPurposeRun,
} from '../../apps/api/src/modules/employment/retirement-scheduler.js';
import { batchWorld, clockAt, type BatchWorld, type Purpose } from './AC-RT-batch-support.js';

const testDb = useTestDb();
const DAY = '2026-10-01';
const original = RETIREMENT_BATCH_LIMITS.page;

afterEach(() => {
  vi.restoreAllMocks();
  RETIREMENT_BATCH_LIMITS.page = original;
});

async function runAt(w: BatchWorld, clock: Date) {
  const result = await runRetirementBatches(
    w.db,
    { actorUserId: null, commandId: `rt-batch-${randomUUID()}` },
    { tenantId: w.tenantId },
    { clock: () => clock },
  );
  const run = result.runs[0]!;
  const of = (purpose: Purpose): RetirementPurposeRun => run.purposes.find((item) => item.purpose === purpose)!;
  return { of, run };
}

/** 夹具：出生日期 1975-06-10 的男性，固定年龄 60 → P = 2035-06-30。 */
const NEW_P = '2035-06-30';

describe('AC-RT-17 每日批次', () => {
  it('同一业务日只完成一次；写入 P 并登记 done；再次调度不重复写', async () => {
    const w = await batchWorld(testDb().db, 'rt17-once');
    const employee = await w.member('批次员工');
    await w.fixedAgeRule(60);
    await w.setSwitch('expected_date', true);
    const before = await w.personOf(employee);

    const first = await runAt(w, clockAt(DAY));
    expect(first.of('expected_date')).toMatchObject({ ran: true, aborted: false });
    expect(first.of('expected_date').updated.map((item) => item.employeeId)).toEqual([employee]);
    expect(await w.personOf(employee)).toMatchObject({ expected: NEW_P, revision: before.revision + 1 });
    expect(await w.runRow('expected_date', DAY)).toMatchObject({ state: 'done', attempts: 1, skipped: 0 });

    const second = await runAt(w, clockAt(DAY, '08:00:00'));
    expect(second.of('expected_date').ran).toBe(false);
    expect((await w.personOf(employee)).revision).toBe(before.revision + 1);
  });

  it('开关关闭的日子不建行；只开一个开关只建该用途的行；本地 03:00 之前不跑', async () => {
    const w = await batchWorld(testDb().db, 'rt17-switch');
    await w.member('开关员工');
    await w.fixedAgeRule(60);

    await runAt(w, clockAt(DAY));
    expect(await w.runCount()).toBe(0);

    await w.setSwitch('flexible_range', true);
    await runAt(w, clockAt(DAY));
    expect(await w.runRow('flexible_range', DAY)).toMatchObject({ state: 'done' });
    expect(await w.runRow('expected_date', DAY)).toBeUndefined();

    await w.setSwitch('expected_date', true);
    // 前一日 18:30Z = 本地 02:30（次日），未到 03:00
    const early = await runAt(w, clockAt('2026-10-01', '18:30:00'));
    expect(early.of('expected_date').ran).toBe(false);
    expect(await w.runRow('expected_date', '2026-10-02')).toBeUndefined();
    const late = await runAt(w, clockAt('2026-10-01', '19:30:00'));
    expect(late.of('expected_date').ran).toBe(true);
    expect(await w.runRow('expected_date', '2026-10-02')).toMatchObject({ state: 'done' });
  });

  it('租约过期后从 position_employee_id 续跑：已处理员工零写入，接管登记 attempts + 1', async () => {
    const w = await batchWorld(testDb().db, 'rt17-lease');
    const ids = [];
    for (let i = 0; i < 5; i += 1) ids.push(await w.member(`续跑员工${i}`));
    ids.sort();
    await w.fixedAgeRule(60);
    await w.setSwitch('expected_date', true);
    RETIREMENT_BATCH_LIMITS.page = 2;
    const revisions = new Map<string, number>();
    for (const id of ids) revisions.set(id, (await w.personOf(id)).revision);

    // 第 3 名员工（第 2 页第 1 个）取锁时存储出错：第 1 页（前 2 人）位置已提交，进程“退出”，行仍 running
    const lock = locks.lockTransferParticipants;
    vi.spyOn(locks, 'lockTransferParticipants').mockImplementation(async (tx, ctx, employeeId, ...rest) => {
      if (employeeId === ids[2]) throw new Error('storage down');
      return lock(tx, ctx, employeeId, ...rest);
    });
    const crashed = await runAt(w, clockAt(DAY));
    expect(crashed.of('expected_date')).toMatchObject({ ran: true, aborted: true });
    expect(await w.runRow('expected_date', DAY)).toMatchObject({ state: 'running', position: ids[1], attempts: 1 });
    for (const id of ids.slice(0, 2)) expect((await w.personOf(id)).revision).toBe(revisions.get(id)! + 1);
    for (const id of ids.slice(2)) expect((await w.personOf(id)).revision).toBe(revisions.get(id));
    vi.restoreAllMocks();

    // 租约未过期：不能接管
    const held = await runAt(w, clockAt(DAY, '02:05:00'));
    expect(held.of('expected_date').ran).toBe(false);

    // 租约（10 分钟）过期后接管：从 ids[1] 之后续跑，前两人零写入
    const resumed = await runAt(w, clockAt(DAY, '02:11:00'));
    expect(resumed.of('expected_date')).toMatchObject({ ran: true, aborted: false });
    expect(resumed.of('expected_date').updated.map((item) => item.employeeId)).toEqual(ids.slice(2));
    expect(await w.runRow('expected_date', DAY)).toMatchObject({ state: 'done', attempts: 2 });
    for (const id of ids) expect((await w.personOf(id)).revision).toBe(revisions.get(id)! + 1);
  });

  // 位置提交后崩溃：第 1 页跳过 e0（锁忙），位置提交到 e1，e2 取锁时进程退出；接管者续跑 e1 之后，再从跳过清单读到 e0
  it.each([
    ['锁已释放', false, 'done'],
    ['锁仍被持有', true, 'given_up'],
  ] as const)('位置提交后、第二遍前崩溃：接管者读到跳过清单重试（%s）', async (_label, stillBusy, expected) => {
    const w = await batchWorld(testDb().db, `rt17-crash-${expected}`);
    const ids = [];
    for (let i = 0; i < 4; i += 1) ids.push(await w.member(`崩溃员工${i}`));
    ids.sort();
    await w.fixedAgeRule(60);
    await w.setSwitch('expected_date', true);
    RETIREMENT_BATCH_LIMITS.page = 2;
    const before = await w.personOf(ids[0]!);

    const lock = locks.lockTransferParticipants;
    const spy = vi.spyOn(locks, 'lockTransferParticipants').mockImplementation(async (tx, ctx, employeeId, ...rest) => {
      if (employeeId === ids[0]) return 'busy';
      if (employeeId === ids[2]) throw new Error('process exit');
      return lock(tx, ctx, employeeId, ...rest);
    });
    const crashed = await runAt(w, clockAt(DAY));
    expect(crashed.of('expected_date').aborted).toBe(true);
    expect(await w.runRow('expected_date', DAY)).toMatchObject({ state: 'running', position: ids[1] });
    expect(await w.skipRows('expected_date', DAY)).toEqual([{ employeeId: ids[0], state: 'pending' }]);

    spy.mockImplementation(async (tx, ctx, employeeId, ...rest) =>
      stillBusy && employeeId === ids[0] ? 'busy' : lock(tx, ctx, employeeId, ...rest),
    );
    const resumed = await runAt(w, clockAt(DAY, '02:11:00'));
    const run = resumed.of('expected_date');
    expect(run.aborted).toBe(false);
    expect(run.updated.map((item) => item.employeeId).sort()).toEqual((stillBusy ? ids.slice(1) : ids).slice().sort());
    const row = await w.runRow('expected_date', DAY);
    if (expected === 'done') {
      expect(await w.skipRows('expected_date', DAY)).toEqual([]);
      expect(row).toMatchObject({ state: 'done', skipped: 0 });
      expect((await w.personOf(ids[0]!)).expected).toBe(NEW_P);
    } else {
      expect(await w.skipRows('expected_date', DAY)).toEqual([{ employeeId: ids[0], state: 'given_up' }]);
      expect(row).toMatchObject({ state: 'done', skipped: 1 });
      expect(await w.personOf(ids[0]!)).toMatchObject({ expected: before.expected, revision: before.revision });
    }
  });

  it('第二遍中途崩溃：接管者看到位置已到末尾、仍有 pending，直接进入第二遍', async () => {
    const w = await batchWorld(testDb().db, 'rt17-pass2');
    const ids = [];
    for (let i = 0; i < 3; i += 1) ids.push(await w.member(`二遍员工${i}`));
    ids.sort();
    await w.fixedAgeRule(60);
    await w.setSwitch('expected_date', true);
    RETIREMENT_BATCH_LIMITS.page = 2;

    const lock = locks.lockTransferParticipants;
    let secondPass = false;
    const spy = vi.spyOn(locks, 'lockTransferParticipants').mockImplementation(async (tx, ctx, employeeId, ...rest) => {
      if (employeeId === ids[0] && !secondPass) {
        secondPass = true;
        return 'busy';
      }
      // 第二遍重试 ids[0] 时进程退出
      if (employeeId === ids[0]) throw new Error('process exit in pass 2');
      return lock(tx, ctx, employeeId, ...rest);
    });
    const crashed = await runAt(w, clockAt(DAY));
    expect(crashed.of('expected_date').aborted).toBe(true);
    expect(await w.runRow('expected_date', DAY)).toMatchObject({ state: 'running', position: ids[2] });
    expect(await w.skipRows('expected_date', DAY)).toEqual([{ employeeId: ids[0], state: 'pending' }]);

    spy.mockImplementation(async (tx, ctx, employeeId, ...rest) => lock(tx, ctx, employeeId, ...rest));
    const resumed = await runAt(w, clockAt(DAY, '02:11:00'));
    expect(resumed.of('expected_date').updated.map((item) => item.employeeId)).toEqual([ids[0]]);
    expect(await w.skipRows('expected_date', DAY)).toEqual([]);
    expect(await w.runRow('expected_date', DAY)).toMatchObject({ state: 'done', attempts: 2 });
  });

  it('离职人员不重算（A-4）；无出生日期的在职员工 P 为空', async () => {
    const w = await batchWorld(testDb().db, 'rt17-candidates');
    const active = await w.member('在职员工');
    const left = await w.member('离职员工');
    const noBirthday = await w.member('无出生日期员工', { birthday: null });
    await w.leave(left);
    await w.fixedAgeRule(60);
    await w.setSwitch('expected_date', true);
    const before = await w.personOf(left);
    const run = await runAt(w, clockAt(DAY));
    expect(run.of('expected_date').updated.map((item) => item.employeeId)).toEqual([active]);
    expect(await w.personOf(left)).toMatchObject({ expected: null, revision: before.revision });
    expect((await w.personOf(noBirthday)).expected).toBeNull();
  });
});

describe('AC-RT-02 / AC-RT-21 核准标志', () => {
  it('预计退休日期已核准：批次不改写 P；规则不再命中也不清空', async () => {
    const w = await batchWorld(testDb().db, 'rt02-confirmed');
    const employee = await w.member('已核准员工', {
      expectedRetirementDate: '2031-01-31',
      expectedRetirementConfirmed: true,
    });
    await w.fixedAgeRule(60);
    await w.setSwitch('expected_date', true);
    const before = await w.personOf(employee);
    const run = await runAt(w, clockAt(DAY));
    expect(run.of('expected_date').updated).toEqual([]);
    expect(await w.personOf(employee)).toMatchObject({ expected: '2031-01-31', revision: before.revision });
  });

  it('弹性范围已核准：不写上下限；P 为空时按 A-20 清空上下限，核准标志不变', async () => {
    const w = await batchWorld(testDb().db, 'rt21-flex-confirmed');
    const kept = await w.member('核准且有 P', {
      expectedRetirementDate: '2030-06-01',
      earliestRetirementDate: '2029-06-01',
      latestRetirementDate: '2031-06-01',
      flexibleRangeConfirmed: true,
    });
    await w.statutoryRangeRule();
    await w.setSwitch('flexible_range', true);
    const before = await w.personOf(kept);
    const run = await runAt(w, clockAt(DAY));
    expect(run.of('flexible_range').updated).toEqual([]);
    expect(await w.personOf(kept)).toMatchObject({
      earliest: '2029-06-01',
      latest: '2031-06-01',
      flexConfirmed: true,
      revision: before.revision,
    });
  });

  it.each([
    ['弹性已核准', true],
    ['弹性未核准', false],
  ] as const)('规则不再命中，批处理清空 P（%s）：上下限一并清空、核准标志不变', async (_label, flexConfirmed) => {
    const w = await batchWorld(testDb().db, `rt21-clear-${flexConfirmed}`);
    const employee = await w.member('清空员工', {
      expectedRetirementDate: '2030-06-01',
      expectedRetirementConfirmed: false,
      earliestRetirementDate: '2029-06-01',
      latestRetirementDate: '2031-06-01',
      flexibleRangeConfirmed: flexConfirmed,
    });
    // 适用组织外的规则：员工不再命中任何启用规则
    const rule = await w.fixedAgeRule(60, {
      conditions: [{ fieldCode: 'employType', operator: 'in', values: ['external'] }],
    });
    expect(rule.id).toBeTruthy();
    await w.setSwitch('expected_date', true);
    const run = await runAt(w, clockAt(DAY));
    expect(run.of('expected_date').updated.map((item) => item.employeeId)).toEqual([employee]);
    expect(await w.personOf(employee)).toMatchObject({
      expected: null,
      earliest: null,
      latest: null,
      flexConfirmed: flexConfirmed,
    });
  });
});

describe('AC-RT-23 P 重算后移出已核准旧范围', () => {
  const OLD = { expectedRetirementDate: '2030-06-01', expectedRetirementConfirmed: false };

  it('① 弹性已核准：预计日期批次写 P，上下限保持，版本 +1；弹性批次不写，版本不再增加', async () => {
    const w = await batchWorld(testDb().db, 'rt23-confirmed');
    const employee = await w.member('核准员工', {
      ...OLD,
      earliestRetirementDate: '2029-06-01',
      latestRetirementDate: '2031-06-01',
      flexibleRangeConfirmed: true,
    });
    await w.fixedAgeRule(60);
    await w.statutoryRangeRule();
    await w.setSwitch('expected_date', true);
    await w.setSwitch('flexible_range', true);
    const base = await w.personOf(employee);

    const run = await runAt(w, clockAt(DAY));
    expect(run.of('expected_date').updated.map((item) => item.employeeId)).toEqual([employee]);
    expect(run.of('flexible_range').updated).toEqual([]);
    expect(await w.personOf(employee)).toMatchObject({
      expected: NEW_P,
      earliest: '2029-06-01',
      latest: '2031-06-01',
      revision: base.revision + 1,
    });
  });

  it('② 弹性未核准：预计日期批次写 P（版本 +1），弹性批次写新范围（版本再 +1）', async () => {
    const w = await batchWorld(testDb().db, 'rt23-unconfirmed');
    const employee = await w.member('未核准员工', {
      ...OLD,
      earliestRetirementDate: '2030-06-01',
      latestRetirementDate: '2033-06-01',
      flexibleRangeConfirmed: false,
    });
    await w.fixedAgeRule(60);
    await w.statutoryRangeRule();
    await w.setSwitch('expected_date', true);
    await w.setSwitch('flexible_range', true);
    const base = await w.personOf(employee);

    await runAt(w, clockAt(DAY));
    expect(await w.personOf(employee)).toMatchObject({
      expected: NEW_P,
      earliest: '2035-06-11',
      latest: '2038-06-30',
      revision: base.revision + 2,
    });
  });

  it('② 顺序反过来：弹性批次按旧 P 算出旧范围（同值不写），预计日期批次写新 P，次日弹性批次再写新范围', async () => {
    const w = await batchWorld(testDb().db, 'rt23-reversed');
    const employee = await w.member('反序员工', {
      ...OLD,
      earliestRetirementDate: '2030-06-01',
      latestRetirementDate: '2033-06-01',
      flexibleRangeConfirmed: false,
    });
    await w.fixedAgeRule(60);
    await w.statutoryRangeRule();
    const base = await w.personOf(employee);

    await w.setSwitch('flexible_range', true);
    await runAt(w, clockAt(DAY));
    expect(await w.personOf(employee)).toMatchObject({ expected: '2030-06-01', revision: base.revision });

    await w.setSwitch('flexible_range', false);
    await w.setSwitch('expected_date', true);
    await runAt(w, clockAt(DAY));
    expect(await w.personOf(employee)).toMatchObject({
      expected: NEW_P,
      earliest: '2030-06-01',
      latest: '2033-06-01',
      revision: base.revision + 1,
    });

    await w.setSwitch('flexible_range', true);
    await runAt(w, clockAt('2026-10-02'));
    expect(await w.personOf(employee)).toMatchObject({
      expected: NEW_P,
      earliest: '2035-06-11',
      latest: '2038-06-30',
      revision: base.revision + 2,
    });
  });
});

describe('审计：系统写入带原因与规则 ID', () => {
  it('actor 为系统（空），reason = retirement_rule，带规则 ID 与用途；人事字段变更审计 actor 同为系统', async () => {
    const w = await batchWorld(testDb().db, 'rt-audit');
    const employee = await w.member('审计员工');
    const rule = await w.fixedAgeRule(60);
    await w.setSwitch('expected_date', true);
    await runAt(w, clockAt(DAY));
    const events = await w.sqlRows<{
      action: string;
      actor: string | null;
      after: Record<string, unknown> | null;
    }>(w.audits(employee));
    const rt = events.find((event) => event.action === 'personnel.retirement_rule');
    expect(rt).toBeDefined();
    expect(rt!.actor).toBeNull();
    expect(rt!.after).toMatchObject({ reason: 'retirement_rule', purpose: 'expected_date', ruleId: rule.id });
    const personnel = events.filter((event) => event.action === 'personnel.update');
    expect(personnel.at(-1)!.actor).toBeNull();
  });
});
