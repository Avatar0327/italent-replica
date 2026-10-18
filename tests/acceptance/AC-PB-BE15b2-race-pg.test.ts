/**
 * BE-15b2 自动考核与手工入口的真 PG 并发（AC-PB-06，PB-R9 / R20；第 1 轮 P2-3）：
 * 每组都用屏障强制交错——在真实取锁点之后暂停持锁方，等另一连接确认“跳过（SKIP LOCKED）”或“在锁上阻塞”后再放行，
 * 覆盖双方各自先拿到员工锁的两种次序；回执逐项解析，只接受约定的业务拒绝原因（排除 500、CONCURRENT_WRITE 等）：
 * - 自动批次 × 手工发起考核；自动批次 × 手工直接转正；自动批次 × 立即执行。
 * 结果只能二选一：要么自动考核发起、手工入口被 PB-R9 拦下；要么手工先办、自动考核失败 / 不再适用；从不出现两条在途考核。
 */
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as assessment from '../../apps/api/src/modules/employment/assessment.js';
import * as guard from '../../apps/api/src/modules/employment/probation-guard.js';
import { autoAssessmentWorld, type AutoAssessmentWorld } from './AC-PB-BE15b2-support.js';
import { waitForBlocked } from './support/pg-interleave.js';

const testDb = useTestDb();
const DAY = '2026-10-01T01:00:00.000Z';

afterEach(() => vi.restoreAllMocks());

/** 一次性屏障：持锁方到达后暂停，直到放行。 */
function barrier() {
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((done) => (entered = done));
  const gate = new Promise<void>((done) => (release = done));
  return { reached, gate, entered, release };
}

/** 手工入口（发起考核 / 直接转正）已持员工锁、尚未提交时暂停：两者都在锁内调用 PB-R9 统一检查点。 */
function pauseManualHoldingLock() {
  const b = barrier();
  const original = guard.assertProbationProcessesIdle;
  let first = true;
  vi.spyOn(guard, 'assertProbationProcessesIdle').mockImplementation(async (...args) => {
    if (first) {
      first = false;
      b.entered();
      await b.gate;
    }
    return original(...args);
  });
  return b;
}

/** 自动发起（批次或立即执行）已持员工锁、进入单一发起入口之前暂停。 */
function pauseAutoHoldingLock() {
  const b = barrier();
  const original = assessment.launchAssessment;
  let first = true;
  vi.spyOn(assessment, 'launchAssessment').mockImplementation(async (...args) => {
    if (first) {
      first = false;
      b.entered();
      await b.gate;
    }
    return original(...args);
  });
  return b;
}

interface Item {
  status: 'succeeded' | 'failed';
  error: { code: string; details?: { reason?: string } } | null;
}
type ManualOutcome = 'succeeded' | 'stale-revision' | 'process-in-review';
/**
 * 手工回执必须是 200，单人结果只能是约定的三种之一（其余——500、CONCURRENT_WRITE、死锁转出的冲突码等——一律判红）：
 * 成功；员工 revision 已被对方提交推进的 REVISION_CONFLICT（If-Match 过期，客户端刷新后重提）；
 * 对方的流程审批中而被 PB-R9 拦下的 CONFLICT + PROBATION_PROCESS_IN_REVIEW。
 */
async function manualOutcome(response: Response): Promise<ManualOutcome> {
  expect(response.status, await response.clone().text()).toBe(200);
  const [item] = ((await response.json()) as { items: Item[] }).items;
  if (item!.status === 'succeeded') return 'succeeded';
  const refusal = { code: item!.error?.code, reason: item!.error?.details?.reason };
  if (refusal.code === 'REVISION_CONFLICT') return 'stale-revision';
  expect(refusal).toEqual({ code: 'CONFLICT', reason: 'PROBATION_PROCESS_IN_REVIEW' });
  return 'process-in-review';
}

async function world(label: string): Promise<AutoAssessmentWorld> {
  const w = await autoAssessmentWorld(testDb().db, label);
  await w.created(w.body());
  await w.enableSwitch();
  return w;
}

const inReview = async (w: AutoAssessmentWorld, employeeId: string) =>
  (await w.assessmentsOf(employeeId)).filter((row) => row.status === 'in_review');

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('自动批次 × 手工发起考核（强制交错）', () => {
  it('手工先持锁：批次确实 SKIP LOCKED 跳过；放行后手工成功，同日下一时槽自动考核按 PB-R20 记失败，不出现第二条在途考核', async () => {
    const w = await world('race-assess-manual-first');
    const person = await w.probationer('手工先办员工');
    const b = pauseManualHoldingLock();
    const manual = w.launchRaw('probation', [person]);
    await b.reached;
    const skipped = await w.batch(DAY);
    expect(skipped).toMatchObject({ ran: true, skippedLocked: 1, launched: [], failed: [], errors: [] });
    b.release();
    expect(await manualOutcome(await manual)).toBe('succeeded');
    const retried = await w.batch(DAY);
    expect(retried).toMatchObject({ ran: true, launched: [], errors: [] });
    expect(retried.failed.map((item) => item.reason)).toEqual(['AUTO_ASSESSMENT_CYCLE_CONFLICT']);
    const rows = await inReview(w, person.employeeId);
    expect(rows.map((row) => row.initiation)).toEqual(['manual']);
  });

  it('自动先持锁：手工在员工锁上阻塞（确认等待者），放行后自动发起，手工被 PB-R9 拦下', async () => {
    const w = await world('race-assess-auto-first');
    const person = await w.probationer('自动先办员工');
    const b = pauseAutoHoldingLock();
    const batch = w.batch(DAY);
    await b.reached;
    const manual = w.launchRaw('probation', [person]);
    await waitForBlocked(w.db, 1);
    b.release();
    const run = await batch;
    expect(run).toMatchObject({ ran: true, failed: [], errors: [] });
    expect(run.launched.map((item) => item.employeeId)).toEqual([person.employeeId]);
    // 自动提交推进了员工 revision：阻塞的手工请求带的是旧 If-Match，先被 REVISION_CONFLICT 拦下；刷新后重提才见 PB-R9
    expect(await manualOutcome(await manual)).toBe('stale-revision');
    expect(await manualOutcome(await w.launchRaw('probation', [person]))).toBe('process-in-review');
    expect((await inReview(w, person.employeeId)).map((row) => row.initiation)).toEqual(['auto']);
  });
});

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('自动批次 × 手工直接转正（强制交错）', () => {
  it('手工转正先持锁：批次跳过；放行后转正成功，员工不再是试用，下一时槽自动考核不再适用、不留在途考核', async () => {
    const w = await world('race-reg-manual-first');
    const person = await w.probationer('手工转正先办员工');
    const b = pauseManualHoldingLock();
    const manual = w.regularizeRaw(person, 'direct', '2026-10-01');
    await b.reached;
    expect(await w.batch(DAY)).toMatchObject({ ran: true, skippedLocked: 1, launched: [], failed: [], errors: [] });
    b.release();
    expect(await manualOutcome(await manual)).toBe('succeeded');
    expect(await w.batch(DAY)).toMatchObject({ launched: [], failed: [], errors: [] });
    expect(await w.assessmentsOf(person.employeeId)).toEqual([]);
  });

  it('自动先持锁：手工转正在员工锁上阻塞，放行后自动发起，手工转正被 PB-R9 拦下，不生成转正业务', async () => {
    const w = await world('race-reg-auto-first');
    const person = await w.probationer('自动先办转正员工');
    const b = pauseAutoHoldingLock();
    const batch = w.batch(DAY);
    await b.reached;
    const manual = w.regularizeRaw(person, 'direct', '2026-10-01');
    await waitForBlocked(w.db, 1);
    b.release();
    expect((await batch).launched.map((item) => item.employeeId)).toEqual([person.employeeId]);
    expect(await manualOutcome(await manual)).toBe('stale-revision');
    expect(await manualOutcome(await w.regularizeRaw(person, 'direct', '2026-10-01'))).toBe('process-in-review');
    expect(await inReview(w, person.employeeId)).toHaveLength(1);
  });
});

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('自动批次 × 立即执行（强制交错）', () => {
  it('立即执行先持锁：批次跳过；放行后立即执行发起一次，下一时槽按台账不重复', async () => {
    const w = await world('race-run-now-first');
    const person = await w.probationer('立即执行先办员工');
    const b = pauseAutoHoldingLock();
    const now = w.runNow();
    await b.reached;
    expect(await w.batch(DAY)).toMatchObject({ ran: true, skippedLocked: 1, launched: [], failed: [], errors: [] });
    b.release();
    const response = await now;
    expect(response.status, await response.clone().text()).toBe(200);
    expect(((await response.json()) as { launched: unknown[] }).launched).toHaveLength(1);
    expect(await w.batch(DAY)).toMatchObject({ launched: [], failed: [], errors: [] });
    expect(await w.assessmentsOf(person.employeeId)).toHaveLength(1);
  });

  it('批次先持锁：立即执行在锁上阻塞，放行后按台账复核不重复发起', async () => {
    const w = await world('race-batch-first');
    const person = await w.probationer('批次先办员工');
    const b = pauseAutoHoldingLock();
    const batch = w.batch(DAY);
    await b.reached;
    const now = w.runNow();
    await waitForBlocked(w.db, 1);
    b.release();
    expect((await batch).launched).toHaveLength(1);
    const response = await now;
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ launched: [], failed: [] });
    expect(await w.assessmentsOf(person.employeeId)).toHaveLength(1);
  });

  it('两次立即执行 + 批次同时运行：每名到期员工只有一条自动考核、一条发起台账（总量不变量）', async () => {
    const w = await world('race-total');
    const people = [];
    for (let i = 0; i < 4; i += 1) people.push(await w.probationer(`并发员工${i}`));
    const [first, second, scheduled] = await Promise.all([w.runNow(), w.runNow(), w.batch(DAY)]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // 批次可能因持锁跳过，由后续时槽补上；全部到期员工最终各只有一条
    await w.batch(DAY);
    expect(scheduled.errors).toEqual([]);
    for (const person of people) {
      expect(await w.assessmentsOf(person.employeeId)).toHaveLength(1);
      expect((await w.launchesOf(person.employeeId)).filter((row) => row.state === 'launched')).toHaveLength(1);
    }
  });
});
