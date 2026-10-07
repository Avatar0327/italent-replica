import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { findCurrentRecord, loadEmploymentBusiness, rowsOf } from '../employment/read-model.js';
import type { EmploymentContext, PageQuery } from '../employment/types.js';

export const employmentStatus = {
  draft: '草稿',
  in_review: '审批中',
  approved: '审批通过',
  effective: '通过',
  rejected: '已驳回',
  disapproved: '未通过',
  voided: '作废',
  deleted: '已删除',
} as const;

/** Q-M0-70：从业务链取申请、从生效时间轴取结束日；在途与作废行不会参与有效区间计算。 */
export async function ownRecords(tx: Tx, ctx: EmploymentContext, employeeId: string, page: PageQuery) {
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`
    SELECT b.id FROM employment_business_objects b
    JOIN LATERAL (SELECT state FROM employment_state_events s WHERE s.tenant_id=b.tenant_id
      AND s.business_id=b.id ORDER BY event_no DESC LIMIT 1) s ON true
    JOIN LATERAL (SELECT effective_date FROM employment_payload_versions p WHERE p.tenant_id=b.tenant_id
      AND p.business_id=b.id ORDER BY version_no DESC LIMIT 1) p ON true
    WHERE b.tenant_id=${ctx.tenantId} AND b.employee_id=${employeeId}::uuid
      AND s.state NOT IN ('draft','deleted')
    ORDER BY p.effective_date DESC,b.created_at DESC,b.id DESC LIMIT ${page.limit} OFFSET ${page.offset}
  `),
  );
  const items = [];
  for (const row of rows) {
    const business = await loadEmploymentBusiness(
      tx,
      ctx.tenantId,
      row.id,
      tenantLocalDate(ctx.now, ctx.timezone),
      ctx.scope,
    );
    if (business)
      items.push({
        id: business.id,
        kind: business.kind,
        effectiveDate: business.effectiveDate,
        stopDate: business.record?.stopDate ?? null,
        status: business.status,
        approvalStatus: employmentStatus[business.status],
        fields: business.fields,
        customFields: business.customFields,
      });
  }
  return items;
}

export function currentRecord(tx: Tx, ctx: EmploymentContext, employeeId: string) {
  return findCurrentRecord(tx, ctx.tenantId, employeeId, tenantLocalDate(ctx.now, ctx.timezone));
}

export interface OwnApplication {
  id: string;
  businessId: string;
  revision: number;
  state: string;
  createdAt: string;
  effectiveDate: string;
  departmentId: string | null;
  title: string;
  reasonCode: string | null;
  currentHandlers: string[];
}

export function applicationStatus(state: string) {
  if (state === 'approved') return '通过';
  return ['running', 'returned'].includes(state) ? '审批中' : '已终止';
}

export async function ownApplications(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  page: PageQuery,
  id?: string,
) {
  return rowsOf<OwnApplication>(
    await tx.execute(sql`
    SELECT i.id,i.business_id AS "businessId",b.revision,i.status AS state,i.created_at::text AS "createdAt",
      p.effective_date::text AS "effectiveDate",p.department_id AS "departmentId",i.title,
      tr.reason_code AS "reasonCode",
      CASE WHEN i.status IN ('running','returned') THEN ARRAY(
        SELECT DISTINCT a.display_name FROM approval_tasks t
        CROSS JOIN LATERAL tenant_member_accounts(ARRAY[t.assignee_user_id]::uuid[]) a
        WHERE t.tenant_id=i.tenant_id AND t.instance_id=i.id AND t.status='pending'
        ORDER BY a.display_name
      ) ELSE ARRAY[]::text[] END AS "currentHandlers"
    FROM approval_instances i
    JOIN employment_business_objects b ON b.tenant_id=i.tenant_id AND b.id=i.business_id
    LEFT JOIN transfer_requests tr ON tr.tenant_id=b.tenant_id AND tr.business_id=b.id
    JOIN LATERAL (SELECT effective_date,department_id FROM employment_payload_versions p
      WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id ORDER BY version_no DESC LIMIT 1) p ON true
    WHERE i.tenant_id=${ctx.tenantId} AND i.initiator_user_id=${ctx.userId}::uuid
      AND i.business_type='employment' AND b.employee_id=${employeeId}::uuid
      ${id ? sql`AND i.id=${id}::uuid` : sql``}
    ORDER BY i.created_at DESC,i.id DESC LIMIT ${page.limit} OFFSET ${page.offset}
  `),
  );
}

export async function ownApplication(tx: Tx, ctx: EmploymentContext, employeeId: string, id: string) {
  const [row] = await ownApplications(tx, ctx, employeeId, { limit: 1, offset: 0 }, id);
  if (!row) throw new AppError('NOT_FOUND', '申请不存在');
  return row;
}
