import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import type { Authorizer } from '../../authorization.js';
import type { TenantContext } from '../../tenant-context.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import { recordAudit } from '../../audit/record.js';

export type Row = Record<string, unknown>;
export interface PersonnelContext extends TenantContext {
  readonly expectedRevision: number;
  readonly commandId: string;
  readonly now: Date;
  /**
   * 处理本次请求的应用的授权器（access() 填入，随命令上下文一路带到子集策略）。子集策略需要“操作人对被引用对象的查看权”
   * （R3-T02 C1-1），钩子签名里没有授权器，所以放在上下文里而不是进程全局：同进程里装配了多个应用时，各用各的。
   * 可信入口（信息采集）由调用方显式带上；系统后台写入不带。
   */
  readonly authorizer?: Authorizer;
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
/**
 * 人员写入口的员工行锁，与任职写入口同一把、同一强度：FOR NO KEY UPDATE（F-565②）。
 * 员工行的 (tenant_id,id) 是各表外键的引用目标，但从不被改写或删除；code 上只有表达式唯一索引，不能作外键目标，
 * 所以 NO KEY UPDATE 足够，且不与外键子行插入（KEY SHARE）互等。
 *
 * 约定（F-565④）：往以员工为外键的子表（personnel_attachments、personnel_* 子集表、合同 / 调动子表等）插行之前，
 * 必须先取这把锁（或 lockEmploymentEmployee）；否则插入只持 KEY SHARE，与已持锁的任职写入口并行，绕过员工级串行。
 * 守卫：tests/acceptance/AC-EMP-F565-lock-order.test.ts（静态扫描 + 屏障用例，变异自证）。
 */
export async function lockPerson(tx: Tx, ctx: PersonnelContext, employeeId: string) {
  const [person] = rows(
    await tx.execute(sql`SELECT id,name,code FROM employment_employees
    WHERE tenant_id=${ctx.tenantId} AND id=${employeeId}::uuid FOR NO KEY UPDATE`),
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
    // DEC-197：只存变化字段时前后值里不一定有 employeeId，所属人员显式给出
    scope: { employeeId },
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
