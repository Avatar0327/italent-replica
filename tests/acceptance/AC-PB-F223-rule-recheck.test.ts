/**
 * F-223（BE-15a 第 2 轮审查后补 P2）+ BE-15b2 同口径：预筛之后、员工锁内复核时读取“最新”规则状态。
 * 预筛 / 批次开始时读到的规则快照可能已过期——管理员在这之间停用（或改动）了规则，锁内复核必须按最新状态判，
 * 不能按快照照发。用例在“取到员工锁之后、复核之前”对同一事务做一次停用，等价于另一连接此时已提交的停用（READ COMMITTED）；
 * 真 PG 另有两连接强制交错的版本。自动转正（立即执行、每日批次）与 BE-15b2 的自动考核（立即执行、每日批次）都覆盖。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as locks from '../../apps/api/src/modules/employment/transfer-locks.js';
import { autoAssessmentWorld, AUTO_REGULARIZATION_SWITCH, rowsOf } from './AC-PB-BE15b2-support.js';

const testDb = useTestDb();
const REG_SCHEDULER = '../../apps/api/src/modules/employment/auto-regularization-scheduler.js';
type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];

afterEach(() => vi.restoreAllMocks());

async function regularizationRule(w: Awaited<ReturnType<typeof autoAssessmentWorld>>) {
  const response = await w.emp('POST', '/auto-regularization-rules', {
    ifMatch: 0,
    body: {
      name: '到期当天自动发起转正申请',
      priority: 1,
      orgIds: [w.department],
      mode: 'application',
      daysBefore: 0,
      initiatorType: 'rule_operator',
    },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  await w.enableSwitch(AUTO_REGULARIZATION_SWITCH);
  return (await response.json()) as { id: string; revision: number };
}

/** 取到员工锁之后立刻在同一事务里停用规则（= 预筛与复核之间别的连接提交了停用）。 */
function disableAfterLock(table: 'employment_auto_regularization_rules' | 'employment_auto_assessment_rules') {
  const original = locks.lockTransferParticipants;
  vi.spyOn(locks, 'lockTransferParticipants').mockImplementation(async (tx, ...args) => {
    const locked = await original(tx, ...args);
    await (tx as Tx).execute(sql`UPDATE ${sql.raw(table)} SET enabled=false, revision=revision+1`);
    return locked;
  });
}

const regularizationCount = async (w: Awaited<ReturnType<typeof autoAssessmentWorld>>) =>
  w.asTenant(async (tx) => {
    const [row] = rowsOf<{ n: number }>(
      await tx.execute(sql`SELECT count(*)::int AS n FROM employment_auto_regularization_launches
        WHERE tenant_id=${w.tenant.id}`),
    );
    return row!.n;
  });
const assessmentLaunchCount = async (w: Awaited<ReturnType<typeof autoAssessmentWorld>>) =>
  w.asTenant(async (tx) => {
    const [row] = rowsOf<{ n: number }>(
      await tx.execute(sql`SELECT count(*)::int AS n FROM employment_auto_assessment_launches
        WHERE tenant_id=${w.tenant.id}`),
    );
    return row!.n;
  });

describe('F-223 自动转正：锁内复核读最新规则状态', () => {
  it('立即执行：预筛后规则被停用，锁内复核跳过，不发起、不记台账', async () => {
    const w = await autoAssessmentWorld(testDb().db, 'f223-reg-now');
    await regularizationRule(w);
    const person = await w.probationer('预筛后停用员工', { endDate: '2026-09-30' });
    disableAfterLock('employment_auto_regularization_rules');
    const response = await w.emp('POST', '/auto-regularization/run', { ifMatch: 0, body: {} });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ launched: [], failed: [] });
    expect(await regularizationCount(w)).toBe(0);
    expect(person.employeeId).toBeTruthy();
  });

  it('每日批次：批次开始后规则被停用，逐人锁内复核跳过', async () => {
    const w = await autoAssessmentWorld(testDb().db, 'f223-reg-batch');
    await regularizationRule(w);
    await w.probationer('批次中停用员工', { endDate: '2026-09-30' });
    disableAfterLock('employment_auto_regularization_rules');
    const { runAutoRegularizations } = (await import(REG_SCHEDULER)) as {
      runAutoRegularizations(
        db: Db,
        meta: { actorUserId: null; commandId: string },
        input: { tenantId: string },
        options: { clock: () => Date },
      ): Promise<{ runs: { launched: unknown[]; failed: unknown[]; errors: unknown[] }[] }>;
    };
    const result = await runAutoRegularizations(
      w.db,
      { actorUserId: null, commandId: randomUUID() },
      { tenantId: w.tenant.id },
      { clock: () => new Date('2026-10-01T01:00:00.000Z') },
    );
    expect(result.runs[0]).toMatchObject({ launched: [], failed: [], errors: [] });
    expect(await regularizationCount(w)).toBe(0);
  });
});

describe('BE-15b2 自动考核：锁内复核读最新规则状态', () => {
  it('立即执行与每日批次：预筛 / 批次开始后规则被停用，都不发起', async () => {
    const w = await autoAssessmentWorld(testDb().db, 'f223-assess');
    await w.created(w.body());
    const person = await w.probationer('考核预筛后停用员工');
    await w.enableSwitch();
    disableAfterLock('employment_auto_assessment_rules');
    expect(await w.ran()).toMatchObject({ launched: [], failed: [] });
    expect(await assessmentLaunchCount(w)).toBe(0);
    expect(await w.assessmentsOf(person.employeeId)).toEqual([]);

    // 每日批次同口径（规则此时已停用；换一条启用的规则再被锁内停用）
    vi.restoreAllMocks();
    const [rule] = await w.list();
    await w.setEnabled(rule!.id, rule!.revision, true);
    disableAfterLock('employment_auto_assessment_rules');
    expect(await w.batch('2026-10-01T01:00:00.000Z')).toMatchObject({
      ran: true,
      launched: [],
      failed: [],
      errors: [],
    });
    expect(await assessmentLaunchCount(w)).toBe(0);
  });
});

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('F-223 两连接强制交错（真 PG）', () => {
  it('自动转正：立即执行取到员工锁后暂停，另一连接提交停用，放行后不发起', async () => {
    const w = await autoAssessmentWorld(testDb().db, 'f223-reg-pg');
    const rule = await regularizationRule(w);
    await w.probationer('交错员工', { endDate: '2026-09-30' });
    let entered!: () => void;
    let resume!: () => void;
    const reachedLock = new Promise<void>((done) => (entered = done));
    const released = new Promise<void>((done) => (resume = done));
    const original = locks.lockTransferParticipants;
    vi.spyOn(locks, 'lockTransferParticipants').mockImplementation(async (...args) => {
      const locked = await original(...args);
      entered();
      await released;
      return locked;
    });
    const running = w.emp('POST', '/auto-regularization/run', { ifMatch: 0, body: {} });
    await reachedLock;
    const stopped = await w.emp('PUT', `/auto-regularization-rules/${rule.id}/enabled`, {
      ifMatch: rule.revision,
      body: { enabled: false },
    });
    expect(stopped.status, await stopped.clone().text()).toBe(200);
    resume();
    const response = await running;
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ launched: [], failed: [] });
    expect(await regularizationCount(w)).toBe(0);
  });

  it('自动考核：每日批次逐人取到锁后暂停，另一连接提交停用，放行后不发起', async () => {
    const w = await autoAssessmentWorld(testDb().db, 'f223-assess-pg');
    const rule = await w.created(w.body());
    await w.probationer('考核交错员工');
    await w.enableSwitch();
    let entered!: () => void;
    let resume!: () => void;
    const reachedLock = new Promise<void>((done) => (entered = done));
    const released = new Promise<void>((done) => (resume = done));
    const original = locks.lockTransferParticipants;
    vi.spyOn(locks, 'lockTransferParticipants').mockImplementation(async (...args) => {
      const locked = await original(...args);
      entered();
      await released;
      return locked;
    });
    const running = w.batch('2026-10-01T01:00:00.000Z');
    await reachedLock;
    await w.setEnabled(rule.id, rule.revision, false);
    resume();
    expect(await running).toMatchObject({ launched: [], failed: [], errors: [] });
    expect(await assessmentLaunchCount(w)).toBe(0);
  });
});
