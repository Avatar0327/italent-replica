/**
 * F-505 S1 验收夹具：租户、人员 + 入职业务、Offer 行、签署来源锚点与签署任务的库级造数。
 * 全部走 withTenant（普通角色 app_owner 下也能跑），任务用原生 SQL 写（不依赖当前 Drizzle 列形状，
 * 旧结构升级用例只传旧列；新列只在新结构断言里出现）。数据一律合成（ZZ_F505_*、example.com）。
 */
import { randomUUID } from 'node:crypto';
import { type Db, pgErrorCode, sql, withTenant } from '@italent/db';
import { linkageWorld } from './AC-LNK-support.js';

export const rowsOf = <T>(value: unknown) => (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];

export interface TaskSeed {
  readonly scene: string;
  readonly employeeId: string;
  readonly businessId?: string | null;
  readonly offerId?: string | null;
  readonly sourceRevision?: number | null;
  readonly origin?: string;
  readonly status?: 'signing' | 'revoked' | 'completed';
  readonly variableReadFields?: string;
}

export async function sourceWorld(db: Db, label: string) {
  const w = await linkageWorld(db, `f505-${label}`);
  const tenantId = w.session.tenant.id;
  const userId = w.session.user.id;
  const person = await w.hire(`ZZ_F505_EMP_${label}`);
  return {
    ...w,
    tenantId,
    userId,
    person,
    entryBusinessId: person.hire.id,
    offer: (status = 'accepted') => insertOffer(db, tenantId, userId, status),
    anchor: (offerId: string) => insertAnchor(db, tenantId, offerId),
    task: (seed: TaskSeed, forTenant = tenantId) => insertTask(db, forTenant, userId, seed),
    taskCount: () => countRows(db, tenantId, 'esign_tasks'),
    anchorCount: () => countRows(db, tenantId, 'esign_offer_sources'),
  };
}
export type SourceWorld = Awaited<ReturnType<typeof sourceWorld>>;

export async function insertOffer(db: Db, tenantId: string, userId: string, status: string) {
  const id = randomUUID();
  await withTenant(db, tenantId, (tx) =>
    tx.execute(sql`INSERT INTO offers(id, tenant_id, entry, name, personal_email, status, accept_time, created_by)
      VALUES (${id}, ${tenantId}, 'offer', 'ZZ_F505_候选人', ${`f505-${id.slice(0, 8)}@example.com`},
        ${status}, ${status === 'accepted' ? sql`now()` : null}, ${userId})`),
  );
  return id;
}

export function insertAnchor(db: Db, tenantId: string, offerId: string) {
  return withTenant(db, tenantId, (tx) =>
    tx.execute(sql`INSERT INTO esign_offer_sources(tenant_id, offer_id) VALUES (${tenantId}, ${offerId}::uuid)`),
  );
}

export async function insertTask(db: Db, tenantId: string, userId: string, seed: TaskSeed): Promise<string> {
  const id = randomUUID();
  const status = seed.status ?? 'signing';
  const node = status === 'signing' ? 'employee' : null;
  const result = await withTenant(db, tenantId, (tx) =>
    tx.execute(sql`INSERT INTO esign_tasks(id, tenant_id, scene, business_id, offer_id, employee_id,
        initiator_user_id, origin, status, current_node, validity_days, expires_at, initiated_at,
        source_revision, variable_read_fields, revoked_at, revoke_cause, completed_at)
      VALUES (${id}, ${tenantId}, ${seed.scene}, ${seed.businessId ?? null}::uuid, ${seed.offerId ?? null}::uuid,
        ${seed.employeeId}::uuid, ${userId}::uuid, ${seed.origin ?? 'manual'}, ${status}, ${node}, 2,
        now() + interval '2 days', now(), ${seed.sourceRevision ?? null}::integer,
        ${seed.variableReadFields ?? '{}'}::text[],
        ${status === 'revoked' ? sql`now()` : null}, ${status === 'revoked' ? 'manual' : null},
        ${status === 'completed' ? sql`now()` : null})
      RETURNING id`),
  );
  return rowsOf<{ id: string }>(result)[0]!.id;
}

/** 返回 SQLSTATE（成功返回 'ok'），用来断言约束类别，不依赖报错文案。 */
export async function sqlState(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
    return 'ok';
  } catch (error) {
    return pgErrorCode(error) ?? 'unknown';
  }
}

export async function countRows(db: Db, tenantId: string, table: 'esign_tasks' | 'esign_offer_sources') {
  const result = await withTenant(db, tenantId, (tx) =>
    tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`),
  );
  return Number(rowsOf<{ n: number }>(result)[0]!.n);
}

/** 检查约束 / 外键 / 唯一冲突的 SQLSTATE。 */
export const CHECK_VIOLATION = '23514';
export const FOREIGN_KEY_VIOLATION = '23503';
export const UNIQUE_VIOLATION = '23505';
