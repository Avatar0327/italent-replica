/** DM-R9 / DEC-684：离退休事务中的持久任务出口；此处绝不取账号锁或改账号状态。 */
import { afterTransactionCommit, and, eq, exitAccountSettings, exitAccountTasks, sql, type Tx } from '@italent/db';
import { z } from 'zod';
import { assertRevision, auditEmployment } from './context.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';
import { drainExitAccounts } from './exit-account-worker.js';

export type AccountTask = typeof exitAccountTasks.$inferSelect;
export const accountSettingBody = z
  .strictObject({
    earlyEnabled: z.boolean(),
    basis: z.enum(['actual_leave_date', 'last_work_date']).nullable(),
    time: z
      .string()
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
      .nullable(),
    inReview: z.boolean(),
  })
  .refine((v) => !v.earlyEnabled || (v.basis !== null && v.time !== null));
export const defaultAccountSettings = { earlyEnabled: false, basis: null, time: null, inReview: false, revision: 0 };
export const taskKey = (tenantId: string, businessId: string) =>
  and(eq(exitAccountTasks.tenantId, tenantId), eq(exitAccountTasks.businessId, businessId));

export async function readAccountSettings(tx: Tx, tenantId: string) {
  const [row] = await tx.select().from(exitAccountSettings).where(eq(exitAccountSettings.tenantId, tenantId));
  if (!row) return defaultAccountSettings;
  const { tenantId: _tenant, ...value } = row;
  return value;
}
export async function saveAccountSettings(tx: Tx, ctx: EmploymentContext, input: z.infer<typeof accountSettingBody>) {
  await tx.insert(exitAccountSettings).values({ tenantId: ctx.tenantId }).onConflictDoNothing();
  const [before] = await tx
    .select()
    .from(exitAccountSettings)
    .where(eq(exitAccountSettings.tenantId, ctx.tenantId))
    .for('update');
  assertRevision(ctx.expectedRevision, before!.revision);
  const after = { ...input, revision: before!.revision + 1 };
  await tx.update(exitAccountSettings).set(after).where(eq(exitAccountSettings.tenantId, ctx.tenantId));
  await auditEmployment(
    tx,
    ctx,
    'employment.exit_account.settings',
    'employment_settings',
    ctx.tenantId,
    before,
    after,
  );
  return after;
}

export async function queueExitAccount(tx: Tx, ctx: EmploymentContext, businessId: string, restoreRequested = false) {
  const [source] = rowsOf<{ employeeId: string; userId: string; handler: string | null }>(
    await tx.execute(sql`
    SELECT e.employee_id AS "employeeId", l.user_id AS "userId",
      CASE WHEN e.initiator='hr' THEN e.initiator_user_id END AS handler
    FROM exit_requests e JOIN permission_user_person_links l
      ON l.tenant_id=e.tenant_id AND l.employee_id=e.employee_id
    WHERE e.tenant_id=${ctx.tenantId} AND e.business_id=${businessId}::uuid`),
  );
  if (!source) return;
  const [before] = await tx.select().from(exitAccountTasks).where(taskKey(ctx.tenantId, businessId));
  const [after] = await tx
    .insert(exitAccountTasks)
    .values({
      tenantId: ctx.tenantId,
      businessId,
      employeeId: source.employeeId,
      userId: source.userId,
      handlerUserId: source.handler,
      commandId: ctx.commandId,
      restoreRequested,
    })
    .onConflictDoUpdate({
      target: [exitAccountTasks.tenantId, exitAccountTasks.businessId],
      set: {
        commandId: ctx.commandId,
        status: sql`CASE WHEN ${exitAccountTasks.status}='blocked' THEN 'blocked' ELSE 'pending' END`,
        restoreRequested: sql`${exitAccountTasks.restoreRequested} OR ${restoreRequested}`,
        revision: sql`${exitAccountTasks.revision}+1`,
      },
      setWhere: sql`${exitAccountTasks.commandId}<>${ctx.commandId}
      OR (${restoreRequested} AND NOT ${exitAccountTasks.restoreRequested})`,
    })
    .returning();
  if (after) await auditTask(tx, ctx, before ?? null, after);
  consumeAccountAfterCommit(tx, ctx, businessId);
}
/** 只消费当前事务实际登记的任务及命令，不从 HTTP 请求键猜测平台派生命令键。 */
export function consumeAccountAfterCommit(tx: Tx, ctx: EmploymentContext, businessId: string) {
  afterTransactionCommit(tx, `exit-account:${ctx.tenantId}:${businessId}:${ctx.commandId}`, (db) =>
    drainExitAccounts(db, ctx.tenantId, ctx.now, ctx.commandId, businessId),
  );
}
export async function auditTask(tx: Tx, ctx: EmploymentContext, before: AccountTask | null, after: AccountTask) {
  await auditEmployment(
    tx,
    ctx,
    'employment.exit_account.task',
    'exit-account-task',
    after.businessId,
    before,
    after,
    undefined,
    undefined,
    { employeeId: after.employeeId },
  );
}
export async function saveTask(tx: Tx, ctx: EmploymentContext, before: AccountTask, values: Partial<AccountTask>) {
  const [after] = await tx
    .update(exitAccountTasks)
    .set({ ...values, revision: before.revision + 1 })
    .where(and(taskKey(ctx.tenantId, before.businessId), eq(exitAccountTasks.revision, before.revision)))
    .returning();
  if (after) await auditTask(tx, ctx, before, after);
  return after;
}
