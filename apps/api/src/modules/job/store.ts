import { sql, type Tx } from '@italent/db';
import type { JobWriteContext } from './types.js';
import { recordAudit } from '../../audit/record.js';

export function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];
}

export function snakeCase(field: string): string {
  return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** 表名来自模块元数据，列来自字段白名单；业务值始终作为 SQL 参数传入。 */
export async function insertRow(tx: Tx, table: string, values: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(values).filter((key) => values[key] !== undefined);
  const columns = sql.join(
    keys.map((key) => sql.identifier(snakeCase(key))),
    sql`, `,
  );
  const parameters = sql.join(
    keys.map((key) => sql`${values[key]}`),
    sql`, `,
  );
  await tx.execute(sql`INSERT INTO ${sql.identifier(table)} (${columns}) VALUES (${parameters})`);
}

export async function auditJob(
  tx: Tx,
  ctx: JobWriteContext,
  action: string,
  objectType: string,
  objectId: string,
  before: unknown,
  after: unknown,
  scope?: { readonly orgId?: string | null },
): Promise<void> {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
    action,
    objectType,
    objectId,
    before,
    after,
    ...(scope ? { scope } : {}),
  });
}
