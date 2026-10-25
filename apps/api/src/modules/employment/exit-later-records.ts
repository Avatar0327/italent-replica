/** DEC-507：生效前检查后续非调动记录；同一候选集合中的调动交 §5.8 摘下。 */
import { sql, type Tx } from '@italent/db';
import { addDays } from '@italent/domain';
import { AppError } from '../../errors.js';
import { batchDisclose } from './exit-gate.js';
import { rowsOf, type LockedEmploymentBusiness } from './record-store.js';
import { timelinePosition } from './timeline.js';
import type { EmploymentContext } from './types.js';

export interface LaterRecord {
  readonly docId: string;
  readonly bizType: string;
  readonly effectiveDate: string;
  readonly docNo: string;
}

export async function exitFollowingRecords(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  staffId: string,
  date: string,
): Promise<LaterRecord[]> {
  const point = await timelinePosition(tx, ctx, business.employeeId, date, business.id);
  // 任职业务目前以业务 ID 作为单据引用；不另造与业务无关的编号。
  const records = rowsOf<LaterRecord>(
    await tx.execute(sql`
    SELECT r.id AS "docId", r.id::text AS "docNo", r.kind AS "bizType", t.start_date::text AS "effectiveDate"
    FROM employment_timeline t JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    WHERE t.tenant_id=${ctx.tenantId} AND t.employee_id=${business.employeeId}::uuid AND t.staff_id=${staffId}::uuid
      AND (t.start_date,t.sort_order)>=(${date}::date,${point.order}) AND r.id<>${business.id}::uuid
    ORDER BY t.start_date,t.sort_order LIMIT 1001`),
  );
  if (records.length > 1000) throw new AppError('PAYLOAD_TOO_LARGE', '后续任职记录过多，请先处理');
  return records;
}

export function exitLaterRecordMessage(lastWorkDate: string, count: number) {
  return `该员工在离职日期 ${lastWorkDate} 之后存在 ${count} 条已生效的人事记录，离职生效后这些记录会与离职状态冲突。请先处理以下记录（撤销，或将生效日期调整到离职日期之前），再重新提交离职生效。`;
}

export function assertNoLaterExitRecords(
  records: readonly LaterRecord[],
  planned: string,
  finalDate: string,
  initiatorUserId: string,
) {
  const blockers = records.filter((record) => record.bizType !== 'transfer');
  if (!blockers.length) return;
  const detail = {
    plannedEffectiveDate: planned,
    finalEffectiveDate: finalDate,
    records: blockers,
    blockers: blockers.map((row) => ({ id: row.docId, kind: row.bizType, startDate: row.effectiveDate })),
    recipientUserId: initiatorUserId,
    title: '离职暂无法生效',
    message: exitLaterRecordMessage(addDays(planned, -1), blockers.length),
    actions: ['查看记录', '关闭'],
  };
  throw new AppError('CONFLICT', detail.title, {
    reason: 'EXIT_LATER_RECORD_EXISTS',
    records: blockers,
    activationFailure: { reason: 'EXIT_LATER_RECORD_EXISTS', detail },
  });
}

/** 历史失败与命令重放都按读取人的当前权限投影；不能沿用调度时的系统可见集合。 */
export async function projectExitFailureDetails(
  tx: Tx,
  ctx: EmploymentContext,
  detail: Record<string, unknown>,
  viewable?: Pick<ReadonlySet<string>, 'has'>,
) {
  const records = (Array.isArray(detail.records) ? detail.records : []) as LaterRecord[];
  if (!records.length) return detail;
  const ids = sql.join(
    records.map((row) => sql`${row.docId}::uuid`),
    sql`, `,
  );
  const candidates = rowsOf<{ id: string; employeeId: string; departmentId: string | null; effectiveDate: string }>(
    await tx.execute(sql`
    SELECT id, employee_id AS "employeeId", department_id AS "departmentId", start_date::text AS "effectiveDate"
    FROM employment_records
    WHERE tenant_id=${ctx.tenantId} AND id IN (${ids})`),
  );
  const employeeId = candidates[0]?.employeeId;
  const shown = employeeId ? await batchDisclose(tx, ctx, employeeId, candidates) : { items: [] };
  const visible = new Set(shown.items.map((row) => row.businessId));
  const allow = (key: string) => viewable === undefined || viewable.has(key);
  const result = records
    .filter((row) => visible.has(row.docId))
    .map((row) => ({
      ...(allow('id') ? { docId: row.docId, docNo: row.docNo } : {}),
      ...(allow('kind') ? { bizType: row.bizType } : {}),
      ...(allow('effectiveDate') ? { effectiveDate: row.effectiveDate } : {}),
    }));
  return {
    title: '离职暂无法生效',
    ...(allow('lastWorkDate') ? { message: detail.message } : {}),
    records: result,
    hiddenCount: records.length - result.length,
    actions: ['查看记录', '关闭'],
  };
}
