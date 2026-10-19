/**
 * 撤销离职下游清单的兼职项（docs/08_设计/R2-T05_兼职设计.md §4.6 / §4.9，BE-7 PT-6b；R2-T03 B4 的 DownstreamProbe 登记）：
 * kind = 'part-time'，追加在固定四类之后。清单两类目标，都只读：
 *   ① 被该离职结束的兼职：期限链上 source = exit 且 source_id = 离职记录的那一期，detail 带原结束日（上一期）→ L′（本期）；
 *   ② 被该离职作废、需重新发起的兼职申请：状态事件 voided / reason = exit，且与离职落地是同一条命令（同事务的钩子写入）。
 * 撤销后行为不变：不自动恢复兼职、不复活申请；HR 用编辑兼职改结束日恢复（A-4）。查不到即 none。
 * 可见性（DEC-177）沿用 exit-downstream 的任职目标口径：兼职按兼职部门，申请按申请载荷里的部门；判不出即不可见。
 */
import { sql } from '@italent/db';
import type { DownstreamProbe, DownstreamTarget } from '../exit-downstream.js';
import { rowsOf } from '../record-store.js';

export const PART_TIME_DOWNSTREAM_KIND = 'part-time';
const NO_END = null;

export const partTimeExitCancelProbe: DownstreamProbe = {
  kind: PART_TIME_DOWNSTREAM_KIND,
  async probe(tx, ctx, input) {
    const ended = rowsOf<{
      recordId: string;
      departmentId: string | null;
      originalEndDate: string | null;
      endDate: string | null;
      termNo: number;
    }>(
      await tx.execute(sql`
        SELECT t.record_id::text AS "recordId", t.term_no AS "termNo", t.end_date::text AS "endDate",
          prev.end_date::text AS "originalEndDate",
          COALESCE(latest.department_id, r.department_id)::text AS "departmentId"
        FROM employment_part_time_terms t
        JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.employee_id=t.employee_id AND r.id=t.record_id
        LEFT JOIN employment_part_time_terms prev
          ON prev.tenant_id=t.tenant_id AND prev.record_id=t.record_id AND prev.term_no=t.term_no - 1
        LEFT JOIN LATERAL (
          SELECT p.department_id FROM employment_payload_versions p
          WHERE p.tenant_id=r.tenant_id AND p.employee_id=r.employee_id AND p.business_id=r.id AND p.is_record_snapshot
          ORDER BY p.version_no DESC LIMIT 1
        ) latest ON true
        WHERE t.tenant_id=${ctx.tenantId} AND t.employee_id=${input.employeeId}::uuid
          AND t.source='exit' AND t.source_id=${input.businessId}::uuid
        ORDER BY t.record_id, t.term_no`),
    );
    const voided = rowsOf<{ requestId: string; requestType: string; departmentId: string | null }>(
      await tx.execute(sql`
        SELECT q.id::text AS "requestId", q.request_type AS "requestType", v.department_id::text AS "departmentId"
        FROM part_time_request_events e
        JOIN part_time_requests q ON q.tenant_id=e.tenant_id AND q.id=e.request_id
        JOIN part_time_request_versions v
          ON v.tenant_id=e.tenant_id AND v.request_id=e.request_id AND v.id=e.version_id
        WHERE e.tenant_id=${ctx.tenantId} AND e.employee_id=${input.employeeId}::uuid
          AND e.state='voided' AND e.reason='exit'
          AND e.command_id IN (SELECT s.command_id FROM employment_state_events s
            WHERE s.tenant_id=${ctx.tenantId} AND s.business_id=${input.businessId}::uuid AND s.state='effective')
        ORDER BY e.created_at, q.id`),
    );
    const targets: DownstreamTarget[] = [
      ...ended.map((row) => ({
        type: 'employment-record',
        id: row.recordId,
        employeeId: input.employeeId,
        departmentId: row.departmentId,
        detail: {
          effect: 'part_time_ended_by_exit',
          originalEndDate: row.originalEndDate ?? NO_END,
          endDate: row.endDate,
        },
      })),
      ...voided.map((row) => ({
        type: 'part-time-request',
        id: row.requestId,
        employeeId: input.employeeId,
        departmentId: row.departmentId,
        detail: { effect: 'part_time_request_voided_by_exit', reason: 'exit', requestType: row.requestType },
      })),
    ];
    return { status: targets.length ? 'found' : 'none', targets };
  },
};
