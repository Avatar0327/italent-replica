/**
 * F-400 第 3 轮（Sol P2-R2-1）：同一员工多条相接的未来带编调动（10-20 A→B、10-21 B→A，调入方 B 初始额度 0）
 * 被离职生效一并作废时，带编回退按整组最终状态校验，结果不取决于业务 UUID 的相对顺序。
 * 两种 UUID 排序各一条：离职 effective、两单 voided、源 / 目标额度与职位细分恢复、分配全部 reversed。
 * 真正最终超编整单回滚的用例在 AC-F400-r2-void-transfers.test.ts。
 * UUID 顺序用 vi.mock 固定为合法的 v4 形态（只消除随机性，业务、HTTP、数据库都走真实实现）。
 */
import './support/exit-gate-enforced.js';
import type * as Crypto from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import { readCapacity } from '../../apps/api/src/modules/establishment/capacity-read.js';
import { rowsOf } from '../../apps/api/src/modules/employment/record-store.js';
import { carriedWorld } from './AC-TRF-47-EST-08-support.js';
import { exitActivator } from './AC-EXIT-activation-support.js';
import { leaveBody } from './AC-EXIT-gate-support.js';
import { installExitSeeds } from './AC-EXIT-support.js';

/** descending=true 时新生成的 UUID 递减：后建的业务 ID 反而更小。 */
const uuidOrder = vi.hoisted(() => ({ descending: false, counter: 0 }));
vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof Crypto>();
  const next = () => {
    uuidOrder.counter += 1;
    const n = uuidOrder.descending ? 0xffffffffffff - uuidOrder.counter : uuidOrder.counter;
    return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
  };
  return { ...actual, randomUUID: next, default: { ...actual, randomUUID: next } };
});

const database = useTestDb();
type Carried = Awaited<ReturnType<typeof carriedWorld>>;

/** 回退在执行日产生新的容量版本，按执行日读额度与细分（同 AC-F400-r2-void-transfers）。 */
const amountsAt = (w: Carried, date: string) =>
  withTenant(database().db, w.session.tenant.id, async (tx) =>
    (
      await Promise.all(
        [w.sourceCapacity, w.targetCapacity].map((id) => readCapacity(tx, w.session.tenant.id, id, date)),
      )
    ).map(({ localCapacity, reservedLocal, subdivisions }) => ({ localCapacity, reservedLocal, subdivisions })),
  );

const unreversed = (w: Carried, ids: readonly string[]) =>
  withTenant(database().db, w.session.tenant.id, async (tx) =>
    rowsOf<{ n: number }>(
      await tx.execute(sql`SELECT count(*)::int AS n FROM transfer_establishment_allocations
        WHERE tenant_id=${w.session.tenant.id} AND business_id = ANY(${`{${ids.join(',')}}`}::uuid[])
          AND NOT reversed`),
    ),
  );

/** 直接离职（最后工作日 10-02）：有确认清单时先拿令牌再带回（§8）。 */
async function acked(session: Carried['session'], employeeId: string) {
  const create = async (exit?: object) =>
    session.request('POST', `/employees/${employeeId}/businesses`, {
      ifMatch: (await session.getEmployee(employeeId)).revision,
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

async function transfer(w: Carried, person: Awaited<ReturnType<Carried['hired']>>, extra: Record<string, unknown>) {
  const response = await w.save(person, { mode: 'direct', ...extra });
  expect(response.status, await response.clone().text()).toBe(201);
  const saved = (await response.json()) as { id: string; status: string };
  expect(saved.status).toBe('effective');
  return saved;
}

/** laterHasSmallerId=false：前一条（A→B）UUID 较小，旧实现先回退它而中途负额度；true：反过来。 */
async function chainCase(laterHasSmallerId: boolean) {
  const w = await carriedWorld(database().db, `f400r3-chain-${String(laterHasSmallerId)}`);
  await installExitSeeds(database().db, w.session.tenant.id);
  const person = await w.hired();
  const before = await amountsAt(w, '2026-10-03');
  uuidOrder.descending = laterHasSmallerId;
  const toTarget = await transfer(w, person, { effectiveDate: '2026-10-20' });
  const back = await transfer(w, person, {
    effectiveDate: '2026-10-21',
    fields: { departmentId: w.from.id, positionId: w.sourcePosition },
  });
  uuidOrder.descending = false;
  expect(back.id < toTarget.id).toBe(laterHasSmallerId);
  // 两次调编净额相抵：调入方 B 回到 0，额度已被后一条带回调出方
  expect(await amountsAt(w, '2026-10-03')).toEqual(before);

  const leave = await acked(w.session, person.employee.id);
  const result = await exitActivator(database().db, w.session)(leave.id, '2026-10-03');
  expect(result, JSON.stringify(result)).toMatchObject({ outcome: 'effective' });
  expect((await w.business(leave.id)).status).toBe('effective');
  expect((await w.business(toTarget.id)).status).toBe('voided');
  expect((await w.business(back.id)).status).toBe('voided');
  expect(await amountsAt(w, '2026-10-03')).toEqual(before);
  expect((await unreversed(w, [toTarget.id, back.id]))[0]?.n).toBe(0);
}

describe('F-400 r3 相接的未来带编调动随离职整组回退，结果与 UUID 顺序无关', () => {
  it('前一条（A→B）UUID 较小：离职生效，两单作废，额度与细分恢复，分配全部回退', () => chainCase(false));
  it('后一条（B→A）UUID 较小：同样离职生效、整组回退', () => chainCase(true));
});
