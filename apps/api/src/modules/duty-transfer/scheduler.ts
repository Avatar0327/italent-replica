/**
 * 指定日期的职责转交到期执行（R2-T09a；F-408④ / DEC-726）：挂在任职生效定时任务（employment/activation-scheduler.ts）
 * 每个租户的扫描之后。按租户时区判断到期（DEC-056）；同一被转交人的到期记录在一个事务里、与离职 / 调动同一参与人锁，
 * 被占用的人本轮跳过（skipLocked），下轮再办。逐条走单一执行入口 executeDutyItem（DEC-431①），组织新版本启用日 = 转交日期。
 * 幂等：只取未完成且无失败原因的记录，成功即转已完成，重跑不重复执行。失败（DT-R6 接收人不在职、汇报线循环、已不持有等）
 * 只记该条的原因与次数、不整批回滚；失败的记录不自动重试，由操作人在菜单里改接收人 / 日期再提交（覆盖时清空失败原因）。
 * 迟到执行（第 2 轮 P2-4）：接收人资格在转交日期与执行当日（租户时区）都校验，组织新版本启用日仍取转交日期。
 * 逐人兜底（第 2 轮 P3-1，同 sweepTenant）：非业务异常整人回滚、只记本轮 errors 与执行次数，不记失败原因，下轮照常重试；
 * 执行次数到上限（F-448，第 2 轮交叉审 P3-4）后按失败口径落账、不再重试。记次自身出错也只在逐人兜底这一处吞掉，
 * 不打断同租户后续被转交人；任职生效调度外层的 dueDutyTransfers 只兜整租户这一步。
 */
import { dutyTransferRecords, sql, withTenant, type Db, type Tx } from '@italent/db';
import { DUTY_TRANSFER_STATUS, tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { SYSTEM_USER_ID } from '../../system-actor.js';
import { EmploymentError } from '../employment/errors.js';
import { rowsOf } from '../employment/read-model.js';
import { lockTransferParticipants } from '../employment/transfer-locks.js';
import type { EmploymentContext } from '../employment/types.js';
import { dutyItemFailure, executeDutyItem, type DutyItemFailure } from '../transfer/linkage/duty-execution.js';
import type { DutyRecordRow, DutyTarget } from './duties.js';
import { auditRecord, dutyItemOf } from './service.js';

/** 每租户每轮最多办理的被转交人数（有界查询）；未办完的下一轮继续。 */
const PEOPLE_PER_RUN = 100;
/** 非业务异常的执行次数上限：取同类定时任务的口径（组织调整执行 MAX_GROUP_ATTEMPTS、360 凭据维护 FAILING_ATTEMPTS 均为 5）。 */
const MAX_ERROR_ATTEMPTS = 5;
/** 到上限后的失败原因，与组织调整执行“多次执行出错”同码同文案。 */
const EXECUTION_ERROR: DutyItemFailure = { code: 'EXECUTION_ERROR', message: '多次执行出错，已停止重试', rule: null };

export interface DutyTransferRun {
  readonly completed: number;
  readonly failed: number;
  readonly skippedLocked: number;
  /** 非业务异常（存储 / 依赖不可用、未映射错误）：不记失败原因，下轮重试；employeeId 为 null 表示整步出错。 */
  readonly errors: { readonly employeeId: string | null; readonly code: string }[];
}

export const runErrorCode = (error: unknown) =>
  error instanceof AppError || error instanceof EmploymentError ? error.code : 'INTERNAL_ERROR';

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
  const run = { completed: 0, failed: 0, skippedLocked: 0, errors: [] as DutyTransferRun['errors'][number][] };
  for (const { employeeId } of people) {
    try {
      const outcome = await withTenant(db, tenant.id, (tx) => runPerson(tx, ctx, employeeId, today));
      if (outcome === 'busy') run.skippedLocked += 1;
      if (typeof outcome === 'string') continue;
      run.completed += outcome.completed;
      run.failed += outcome.failed;
    } catch (error) {
      run.errors.push({ employeeId, code: runErrorCode(error) });
      // 记次自身出错：该人本轮已记入 errors，次数下轮再记，不再往外抛打断后续被转交人。
      await countAttempt(db, ctx, employeeId, today).catch(() => undefined);
    }
  }
  return run;
}

/**
 * 整人回滚后另开事务记执行次数与时间：未到上限不写失败原因，仍是到期候选、下轮重试；
 * 到上限的记录按既有失败口径落账（失败原因、revision、失败审计），不再是候选。
 */
async function countAttempt(db: Db, ctx: EmploymentContext, employeeId: string, today: string) {
  await withTenant(db, ctx.tenantId, async (tx) => {
    for (const record of await lockDueRecords(tx, ctx, employeeId, today)) {
      if (record.attemptCount + 1 >= MAX_ERROR_ATTEMPTS) await settle(tx, ctx, record, EXECUTION_ERROR);
      else
        await tx
          .update(dutyTransferRecords)
          .set({ attemptCount: record.attemptCount + 1, lastAttemptAt: ctx.now })
          .where(sql`tenant_id=${ctx.tenantId} AND id=${record.id}::uuid`);
    }
  });
}

/** 该被转交人到期待办的记录（未完成、无失败原因、转交日期已到），行锁后返回。 */
function lockDueRecords(tx: Tx, ctx: EmploymentContext, employeeId: string, today: string) {
  return tx
    .select()
    .from(dutyTransferRecords)
    .where(
      sql`tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid AND status=${DUTY_TRANSFER_STATUS.unfinished}
        AND failure_code IS NULL AND transfer_date<=${today}::date`,
    )
    .orderBy(dutyTransferRecords.transferDate, dutyTransferRecords.id)
    .for('update');
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
  const due = await lockDueRecords(tx, ctx, employeeId, today);
  const outcome = { completed: 0, failed: 0 };
  for (const record of due) {
    const failure = await attempt(tx, ctx, record, today);
    await settle(tx, ctx, record, failure);
    outcome[failure ? 'failed' : 'completed'] += 1;
  }
  return outcome;
}

async function attempt(
  tx: Tx,
  ctx: EmploymentContext,
  record: DutyRecordRow,
  today: string,
): Promise<DutyItemFailure | null> {
  const item = dutyItemOf(
    record as DutyTarget & DutyRecordRow,
    record.employeeId,
    record.receiverId,
    record.transferDate,
  );
  try {
    await tx.transaction((savepoint) => executeDutyItem(savepoint, ctx, item, { caller: 'menu', eligibleOn: today }));
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
