/**
 * 入职四视图查询（R2 BE-2b；docs/02_业务建模/34 EN-R1，DEC-484② / F-129）：
 * 全部待入职（入职状态 ≠ 取消）、今日待入职（入职日 = 租户今天）、已取消入职、已入职。
 * 视图按“当前待入职记录”取数：改期会替换记录（BE-2a），所以只认任职时间轴上现存的入职类记录，不看旧记录 ID。
 * 状态只读记录自己的版本快照（employment_record_status），不用员工当前状态——已调出 / 离职的人不影响他入职那条记录归属。
 */
import { sql, type Tx } from '@italent/db';
import { EMPLOYEE_STATUS, ENTRY_STATUS, type EmployeeStatusCode, type EntryStatusCode } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { employmentCreator, employmentScopePredicate } from './context.js';
import { ENTRY_KINDS } from './employee-status.js';
import { personnelHooks } from './personnel-hooks.js';
import { checkPage, rowsOf } from './read-model.js';
import type { BusinessKind, EmploymentScope, PageQuery } from './types.js';

export const ENTRY_VIEWS = ['all', 'today', 'cancelled', 'hired'] as const;
export type EntryView = (typeof ENTRY_VIEWS)[number];

export interface EntryViewItem {
  /** 入职类业务 / 任职记录 ID（同一个 ID）；改期后是新记录的 ID。 */
  readonly id: string;
  readonly employeeId: string;
  readonly code: string;
  readonly name: string;
  readonly kind: BusinessKind;
  readonly effectiveDate: string;
  readonly employeeStatus: EmployeeStatusCode;
  readonly entryStatus: EntryStatusCode | null;
  readonly departmentId: string | null;
  /** 业务 revision：取消 / 改期 / 编辑 / 办理 / 删除路由的 If-Match。 */
  readonly revision: number;
  /** 待入职阶段填写的“是否有试用期”（F-188）；没填过为 null。前端编辑弹窗与办理入职表单据此预填。 */
  readonly probation: boolean | null;
  /** 待入职合同起止日（F-194，entry-pending-contract.ts）；存量待入职、已办理入职没有合同为 null。前端用于“合同生效日期”列与办理入职预填。 */
  readonly contractStartDate: string | null;
  readonly contractEndDate: string | null;
  /**
   * 取消说明（F-206，DEC-560）：本条记录最近一次 cancel 动作日志的 remark；没取消过 / 没填说明为 null。
   * 改期恢复会换新记录 ID，新记录不继承旧说明；恢复后再取消读到的是新记录上的那次。行可见即可见，不另做字段权限。
   */
  readonly cancelRemark: string | null;
}

function viewPredicate(view: EntryView, today: string): SQL {
  const pending = sql`s.employee_status=${EMPLOYEE_STATUS.pendingEntry}`;
  switch (view) {
    case 'all':
      return sql`${pending} AND s.entry_status IS DISTINCT FROM ${ENTRY_STATUS.cancelled}`;
    case 'today':
      return sql`${pending} AND s.entry_status IS DISTINCT FROM ${ENTRY_STATUS.cancelled}
        AND t.start_date=${today}::date`;
    case 'cancelled':
      return sql`${pending} AND s.entry_status=${ENTRY_STATUS.cancelled}`;
    case 'hired':
      return sql`s.employee_status<>${EMPLOYEE_STATUS.pendingEntry}`;
  }
}

export async function listEntryView(
  tx: Tx,
  tenantId: string,
  input: { readonly view: EntryView; readonly today: string; readonly page: PageQuery },
  scope: EmploymentScope | undefined,
): Promise<EntryViewItem[]> {
  checkPage(input.page);
  const department = sql`COALESCE(snap.department_id, r.department_id)`;
  const visible = employmentScopePredicate(
    scope,
    sql`r.employee_id`,
    department,
    employmentCreator(tenantId, sql`r.id`, true),
  );
  return rowsOf<EntryViewItem>(
    await tx.execute(sql`
    SELECT r.id, r.employee_id AS "employeeId", e.code,
      ${personnelHooks.currentName(tenantId, sql`e.id`, sql`e.name`)} AS name,
      r.kind, t.start_date::text AS "effectiveDate",
      s.employee_status::integer AS "employeeStatus", s.entry_status::integer AS "entryStatus",
      ${department} AS "departmentId", b.revision, pp.probation,
      pc.start_date::text AS "contractStartDate", pc.end_date::text AS "contractEndDate",
      cancel.remark AS "cancelRemark"
    FROM employment_records r
    JOIN employment_timeline t ON t.tenant_id=r.tenant_id AND t.record_id=r.id
    JOIN employment_business_objects b ON b.tenant_id=r.tenant_id AND b.id=r.id
    JOIN employment_employees e ON e.tenant_id=r.tenant_id AND e.id=r.employee_id
    LEFT JOIN employment_pending_entry_probation pp ON pp.tenant_id=r.tenant_id AND pp.business_id=r.id
    LEFT JOIN employment_pending_entry_contract pc ON pc.tenant_id=r.tenant_id AND pc.business_id=r.id
    LEFT JOIN LATERAL employment_record_status(r.tenant_id, r.id) s ON true
    LEFT JOIN LATERAL (SELECT CASE WHEN btrim(a.remark)='' THEN NULL ELSE a.remark END AS remark
      FROM employment_entry_actions a
      WHERE a.tenant_id=r.tenant_id AND a.business_id=r.id AND a.action='cancel'
      ORDER BY a.created_at DESC, a.id DESC LIMIT 1) cancel ON true
    LEFT JOIN LATERAL (SELECT p.department_id FROM employment_payload_versions p
      WHERE p.tenant_id=r.tenant_id AND p.business_id=r.id AND p.is_record_snapshot
      ORDER BY p.version_no DESC LIMIT 1) snap ON true
    WHERE r.tenant_id=${tenantId} AND r.kind IN (${sql.join(
      ENTRY_KINDS.map((kind) => sql`${kind}`),
      sql`, `,
    )})
      AND ${viewPredicate(input.view, input.today)} AND ${visible}
    ORDER BY t.start_date, r.id LIMIT ${input.page.limit} OFFSET ${input.page.offset}
  `),
  );
}
