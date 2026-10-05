import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import type { TenantContext } from '../../tenant-context.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import { recordAudit } from '../../audit/record.js';

export type Row = Record<string, unknown>;
export interface PersonnelContext extends TenantContext {
  readonly expectedRevision: number;
  readonly commandId: string;
  readonly now: Date;
}
export function rows<T = Row>(value: unknown): T[] {
  return (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];
}
export const column = (key: string) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
export const camel = (row: Row): Row =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      value,
    ]),
  );
export function assertRevision(expected: number, actual: number) {
  if (expected !== actual) throw new AppError('REVISION_CONFLICT', '人员数据已变更，请刷新后显式重提');
}
/** Table/field identifiers are exclusively selected by module definitions, never raw request input. */
export async function insert(tx: Tx, table: string, value: Row) {
  const entries = Object.entries(value);
  await tx.execute(sql`INSERT INTO ${sql.identifier(table)}
    (${sql.join(
      entries.map(([key]) => sql.identifier(column(key))),
      sql`,`,
    )})
    VALUES (${sql.join(
      entries.map(([, value]) => sql`${value}`),
      sql`,`,
    )})`);
}
export async function update(tx: Tx, table: string, values: Row, where: SQL) {
  await tx.execute(sql`UPDATE ${sql.identifier(table)} SET
    ${sql.join(
      Object.entries(values).map(([key, value]) => sql`${sql.identifier(column(key))}=${value}`),
      sql`,`,
    )}
    WHERE ${where}`);
}
export async function lockPerson(tx: Tx, ctx: PersonnelContext, employeeId: string) {
  const [person] = rows(
    await tx.execute(sql`SELECT id,name,code FROM employment_employees
    WHERE tenant_id=${ctx.tenantId} AND id=${employeeId}::uuid FOR UPDATE`),
  );
  if (!person) throw new AppError('NOT_FOUND', '人员不存在');
  return person;
}
/** DEC-019: sensitive values remain in permission-protected history; outbox contains identifiers only. */
export async function audit(
  tx: Tx,
  ctx: PersonnelContext,
  objectType: string,
  employeeId: string,
  id: string,
  revision: number,
  before: Row | null,
  after: Row | null,
) {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const changed = [...keys].filter((key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]));
  const select = (value: Row | null) =>
    value === null ? null : Object.fromEntries(changed.map((key) => [key, value[key] ?? null]));
  const deleted = after?.deleted === true;
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    action: `personnel.${deleted ? 'delete' : before ? 'update' : 'create'}`,
    objectType,
    objectId: id,
    before: deleted ? before : select(before),
    after: select(after),
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
  await insert(tx, 'personnel_outbox', {
    id: randomUUID(),
    tenantId: ctx.tenantId,
    employeeId,
    objectType,
    objectId: id,
    eventType: 'personnel.changed',
    revision,
    commandId: ctx.commandId,
    state: 'pending',
    createdAt: ctx.now.toISOString(),
  });
}
