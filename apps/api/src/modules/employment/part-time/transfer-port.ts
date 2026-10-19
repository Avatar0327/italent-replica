/**
 * 调动联动端口的兼职实现（docs/08_设计/R2-T05_兼职设计.md §4.7，AC-LNK-06）：调动表单“兼职调整”区勾选的兼职，在调动实际生效日
 * 的前一天结束（#71、R2d、R2f 三次一致）。由 install.ts 在 createApp 装配时登记，替换 transfer/linkage/part-time.ts 的缺省实现。
 * - exists：属于该员工、非主职、进行中（开始日 ≤ 今天，结束日为空或 ≥ 今天；原站只列当前进行中的兼职，未来开始的不在列表，
 *   Q-M0-121⑥），且操作人按 DEC-177 可见；不存在 / 不可见 / 非进行中不区分原因；
 * - listOngoing：同一口径列出进行中的兼职，不可见的只计件数；
 * - end：与离职钩子同一条缩短规则（partTimeCutoffEnd），追加的期限 source = transfer、source_id = 联动子项，作废该记录上未办结的
 *   延长 / 结束申请（reason = transfer）。调用方（联动子项执行）已持有员工行锁；锁序：兼职记录头 → 申请头 → 审批实例（§7.1）。
 */
import { sql, type Tx } from '@italent/db';
import {
  PART_TIME_AUDIT_OBJECTS,
  PART_TIME_KIND,
  PART_TIME_NOTICE_TEMPLATES,
  partTimeCutoffEnd,
} from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import type { OngoingPartTime, TransferPartTimePort } from '../../transfer/linkage/part-time.js';
import { auditEmployment } from '../context.js';
import { rowsOf } from '../record-store.js';
import type { EmploymentContext } from '../types.js';
import {
  PART_TIME_DEPARTMENT,
  PART_TIME_END,
  PART_TIME_POSITION,
  PART_TIME_START,
  partTimeFrom,
  partTimeNotFound,
  partTimeToday,
  partTimeVisible,
} from './read.js';
import { lockOpenInstances, lockOpenRequests } from './request-store.js';
import { voidPartTimeRequest } from './request-service.js';
import { partTimeCurrentSql } from './span-sql.js';
import { appendPartTimeTerm, lockPartTimeRecords } from './store.js';

/** asOf 当日进行中：开始日 ≤ asOf，结束日为空或 ≥ asOf（空区间 end < start 自然不满足）。 */
const ongoingSql = (asOf: string): SQL => partTimeCurrentSql(PART_TIME_START, PART_TIME_END, asOf);

async function exists(tx: Tx, ctx: EmploymentContext, input: { employeeId: string; recordId: string }) {
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`
      SELECT r.id ${partTimeFrom(ctx)}
      WHERE r.tenant_id=${ctx.tenantId} AND r.id=${input.recordId}::uuid AND r.employee_id=${input.employeeId}::uuid
        AND r.service_type <> 'primary' AND r.kind=${PART_TIME_KIND}
        AND ${ongoingSql(partTimeToday(ctx))} AND ${partTimeVisible(ctx)}
    `),
  );
  return rows.length > 0;
}

async function listOngoing(tx: Tx, ctx: EmploymentContext, employeeId: string, asOf: string) {
  const rows = rowsOf<OngoingPartTime & { visible: boolean }>(
    await tx.execute(sql`
      SELECT r.id, r.service_type AS "serviceType", r.start_date::text AS "startDate", cur.end_date::text AS "endDate",
        ${PART_TIME_DEPARTMENT} AS "departmentId", ${PART_TIME_POSITION} AS "positionId",
        ${partTimeVisible(ctx)} AS visible
      ${partTimeFrom(ctx)}
      WHERE r.tenant_id=${ctx.tenantId} AND r.employee_id=${employeeId}::uuid
        AND r.service_type <> 'primary' AND r.kind=${PART_TIME_KIND} AND ${ongoingSql(asOf)}
      ORDER BY r.start_date, r.id
    `),
  );
  return {
    items: rows.filter((row) => row.visible).map(({ visible: _visible, ...item }) => item),
    hiddenCount: rows.filter((row) => !row.visible).length,
  };
}

/** 作废以该兼职为目标的未办结延长 / 结束申请（单一入口 voidPartTimeRequest，同离职钩子）。 */
async function voidRequestsByTransfer(tx: Tx, ctx: EmploymentContext, employeeId: string, recordId: string) {
  const requests = await lockOpenRequests(tx, ctx, employeeId, recordId);
  await lockOpenInstances(tx, ctx, requests);
  for (const request of requests)
    await voidPartTimeRequest(tx, ctx, request, {
      reason: 'transfer',
      action: 'part_time.request.voided_by_transfer',
      template: PART_TIME_NOTICE_TEMPLATES.voided,
    });
}

async function end(
  tx: Tx,
  ctx: EmploymentContext,
  input: { employeeId: string; recordId: string; endDate: string; itemId: string },
) {
  const [record] = await lockPartTimeRecords(tx, ctx, input.employeeId, { ids: [input.recordId] });
  if (!record) throw partTimeNotFound();
  // 当前结束日不晚于失效日 → null，幂等成功（S4）；开始日晚于失效日 → 空区间（end = 开始日 − 1，S5）
  const endDate = partTimeCutoffEnd(record, input.endDate);
  if (endDate !== null) {
    const next = await appendPartTimeTerm(tx, ctx, record, { endDate, source: 'transfer', sourceId: input.itemId });
    await auditEmployment(
      tx,
      ctx,
      'employment.part_time.ended_by_transfer',
      PART_TIME_AUDIT_OBJECTS.record,
      record.id,
      { endDate: record.endDate },
      { endDate, termNo: next.termNo },
      undefined,
      { transferLinkageItemId: input.itemId },
      { employeeId: record.employeeId, orgId: record.departmentId },
    );
  }
  // 无论是否追加期限：已被调动结束的兼职不应再被在途申请延长
  await voidRequestsByTransfer(tx, ctx, input.employeeId, record.id);
}

/** 模块级单例：createApp 多次装配登记同一实例（§4.9）。 */
export const PART_TIME_TRANSFER_PORT: TransferPartTimePort = { exists, end, listOngoing };
