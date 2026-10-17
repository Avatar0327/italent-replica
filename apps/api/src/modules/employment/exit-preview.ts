/**
 * 离职预览（R2-T03 设计 §4 preview 行）：只读给出按这个最后工作日创建时会遇到的情况，不抛业务拒绝、不写任何数据。
 * - blockers：创建会被拒的原因（未办结离职 / §8A 逾期迟到调动 / §8B 转正在途）；
 * - ack：§8 在途调动确认清单与令牌（创建时带回 exit.pendingTransferAck）；
 * - warnings：生效时将被作废的在途任职申请（DEC-496①）、已落地且晚于最后工作日的直接调动（DEC-263②）；
 * - contracts：合同影响的件数（将终止 / 将删除 / 将撤回的在途合同申请，口径同 contracts/ports.ts handleContractsOnExit，
 *   在途申请不按日期过滤，DEC-496①）。
 * 清单逐项按 DEC-177 可见性与字段查看权裁剪（disclose），不可见的只计件数；合同只给件数。
 */
import { sql, type Tx } from '@italent/db';
import { dayAfter } from './fields.js';
import {
  disclose,
  inFlightApplications,
  leavesInProgress,
  overdueTransferBlocker,
  pendingTransferAckSet,
  regularizationBlocker,
  type InFlight,
} from './exit-gate.js';
import { settings as contractSettings } from '../contracts/configuration.js';
import { rowsOf } from './record-store.js';
import { BUSINESS_KINDS, type EmploymentContext } from './types.js';

const OPEN_STATES = ['draft', 'in_review', 'approved', 'rejected'];
const VOIDABLE_KINDS = BUSINESS_KINDS.filter((kind) => kind !== 'leave' && kind !== 'retirement');

const asRows = (rows: readonly InFlight[], date: (row: InFlight) => string = (row) => row.planned) =>
  rows.map((row) => ({ id: row.id, effectiveDate: date(row), departmentId: row.departmentId }));

async function contractImpact(tx: Tx, ctx: EmploymentContext, employeeId: string, lastWorkDate: string) {
  const kept = `{${(await contractSettings(tx, ctx.tenantId)).postExitTypeIds.join(',')}}`;
  const mine = (alias: string) =>
    sql`${sql.raw(alias)}.tenant_id=${ctx.tenantId} AND ${sql.raw(alias)}.employee_id=${employeeId}::uuid
      AND ${sql.raw(alias)}.type_id <> ALL(${kept}::uuid[])`;
  const live = sql`${mine('r')} AND NOT r.deleted AND r.status<>'void'`;
  const [row] = rowsOf<{ terminate: number; delete: number; withdrawRequests: number }>(
    await tx.execute(sql`SELECT
      (SELECT count(*)::int FROM contract_records r WHERE ${live} AND r.effective_date <= ${lastWorkDate}::date
        AND r.status='valid' AND (r.end_date IS NULL OR r.end_date > ${lastWorkDate}::date)) AS terminate,
      (SELECT count(*)::int FROM contract_records r
        WHERE ${live} AND r.effective_date > ${lastWorkDate}::date) AS delete,
      (SELECT count(*)::int FROM contract_requests q WHERE ${mine('q')}
        AND q.status IN ('approved','in_review','returned')) AS "withdrawRequests"`),
  );
  return { terminate: row?.terminate ?? 0, delete: row?.delete ?? 0, withdrawRequests: row?.withdrawRequests ?? 0 };
}

export async function previewExit(tx: Tx, ctx: EmploymentContext, employeeId: string, lastWorkDate: string) {
  const blockers = [];
  const leaves = await leavesInProgress(tx, ctx, employeeId);
  if (leaves.length)
    blockers.push({ reason: 'EXIT_IN_PROGRESS', ...(await disclose(tx, ctx, employeeId, asRows(leaves))) });
  const overdue = await overdueTransferBlocker(tx, ctx, employeeId);
  if (overdue) blockers.push({ reason: 'EXIT_LATE_TRANSFER_PENDING', ...overdue });
  const regularization = await regularizationBlocker(tx, ctx, employeeId, lastWorkDate);
  if (regularization) blockers.push({ reason: 'EXIT_REGULARIZATION_IN_FLIGHT', ...regularization });
  const set = await pendingTransferAckSet(tx, ctx, employeeId, lastWorkDate);
  const open = await inFlightApplications(tx, ctx, employeeId, VOIDABLE_KINDS, OPEN_STATES);
  // 已批准且计划生效日 ≤ 最后工作日的申请会先于离职落地（§5.0 队列），不在作废之列
  const voided = open.filter((row) => !row.landed && (row.state !== 'approved' || row.planned > lastWorkDate));
  const landed = (await inFlightApplications(tx, ctx, employeeId, ['transfer'], ['effective'], null)).filter(
    (row) => row.landed && row.effectiveDate > lastWorkDate,
  );
  return {
    lastWorkDate,
    effectiveDate: dayAfter(lastWorkDate),
    blockers,
    ack: set ? { ackToken: set.hash, ...(await disclose(tx, ctx, employeeId, set.rows)) } : null,
    warnings: [
      { reason: 'EXIT_APPLICATIONS_TO_VOID', ...(await disclose(tx, ctx, employeeId, asRows(voided))) },
      {
        reason: 'EXIT_FUTURE_TRANSFER_LANDED',
        ...(await disclose(
          tx,
          ctx,
          employeeId,
          asRows(landed, (row) => row.effectiveDate),
        )),
      },
    ],
    contracts: await contractImpact(tx, ctx, employeeId, lastWorkDate),
  };
}
