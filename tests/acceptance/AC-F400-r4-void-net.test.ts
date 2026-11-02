/**
 * F-400 第 4 轮（Sol P2-R3-1 / P2-R3-2）：一次离职作废的全部带编调动（在途组 + 已落地组）是同一个回退单元，
 * 按编制对象 / 职位细分汇总净变化，每个编制对象只写一次最终值、只对最终状态校验：
 * ① 跨组：已落地 10-20 A→B、在途 10-21 B→A，HR 之后把 A 的职位额度调低；分两组回退时在途组先回退使 A 中途超编，
 *    合并成一组后最终合法，离职应生效。真正最终超编仍整单回滚。
 * ② 上限：A 总额度处于接口上限 2147483647 时，净零的 A→B→A 回退不应因“先加后减”的中间值越过上限而失败
 *    （两种 UUID 相对顺序各一条）；真正最终越过上限仍整单回滚。
 * ③ 三种维护方式、三个编制对象、五条相接调动：整组回退恢复全部额度（第 3 轮先加后减与本轮净变化都应满足，作正式回归保留）。
 * 生效走真实平台调度入口 runEmploymentActivations（w.runScheduler），结果按 employment_activation_attempts 断言。
 */
import './support/exit-gate-enforced.js';
import type * as Crypto from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import { readCapacity } from '../../apps/api/src/modules/establishment/capacity-read.js';
import { rowsOf } from '../../apps/api/src/modules/employment/record-store.js';
import { carriedWorld, type CarriedWorldOptions } from './AC-TRF-47-EST-08-support.js';
import { leaveBody } from './AC-EXIT-gate-support.js';
import { installExitSeeds } from './AC-EXIT-support.js';
import { tenantApi } from './support/tenant-api.js';

/** 只在建调动期间固定 UUID 顺序（合法 v4 形态）：descending=true 时后建的业务 ID 反而更小。 */
const uuidOrder = vi.hoisted(() => ({ active: false, descending: false, counter: 0 }));
vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof Crypto>();
  const next = () => {
    if (!uuidOrder.active) return actual.randomUUID();
    uuidOrder.counter += 1;
    return uuidOrder.descending
      ? `ffffffff-ffff-4fff-bfff-${(0xffffffffffff - uuidOrder.counter).toString(16).padStart(12, '0')}`
      : `00000000-0000-4000-8000-${uuidOrder.counter.toString(16).padStart(12, '0')}`;
  };
  return { ...actual, randomUUID: next, default: { ...actual, randomUUID: next } };
});

const database = useTestDb();
type Carried = Awaited<ReturnType<typeof carriedWorld>>;
type Person = Awaited<ReturnType<Carried['hired']>>;
const MAX = 2_147_483_647;

/** 回退在执行日（10-03）产生新的容量版本，按执行日读额度、预留与职位细分。 */
const amounts = (w: Carried, ids: readonly string[] = [w.sourceCapacity, w.targetCapacity]) =>
  withTenant(database().db, w.session.tenant.id, async (tx) => {
    const records = [];
    for (const id of ids) {
      const r = await readCapacity(tx, w.session.tenant.id, id, '2026-10-03');
      records.push({
        localCapacity: r.localCapacity,
        inclusiveCapacity: r.inclusiveCapacity,
        reservedLocal: r.reservedLocal,
        reservedInclusive: r.reservedInclusive,
        subdivisions: r.subdivisions,
      });
    }
    return records;
  });

const unreversed = (w: Carried) =>
  withTenant(database().db, w.session.tenant.id, async (tx) =>
    Number(
      rowsOf<{ n: number }>(
        await tx.execute(sql`SELECT count(*)::int AS n FROM transfer_establishment_allocations
          WHERE tenant_id=${w.session.tenant.id} AND NOT reversed`),
      )[0]!.n,
    ),
  );

async function transfer(w: Carried, person: Person, extra: Record<string, unknown>) {
  const response = await w.save(person, { mode: 'direct', ...extra });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as { id: string; status: string };
}

/** 直接离职（最后工作日 10-02）：有确认清单时先拿令牌再带回（§8）。 */
async function leave(w: Carried, employeeId: string) {
  const create = async (exit?: object) =>
    w.session.request('POST', `/employees/${employeeId}/businesses`, {
      ifMatch: (await w.session.getEmployee(employeeId)).revision,
      body: leaveBody('2026-10-02', 'direct', exit),
    });
  let response = await create();
  if (response.status === 409) {
    const token = ((await response.json()) as { error: { details: { ackToken: string } } }).error.details.ackToken;
    response = await create({ pendingTransferAck: token });
  }
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as { id: string };
}

/** HR 经真实 PATCH 调整调出方 A 的职位细分额度（预留保持 1）。 */
async function patchSource(w: Carried, positionCapacity: number) {
  const before = await withTenant(database().db, w.session.tenant.id, (tx) =>
    readCapacity(tx, w.session.tenant.id, w.sourceCapacity, '2026-10-01'),
  );
  const api = tenantApi(database().db, { clock: () => new Date('2026-10-01T01:00:00Z') });
  const response = await api.request('PATCH', `/api/tenant/establishment/capacities/${w.sourceCapacity}`, {
    user: w.session.user.id,
    tenant: w.session.tenant.id,
    ifMatch: before.revision,
    body: {
      effectiveDate: '2026-10-01',
      reservedLocal: 1,
      subdivisions: [{ positionId: w.sourcePosition, localCapacity: positionCapacity, inclusiveCapacity: null }],
    },
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

/** 真实平台调度入口在 10-03 执行到期离职，返回该离职最近一次生效尝试。 */
async function activate(w: Carried, businessId: string) {
  const run = await w.runScheduler('2026-10-03T02:00:00Z');
  const [attempt] = await withTenant(database().db, w.session.tenant.id, async (tx) =>
    rowsOf<{ outcome: string; reason: string | null; detail: unknown }>(
      await tx.execute(sql`SELECT outcome, reason, detail FROM employment_activation_attempts
        WHERE tenant_id=${w.session.tenant.id} AND business_id=${businessId}::uuid
        ORDER BY attempt_no DESC LIMIT 1`),
    ),
  );
  expect(attempt, JSON.stringify(run)).toBeDefined();
  return attempt!;
}

const status = async (w: Carried, id: string) => (await w.business(id)).status;

/** 已落地 10-20 A→B、在途（审批中）10-21 B→A；A 另有一人留任，再保存 E 的离职。 */
async function crossGroup(label: string) {
  const w = await carriedWorld(database().db, label);
  await installExitSeeds(database().db, w.session.tenant.id);
  const person = await w.hired();
  const landed = await transfer(w, person, { effectiveDate: '2026-10-20' });
  const pending = await transfer(w, person, {
    mode: 'application',
    submit: true,
    effectiveDate: '2026-10-21',
    fields: { departmentId: w.from.id, positionId: w.sourcePosition },
  });
  expect(pending.status).toBe('in_review');
  await w.hired('留在 A 的合成员工');
  const exit = await leave(w, person.employee.id);
  return { w, landed, pending, exit };
}

describe('F-400 r4 在途组与已落地组合并为一个回退单元，只按最终状态校验', () => {
  it('A 职位额度调为 1：分组回退中途超编，合并后最终合法，离职生效、两单作废、额度恢复', async () => {
    const { w, landed, pending, exit } = await crossGroup('f400r4-cross-legal');
    // E 离职、两调动作废后：A 一人 / 一份职位额度，B 无人 / 零额度，严格控编合法
    await patchSource(w, 1);
    const final = await amounts(w);
    const result = await activate(w, exit.id);
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: 'effective' });
    expect(await status(w, exit.id)).toBe('effective');
    expect(await status(w, landed.id)).toBe('voided');
    expect(await status(w, pending.id)).toBe('voided');
    expect(await amounts(w)).toEqual(final);
    expect(await unreversed(w)).toBe(0);
  });

  it('A 职位额度调为 0：合并后最终仍超编，离职失败 ESTABLISHMENT_EXCEEDED，作废与额度整单回滚', async () => {
    const { w, landed, pending, exit } = await crossGroup('f400r4-cross-exceeded');
    await patchSource(w, 0);
    const before = await amounts(w);
    const allocations = await unreversed(w);
    const result = await activate(w, exit.id);
    expect(result).toMatchObject({ outcome: 'failed', reason: 'ESTABLISHMENT_EXCEEDED' });
    expect(await status(w, exit.id)).not.toBe('effective');
    expect(await status(w, landed.id)).toBe('effective');
    expect(await status(w, pending.id)).toBe('in_review');
    expect(await amounts(w)).toEqual(before);
    expect(await unreversed(w)).toBe(allocations);
  });
});

/** A 总额度 = 职位细分 2147483646 + 预留 1 = 上限；再建两条已落地 A→B→A，净额为零。 */
async function upperBoundChain(label: string, laterHasSmallerId: boolean) {
  const w = await carriedWorld(database().db, label);
  await installExitSeeds(database().db, w.session.tenant.id);
  const person = await w.hired();
  await patchSource(w, MAX - 1);
  const initial = await amounts(w);
  uuidOrder.active = true;
  uuidOrder.descending = laterHasSmallerId;
  const out = await transfer(w, person, { effectiveDate: '2026-10-20' });
  const back = await transfer(w, person, {
    effectiveDate: '2026-10-21',
    fields: { departmentId: w.from.id, positionId: w.sourcePosition },
  });
  uuidOrder.active = false;
  expect(back.id < out.id).toBe(laterHasSmallerId);
  expect(await amounts(w)).toEqual(initial);
  return { w, person, initial, out, back };
}

describe('F-400 r4 额度处于接口上限时，净零回退不产生越界中间值', () => {
  for (const laterHasSmallerId of [false, true])
    it(`A→B→A 已落地链（后一条 UUID ${laterHasSmallerId ? '较小' : '较大'}）：离职生效，额度回到上限`, async () => {
      const { w, person, initial, out, back } = await upperBoundChain(
        `f400r4-upper-${String(laterHasSmallerId)}`,
        laterHasSmallerId,
      );
      const exit = await leave(w, person.employee.id);
      const result = await activate(w, exit.id);
      expect(result, JSON.stringify(result)).toMatchObject({ outcome: 'effective' });
      expect(await status(w, out.id)).toBe('voided');
      expect(await status(w, back.id)).toBe('voided');
      expect(await amounts(w)).toEqual(initial);
      expect(initial[0]!.localCapacity).toBe(MAX);
      expect(await unreversed(w)).toBe(0);
    });

  it('上限 + 跨组：已落地 A→B、在途 B→A，离职生效，额度回到上限', async () => {
    const w = await carriedWorld(database().db, 'f400r4-upper-cross');
    await installExitSeeds(database().db, w.session.tenant.id);
    const person = await w.hired();
    await patchSource(w, MAX - 1);
    const initial = await amounts(w);
    const landed = await transfer(w, person, { effectiveDate: '2026-10-20' });
    const pending = await transfer(w, person, {
      mode: 'application',
      submit: true,
      effectiveDate: '2026-10-21',
      fields: { departmentId: w.from.id, positionId: w.sourcePosition },
    });
    const exit = await leave(w, person.employee.id);
    const result = await activate(w, exit.id);
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: 'effective' });
    expect(await status(w, landed.id)).toBe('voided');
    expect(await status(w, pending.id)).toBe('voided');
    expect(await amounts(w)).toEqual(initial);
    expect(await unreversed(w)).toBe(0);
  });

  it('最终真越过上限：已落地 A→B 后 A 被调到上限，回退 +1 越界，离职失败、整单回滚', async () => {
    const w = await carriedWorld(database().db, 'f400r4-upper-exceeded');
    await installExitSeeds(database().db, w.session.tenant.id);
    const person = await w.hired();
    const landed = await transfer(w, person, { effectiveDate: '2026-10-20' });
    await patchSource(w, MAX - 1);
    const before = await amounts(w);
    const exit = await leave(w, person.employee.id);
    const result = await activate(w, exit.id);
    expect(result.outcome, JSON.stringify(result)).toBe('failed');
    expect(await status(w, exit.id)).not.toBe('effective');
    expect(await status(w, landed.id)).toBe('effective');
    expect(await amounts(w)).toEqual(before);
    expect(await unreversed(w)).toBe(2);
  });
});

describe('F-400 r4 三种维护方式、三个编制对象、五条相接调动：整组回退恢复全部额度', () => {
  for (const mode of ['local', 'inclusive', 'both'] as const satisfies readonly CarriedWorldOptions['mode'][])
    it(`${mode}：离职生效，五单作废，三个编制对象额度与细分恢复，分配全部回退`, async () => {
      const w = await carriedWorld(database().db, `f400r4-matrix-${mode}`, { mode });
      await installExitSeeds(database().db, w.session.tenant.id);
      const third = await w.session.org('第三个合成部门', { establishedOn: '2026-01-01' });
      const thirdPosition = await w.position(third.id);
      const thirdCapacity = await w.capacity(third.id, thirdPosition, 0, 0);
      const ids = [w.sourceCapacity, w.targetCapacity, thirdCapacity];
      const before = await amounts(w, ids);
      const person = await w.hired();
      const path = [
        [w.to.id, w.targetPosition],
        [third.id, thirdPosition],
        [w.from.id, w.sourcePosition],
        [w.to.id, w.targetPosition],
        [w.from.id, w.sourcePosition],
      ] as const;
      const transfers = [];
      for (const [i, [departmentId, positionId]] of path.entries())
        transfers.push(
          await transfer(w, person, { effectiveDate: `2026-10-${20 + i}`, fields: { departmentId, positionId } }),
        );
      expect(await amounts(w, ids)).toEqual(before);
      const exit = await leave(w, person.employee.id);
      const result = await activate(w, exit.id);
      expect(result, JSON.stringify(result)).toMatchObject({ outcome: 'effective' });
      for (const t of transfers) expect(await status(w, t.id)).toBe('voided');
      expect(await amounts(w, ids)).toEqual(before);
      expect(await unreversed(w)).toBe(0);
    });
});
