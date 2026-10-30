/**
 * R2-T08 §7.2 执行权（租约 + fencing）与 §7.3 选单。
 * 同一租户任一时刻只有一个持有者；之后每个执行事务首句比对 fencing，被接管的旧进程不可能再提交任何写入。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { rowsOf } from '../approval/context.js';
import { localHour } from '../employment/auto-regularization-scheduler.js';

export const RUNNER_LEASE_MS = 5 * 60_000;
/** 本进程的持有者令牌；测试以 options.holderToken 模拟多进程。 */
export const PROCESS_HOLDER_TOKEN = randomUUID();

export class FencingLost extends Error {
  constructor() {
    super('组织调整执行权已被接管');
    this.name = 'FencingLost';
  }
}

export interface RunnerLease {
  readonly tenantId: string;
  readonly token: string;
  readonly fencingNo: number;
  readonly leaseMs: number;
  readonly clock: () => Date;
}

const until = (lease: Pick<RunnerLease, 'leaseMs' | 'clock'>) =>
  new Date(lease.clock().getTime() + lease.leaseMs).toISOString();

/** 领取（独立短事务）：租约过期或本令牌续领时 fencing_no + 1；领不到返回 null，本刻跳过该租户。 */
export async function claimOrgAdjustmentRunner(
  db: Db,
  tenantId: string,
  token: string,
  clock: () => Date,
  leaseMs = RUNNER_LEASE_MS,
): Promise<RunnerLease | null> {
  return withTenant(db, tenantId, async (tx) => {
    await tx.execute(sql`INSERT INTO org_adjustment_tenant_runners(tenant_id) VALUES (${tenantId})
      ON CONFLICT DO NOTHING`);
    const [row] = rowsOf<{ fencing_no: number }>(
      await tx.execute(sql`UPDATE org_adjustment_tenant_runners
        SET holder_token=${token}, fencing_no=fencing_no+1, lease_until=${until({ leaseMs, clock })}
        WHERE tenant_id=${tenantId}
          AND (lease_until IS NULL OR lease_until<${clock().toISOString()} OR holder_token=${token})
        RETURNING fencing_no::int AS fencing_no`),
    );
    return row ? { tenantId, token, fencingNo: row.fencing_no, leaseMs, clock } : null;
  });
}

/** 每个执行事务首句（锁序 ⓪）：比对 fencing，一致则顺延租约；不一致整事务回滚。 */
export async function fenced<T>(db: Db, lease: RunnerLease, run: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenant(db, lease.tenantId, async (tx) => {
    const [row] = rowsOf<{ fencing_no: number; holder_token: string | null }>(
      await tx.execute(sql`SELECT fencing_no::int AS fencing_no, holder_token FROM org_adjustment_tenant_runners
        WHERE tenant_id=${lease.tenantId} FOR UPDATE`),
    );
    if (row?.fencing_no !== lease.fencingNo || row.holder_token !== lease.token) throw new FencingLost();
    await tx.execute(sql`UPDATE org_adjustment_tenant_runners SET lease_until=${until(lease)}
      WHERE tenant_id=${lease.tenantId}`);
    return run(tx);
  });
}

/** 没有可执行单据时释放执行权（§7.2“释放”）。 */
export async function releaseRunner(db: Db, lease: RunnerLease) {
  await fenced(db, lease, (tx) =>
    tx.execute(sql`UPDATE org_adjustment_tenant_runners SET lease_until=${lease.clock().toISOString()}
      WHERE tenant_id=${lease.tenantId}`),
  );
}

/**
 * §7.3：running 的单优先（崩溃接管）；否则按 (approved_at, id) 取第一张已到期、且没有更早审批未完成
 * 并与它涉及组织集合 S 相交的单。更早的相交单未到期时本单也等，不越过它。
 */
export async function pickAdjustment(tx: Tx, tenantId: string, timezone: string, now: Date) {
  const today = tenantLocalDate(now, timezone);
  const hour = localHour(now, timezone);
  const [row] = rowsOf<{ adjustment_id: string; state: 'pending' | 'running' }>(
    await tx.execute(sql`SELECT x.adjustment_id, x.state FROM org_adjustment_executions x
      JOIN org_adjustments a ON a.tenant_id=x.tenant_id AND a.id=x.adjustment_id
      WHERE x.tenant_id=${tenantId} AND (x.state='running' OR (x.state='pending'
        AND (x.run_on_date<${today}::date OR (x.run_on_date=${today}::date AND x.run_from_hour<=${hour}))
        AND NOT EXISTS (SELECT 1 FROM org_adjustment_executions y
          JOIN org_adjustments b ON b.tenant_id=y.tenant_id AND b.id=y.adjustment_id
          WHERE y.tenant_id=x.tenant_id AND y.state<>'done' AND (b.approved_at, b.id) < (a.approved_at, a.id)
            AND EXISTS (SELECT 1 FROM org_adjustment_scope_orgs s
              JOIN org_adjustment_scope_orgs o ON o.tenant_id=s.tenant_id AND o.org_id=s.org_id
              WHERE s.tenant_id=x.tenant_id AND s.adjustment_id=y.adjustment_id AND o.adjustment_id=x.adjustment_id))))
      ORDER BY x.state='running' DESC, a.approved_at, a.id LIMIT 1`),
  );
  return row ?? null;
}
