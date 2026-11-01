/**
 * 指定日期的职责转交到期执行（R2-T09a；F-408④ / DEC-726）：挂在任职生效定时任务（employment/activation-scheduler.ts）
 * 每个租户的扫描之后。按租户时区判断到期（DEC-056）；同一被转交人的到期记录在一个事务里、与离职 / 调动同一参与人锁，
 * 被占用的人本轮跳过（skipLocked），下轮再办。逐条走单一执行入口 executeDutyItem（DEC-431①），组织新版本启用日 = 转交日期。
 * 幂等：只取未完成且无失败原因的记录，成功即转已完成，重跑不重复执行。失败（DT-R6 接收人不在职、汇报线循环、已不持有等）
 * 只记该条的原因与次数、不整批回滚；失败的记录不自动重试，由操作人在菜单里改接收人 / 日期再提交（覆盖时清空失败原因）。
 */
import { dutyTransferRecords, sql, withTenant, type Db, type Tx } from '@italent/db';
import { DUTY_TRANSFER_STATUS, tenantLocalDate } from '@italent/domain';
import { SYSTEM_USER_ID } from '../../system-actor.js';
import { rowsOf } from '../employment/read-model.js';
import { lockTransferParticipants } from '../employment/transfer-locks.js';
import type { EmploymentContext } from '../employment/types.js';
import { dutyItemFailure, executeDutyItem, type DutyItemFailure } from '../transfer/linkage/duty-execution.js';
import type { DutyRecordRow, DutyTarget } from './duties.js';
import { auditRecord, dutyItemOf } from './service.js';

/** 每租户每轮最多办理的被转交人数（有界查询）；未办完的下一轮继续。 */
const PEOPLE_PER_RUN = 100;

export interface DutyTransferRun {
  readonly completed: number;
  readonly failed: number;
  readonly skippedLocked: number;
}

export async function runDueMenuDutyTransfers(
  db: Db,
  tenant: { readonly id: string; readonly timezone: string },
  now: Date,
  commandId: string,
): Promise<DutyTransferRun> {
  const today = tenantLocalDate(now, tenant.timezone);
  const ctx: EmploymentContext = {
    tenantId: tenant.id,
    userId: SYSTEM_USER_ID,
    timezone: tenant.timezone,
    now,
    commandId,
    expectedRevision: 0,
  };
  const people = await withTenant(db, tenant.id, async (tx) =>
    rowsOf<{ employeeId: string }>(
      await tx.execute(sql`SELECT DISTINCT employee_id::text AS "employeeId" FROM duty_transfer_records
        WHERE tenant_id=${tenant.id} AND status=${DUTY_TRANSFER_STATUS.unfinished} AND failure_code IS NULL
          AND transfer_date<=${today}::date
        ORDER BY 1 LIMIT ${PEOPLE_PER_RUN}`),
    ),
  );
  const run = { completed: 0, failed: 0, skippedLocked: 0 };
  for (const { employeeId } of people) {
    const outcome = await withTenant(db, tenant.id, (tx) => runPerson(tx, ctx, employeeId, today));
    if (outcome === 'busy') run.skippedLocked += 1;
    if (typeof outcome === 'string') continue;
    run.completed += outcome.completed;
    run.failed += outcome.failed;
  }
  return run;
}

async function runPerson(tx: Tx, ctx: EmploymentContext, employeeId: string, today: string) {
  const subordinates = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT DISTINCT subordinate_id::text AS id FROM duty_transfer_records
      WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid AND subordinate_id IS NOT NULL
        AND status=${DUTY_TRANSFER_STATUS.unfinished} AND transfer_date<=${today}::date`),
  ).map((row) => row.id);
  const lock = await lockTransferParticipants(tx, ctx, employeeId, subordinates, { skipLocked: true });
  if (lock !== 'acquired') return lock;
  // 锁后重读：等锁期间菜单可能已覆盖 / 撤回。
  const due = await tx
    .select()
    .from(dutyTransferRecords)
    .where(
      sql`tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid AND status=${DUTY_TRANSFER_STATUS.unfinished}
        AND failure_code IS NULL AND transfer_date<=${today}::date`,
    )
    .orderBy(dutyTransferRecords.transferDate, dutyTransferRecords.id)
    .for('update');
  const outcome = { completed: 0, failed: 0 };
  for (const record of due) {
    const failure = await attempt(tx, ctx, record);
    await settle(tx, ctx, record, failure);
    outcome[failure ? 'failed' : 'completed'] += 1;
  }
  return outcome;
}

async function attempt(tx: Tx, ctx: EmploymentContext, record: DutyRecordRow): Promise<DutyItemFailure | null> {
  const item = dutyItemOf(
    record as DutyTarget & DutyRecordRow,
    record.employeeId,
    record.receiverId,
    record.transferDate,
  );
  try {
    await tx.transaction((savepoint) => executeDutyItem(savepoint, ctx, item));
    return null;
  } catch (error) {
    const failure = dutyItemFailure(error);
    if (!failure) throw error;
    return failure;
  }
}

async function settle(tx: Tx, ctx: EmploymentContext, record: DutyRecordRow, failure: DutyItemFailure | null) {
  const [saved] = await tx
    .update(dutyTransferRecords)
    .set({
      status: failure ? DUTY_TRANSFER_STATUS.unfinished : DUTY_TRANSFER_STATUS.completed,
      transferAt: failure ? null : ctx.now,
      attemptCount: record.attemptCount + 1,
      failureCode: failure?.code ?? null,
      failureMessage: failure?.message ?? null,
      failureRule: failure?.rule ?? null,
      lastAttemptAt: ctx.now,
      revision: record.revision + 1,
      updatedAt: ctx.now,
    })
    .where(sql`tenant_id=${ctx.tenantId} AND id=${record.id}::uuid`)
    .returning();
  await auditRecord(tx, ctx, failure ? 'duty_transfer.menu.failed' : 'duty_transfer.menu.completed', record, saved!);
}
