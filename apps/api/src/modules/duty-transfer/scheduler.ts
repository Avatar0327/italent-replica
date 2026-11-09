/**
 * 指定日期的职责转交到期执行（R2-T09a；F-408④ / DEC-726）：挂在任职生效定时任务（employment/activation-scheduler.ts）
 * 每个租户的扫描之后。按租户时区判断到期（DEC-056）；同一被转交人的到期记录在一个事务里、与离职 / 调动同一参与人锁，
 * 被占用的人本轮跳过（skipLocked），下轮再办。逐条走单一执行入口 executeDutyItem（DEC-431①），组织新版本启用日 = 转交日期。
 * 幂等：只取未完成且无失败原因的记录，成功即转已完成，重跑不重复执行。失败（DT-R6 接收人不在职、汇报线循环、已不持有等）
 * 只记该条的原因与次数、不整批回滚；失败的记录不自动重试，由操作人在菜单里改接收人 / 日期再提交（覆盖时清空失败原因）。
 * 迟到执行（第 2 轮 P2-4）：接收人资格在转交日期与执行当日（租户时区）都校验，组织新版本启用日仍取转交日期。
 * 逐人兜底（第 2 轮 P3-1，同 sweepTenant）：非业务异常整人回滚、只记本轮 errors 与执行次数，不记失败原因，下轮照常重试；
 * 执行次数到上限（F-448，第 2 轮交叉审 P3-4）后按失败口径落账、不再重试。记次自身出错也只在逐人兜底这一处接住、记进
 * errors（ATTEMPT_COUNT_FAILED，F-454），不打断同租户后续被转交人；任职生效调度外层的 dueDutyTransfers 只兜整租户这一步。
 * 重试预算（F-454）：attempt_count 只会在“非业务异常且仍是到期候选”期间累计——业务失败 / 成功落账后记录不再是候选，
 * 只有菜单覆盖才会让它回到候选，而覆盖把 attempt_count 清零（service.saveRecord），所以到记次时它就是“上次覆盖以来连续
 * 非业务异常的次数”，业务失败不占预算，不必另起列。记次只记抛错的那一条（RecordRunError 带出记录 ID 与当时的 revision）；
 * 定位不到具体记录（取锁、读取等整人级步骤出错）时按整人口径：该人全部到期记录一起记次，revision 取本轮开始时的快照。
 * 覆盖并发（第 1 轮审查 P2-1）：补记在回滚之后另开事务，其间菜单覆盖可能已提交——覆盖复用记录 ID、revision 加一、预算清零，
 * 跨日请求下新记录还满足到期条件。所以记次只认“出错时的 revision”：补记锁后 revision 变了 = 已是新提交，跳过不记、不落账。
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
  readonly errors: { readonly employeeId: string | null; readonly code: string; readonly cause?: string }[];
}

/** 记次自身出错：记进本轮 errors，供任职生效调度的 onError 汇总看到（F-454，不再静默吞掉）。 */
const ATTEMPT_COUNT_FAILED = 'ATTEMPT_COUNT_FAILED';

/** 整人事务里某一条记录抛出的非业务异常：带出记录 ID 与出错时的 revision，让记次只落到真正出错的那一条（F-454，P3-2）。 */
class RecordRunError extends Error {
  constructor(
    readonly recordId: string,
    readonly revision: number,
    readonly original: unknown,
  ) {
    super('职责转交到期执行出错');
  }
}

const rootCause = (error: unknown) => (error instanceof RecordRunError ? error.original : error);

export const runErrorCode = (error: unknown) => {
  const cause = rootCause(error);
  return cause instanceof AppError || cause instanceof EmploymentError ? cause.code : 'INTERNAL_ERROR';
};

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
  const { people, snapshot } = await withTenant(db, tenant.id, async (tx) => {
    const people = rowsOf<{ employeeId: string }>(
      await tx.execute(sql`SELECT DISTINCT employee_id::text AS "employeeId" FROM duty_transfer_records
        WHERE tenant_id=${tenant.id} AND status=${DUTY_TRANSFER_STATUS.unfinished} AND failure_code IS NULL
          AND transfer_date<=${today}::date
        ORDER BY 1 LIMIT ${PEOPLE_PER_RUN}`),
    );
    return { people, snapshot: await dueRevisions(tx, tenant.id, people, today) };
  });
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
      // 记次自身出错：次数下轮再记，另记一条 errors 留痕，不再往外抛打断后续被转交人。
      const culprits =
        error instanceof RecordRunError
          ? new Map([[error.recordId, error.revision]])
          : (snapshot.get(employeeId) ?? new Map<string, number>());
      await countAttempt(db, ctx, employeeId, today, culprits).catch((countError: unknown) => {
        run.errors.push({ employeeId, code: ATTEMPT_COUNT_FAILED, cause: runErrorCode(countError) });
      });
    }
  }
  return run;
}

/**
 * 整人回滚后另开事务记执行次数与时间：未到上限不写失败原因，仍是到期候选、下轮重试；
 * 到上限的记录按既有失败口径落账（失败原因、revision、失败审计），不再是候选。
 * culprits = 应记次的记录（ID → 出错时的 revision）：单条出错只有那一条（其余到期记录整人回滚、没出过错，不占预算）；
 * 整人口径是本轮开始时该人全部到期记录。锁后 revision 与之不符 = 期间被菜单覆盖，已是新提交，不记（P2-1）。
 * 锁序（F-454，P3-3）：与菜单提交、runPerson 一样先取参与人锁（skipLocked），再锁记录行；拿不到说明菜单提交 / 联动正占着，
 * 本轮不记（errors 里已有本轮的异常，下轮再记）。选这条而不是只改按 id 排序，是因为参与人锁串行了同一被转交人的所有写入口，
 * 记录行锁之间不可能成环，同时菜单覆盖永远先于或后于一次完整的记次，不会出现读到旧 revision 就落账。
 */
async function countAttempt(
  db: Db,
  ctx: EmploymentContext,
  employeeId: string,
  today: string,
  culprits: ReadonlyMap<string, number>,
) {
  await withTenant(db, ctx.tenantId, async (tx) => {
    const subordinates = await dueSubordinates(tx, ctx, employeeId, today);
    if ((await lockTransferParticipants(tx, ctx, employeeId, subordinates, { skipLocked: true })) !== 'acquired')
      return;
    for (const record of await lockDueRecords(tx, ctx, employeeId, today)) {
      if (culprits.get(record.id) !== record.revision) continue;
      if (record.attemptCount + 1 >= MAX_ERROR_ATTEMPTS) await settle(tx, ctx, record, EXECUTION_ERROR);
      else
        await tx
          .update(dutyTransferRecords)
          .set({ attemptCount: record.attemptCount + 1, lastAttemptAt: ctx.now })
          .where(sql`tenant_id=${ctx.tenantId} AND id=${record.id}::uuid`);
    }
  });
}

/** 本轮开始时各被转交人到期记录的 revision 快照（整人级步骤出错时，记次只认这些版本）。 */
async function dueRevisions(tx: Tx, tenantId: string, people: readonly { employeeId: string }[], today: string) {
  const snapshot = new Map<string, Map<string, number>>();
  if (people.length === 0) return snapshot;
  const rows = rowsOf<{ employeeId: string; id: string; revision: number }>(
    await tx.execute(sql`SELECT employee_id::text AS "employeeId", id::text AS id, revision::int AS revision
      FROM duty_transfer_records
      WHERE tenant_id=${tenantId} AND status=${DUTY_TRANSFER_STATUS.unfinished} AND failure_code IS NULL
        AND transfer_date<=${today}::date
        AND employee_id::text IN (${sql.join(
          people.map((person) => sql`${person.employeeId}`),
          sql`, `,
        )})`),
  );
  for (const row of rows) {
    const records = snapshot.get(row.employeeId) ?? new Map<string, number>();
    records.set(row.id, row.revision);
    snapshot.set(row.employeeId, records);
  }
  return snapshot;
}

/** 该被转交人到期记录涉及的下属（参与人锁的输入）；runPerson 与 countAttempt 共用，保证两处锁的是同一批人。 */
async function dueSubordinates(tx: Tx, ctx: EmploymentContext, employeeId: string, today: string) {
  return rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT DISTINCT subordinate_id::text AS id FROM duty_transfer_records
      WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid AND subordinate_id IS NOT NULL
        AND status=${DUTY_TRANSFER_STATUS.unfinished} AND transfer_date<=${today}::date`),
  ).map((row) => row.id);
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
  const subordinates = await dueSubordinates(tx, ctx, employeeId, today);
  const lock = await lockTransferParticipants(tx, ctx, employeeId, subordinates, { skipLocked: true });
  if (lock !== 'acquired') return lock;
  // 锁后重读：等锁期间菜单可能已覆盖 / 撤回。
  const due = await lockDueRecords(tx, ctx, employeeId, today);
  const outcome = { completed: 0, failed: 0 };
  for (const record of due) {
    try {
      const failure = await attempt(tx, ctx, record, today);
      await settle(tx, ctx, record, failure);
      outcome[failure ? 'failed' : 'completed'] += 1;
    } catch (error) {
      throw new RecordRunError(record.id, record.revision, error); // 非业务异常整人回滚；带出是哪一条，记次只落它（F-454）
    }
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
