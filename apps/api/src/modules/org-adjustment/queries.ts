/**
 * 组织调整列表与头投影（R2-T08 §10 路由 12、§4.5；BE-10d）。
 * 列表：对象查看权（路由层）→ 审批主体组织按 OrganizationApproval 范围在 SQL 里过滤 → 再计数与分页（总数不越权）；
 * 筛选的主体组织在范围外时与不存在的组织同样返回空，不泄露是否存在；没有范围时谓词为 false（fail-closed）。
 * 各列按字段查看权投影，派生列跟随源字段（主体组织名跟 approvalSubjectOrgId、申请人姓名跟 createdBy、文案跟状态）；
 * 组织名一律按单据生效日取。
 */
import { isUuid, sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import {
  ORG_ADJUSTMENT_APPROVAL_STATUS_LABELS,
  ORG_ADJUSTMENT_EXECUTION_STATUS_LABELS,
  statusFilterApprovalStatus,
  type OrgAdjustmentApprovalStatus,
  type OrgAdjustmentExecutionStatus,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import { rowsOf, validIsoDate } from '../org/read-model.js';
import { scopeSql, type ModuleScope } from '../permission/module-access.js';
import { canSee } from './disclosure.js';

export interface HeadRow {
  readonly id: string;
  readonly code: string;
  readonly subject: string;
  readonly effectiveDate: string;
  readonly content: string | null;
  readonly approvalSubjectOrgId: string;
  readonly approvalSubjectOrgName: string | null;
  readonly approvalStatus: OrgAdjustmentApprovalStatus;
  readonly executionStatus: OrgAdjustmentExecutionStatus;
  readonly executionNote: string | null;
  readonly dataVolume: number | null;
  readonly successCount: number | null;
  readonly failureCount: number | null;
  readonly approvedAt: string | null;
  readonly executedAt: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly revision: number;
}

export interface ListFilter {
  readonly approvalSubjectOrgId?: string;
  readonly effectiveFrom?: string;
  readonly effectiveTo?: string;
  readonly approvalStatus?: OrgAdjustmentApprovalStatus;
}

const utcText = (column: SQL) => sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** 组织在某日的名称：取当日生效版本；当日尚未生效时取首版（与组织结果授权同序）。 */
export function orgNameAt(tenantId: string, orgId: SQL, date: SQL): SQL {
  return sql`(SELECT v.name FROM org_versions v WHERE v.tenant_id = ${tenantId} AND v.org_id = ${orgId}
    ORDER BY (v.start_date <= ${date}) DESC, CASE WHEN v.start_date <= ${date} THEN v.start_date END DESC,
      v.start_date ASC, v.version_no DESC LIMIT 1)`;
}

const uuidArray = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

/** 一批组织在 date 的名称。 */
export async function orgNamesAt(tx: Tx, tenantId: string, orgIds: readonly string[], date: string) {
  const ids = [...new Set(orgIds)];
  if (!ids.length) return new Map<string, string>();
  const rows = rowsOf<{ id: string; name: string | null }>(
    await tx.execute(sql`SELECT o.id::text AS id, ${orgNameAt(tenantId, sql`o.id`, sql`${date}::date`)} AS name
      FROM unnest(${uuidArray(ids)}) AS o(id)`),
  );
  return new Map(rows.flatMap((row) => (row.name === null ? [] : [[row.id, row.name] as const])));
}

/** 成员显示名（申请人列）。 */
async function memberNames(tx: Tx, userIds: readonly string[]) {
  const ids = [...new Set(userIds)];
  if (!ids.length) return new Map<string, string>();
  const rows = rowsOf<{ id: string; name: string | null }>(
    await tx.execute(sql`SELECT account_id::text AS id, display_name AS name
      FROM tenant_member_accounts(${uuidArray(ids)})`),
  );
  return new Map(rows.flatMap((row) => (row.name ? [[row.id, row.name] as const] : [])));
}

const HEAD_SELECT = (tenantId: string) => sql`
  a.id, a.code, a.subject, a.effective_date::text AS "effectiveDate", a.content,
  a.approval_subject_org_id AS "approvalSubjectOrgId",
  ${orgNameAt(tenantId, sql`a.approval_subject_org_id`, sql`a.effective_date`)} AS "approvalSubjectOrgName",
  a.approval_status AS "approvalStatus", a.execution_status AS "executionStatus", a.execution_note AS "executionNote",
  a.data_volume AS "dataVolume", a.success_count AS "successCount", a.failure_count AS "failureCount",
  ${utcText(sql`a.approved_at`)} AS "approvedAt", ${utcText(sql`a.executed_at`)} AS "executedAt",
  a.created_by AS "createdBy", ${utcText(sql`a.created_at`)} AS "createdAt", a.revision`;

/** 解析列表筛选：非法值 400；状态取 8 项编码（DEC-526④）。 */
export function parseListFilter(query: (name: string) => string | undefined): ListFilter {
  const filter: { -readonly [K in keyof ListFilter]: ListFilter[K] } = {};
  const subject = query('approvalSubjectOrgId');
  if (subject !== undefined) {
    if (!isUuid(subject)) throw new AppError('VALIDATION_FAILED', 'approvalSubjectOrgId 必须为 UUID');
    filter.approvalSubjectOrgId = subject.toLowerCase();
  }
  for (const key of ['effectiveFrom', 'effectiveTo'] as const) {
    const value = query(key);
    if (value === undefined) continue;
    if (!validIsoDate(value)) throw new AppError('VALIDATION_FAILED', `${key} 必须为合法 YYYY-MM-DD`);
    filter[key] = value;
  }
  const status = query('approvalStatus');
  if (status !== undefined) {
    const value = statusFilterApprovalStatus(status);
    if (value === null) throw new AppError('VALIDATION_FAILED', 'approvalStatus 不是可选的审批状态');
    filter.approvalStatus = value;
  }
  return filter;
}

function filterSql(filter: ListFilter): SQL[] {
  const terms: SQL[] = [];
  if (filter.approvalSubjectOrgId) terms.push(sql`a.approval_subject_org_id = ${filter.approvalSubjectOrgId}::uuid`);
  if (filter.effectiveFrom) terms.push(sql`a.effective_date >= ${filter.effectiveFrom}::date`);
  if (filter.effectiveTo) terms.push(sql`a.effective_date <= ${filter.effectiveTo}::date`);
  if (filter.approvalStatus !== undefined) terms.push(sql`a.approval_status = ${filter.approvalStatus}`);
  return terms;
}

/** 列表：范围谓词与筛选都在 LIMIT 之前；按创建时间倒序（同刻按 id）。 */
export async function listAdjustments(
  tx: Tx,
  tenantId: string,
  scope: ModuleScope,
  filter: ListFilter,
  page: { readonly limit: number; readonly offset: number },
) {
  const where = sql.join(
    [sql`a.tenant_id = ${tenantId}`, scopeSql(scope, { org: sql`a.approval_subject_org_id` }), ...filterSql(filter)],
    sql` AND `,
  );
  const [count] = rowsOf<{ n: number }>(
    await tx.execute(sql`SELECT count(*)::int AS n FROM org_adjustments a WHERE ${where}`),
  );
  const rows = rowsOf<HeadRow>(
    await tx.execute(sql`SELECT ${HEAD_SELECT(tenantId)} FROM org_adjustments a WHERE ${where}
      ORDER BY a.created_at DESC, a.id DESC LIMIT ${page.limit} OFFSET ${page.offset}`),
  );
  return { rows, total: count?.n ?? 0 };
}

export async function loadHead(tx: Tx, tenantId: string, id: string): Promise<HeadRow | undefined> {
  const [row] = rowsOf<HeadRow>(
    await tx.execute(sql`SELECT ${HEAD_SELECT(tenantId)} FROM org_adjustments a
      WHERE a.tenant_id = ${tenantId} AND a.id = ${id}`),
  );
  return row;
}

export interface RangeOrg {
  readonly orgId: string;
  readonly name: string | null;
  readonly label: string | null;
}

/** 调整范围列：按选择顺序，名称按单据生效日，文案“组织名（包含下级）”（F273A §4）。 */
async function rangesOf(tx: Tx, tenantId: string, ids: readonly string[]) {
  const ranges = new Map<string, RangeOrg[]>();
  if (!ids.length) return ranges;
  const rows = rowsOf<{ adjustmentId: string; orgId: string; name: string | null }>(
    await tx.execute(sql`SELECT r.adjustment_id AS "adjustmentId", r.org_id AS "orgId",
        ${orgNameAt(tenantId, sql`r.org_id`, sql`a.effective_date`)} AS name
      FROM org_adjustment_range_orgs r
      JOIN org_adjustments a ON a.tenant_id = r.tenant_id AND a.id = r.adjustment_id
      WHERE r.tenant_id = ${tenantId} AND r.adjustment_id = ANY(${uuidArray(ids)})
      ORDER BY r.adjustment_id, r.seq`),
  );
  for (const row of rows) {
    const label = row.name === null ? null : `${row.name}（包含下级）`;
    ranges.set(row.adjustmentId, [
      ...(ranges.get(row.adjustmentId) ?? []),
      { orgId: row.orgId, name: row.name, label },
    ]);
  }
  return ranges;
}

type Fields = ReadonlySet<string> | undefined;

/** 头列投影：每个源字段连同它的派生列一起出现或一起隐去。 */
export async function projectHeads(tx: Tx, tenantId: string, rows: readonly HeadRow[], fields: Fields) {
  const ranges = canSee(fields, 'adjustmentRange')
    ? await rangesOf(
        tx,
        tenantId,
        rows.map((row) => row.id),
      )
    : null;
  const names = canSee(fields, 'createdBy')
    ? await memberNames(
        tx,
        rows.map((row) => row.createdBy),
      )
    : null;
  return rows.map((row) => {
    const out: Record<string, unknown> = { id: row.id };
    const put = (code: string, values: Record<string, unknown>) => {
      if (canSee(fields, code)) Object.assign(out, values);
    };
    put('code', { code: row.code });
    put('subject', { subject: row.subject });
    put('effectiveDate', { effectiveDate: row.effectiveDate });
    put('content', { content: row.content });
    put('approvalSubjectOrgId', {
      approvalSubjectOrgId: row.approvalSubjectOrgId,
      approvalSubjectOrgName: row.approvalSubjectOrgName,
    });
    if (ranges) out.adjustmentRange = ranges.get(row.id) ?? [];
    put('approvalStatus', {
      approvalStatus: row.approvalStatus,
      approvalStatusLabel: ORG_ADJUSTMENT_APPROVAL_STATUS_LABELS[row.approvalStatus] ?? null,
    });
    put('executionStatus', {
      executionStatus: row.executionStatus,
      executionStatusLabel: ORG_ADJUSTMENT_EXECUTION_STATUS_LABELS[row.executionStatus] ?? null,
    });
    put('executionNote', { executionNote: row.executionNote });
    for (const key of ['dataVolume', 'successCount', 'failureCount', 'approvedAt', 'executedAt'] as const) {
      put(key, { [key]: row[key] });
    }
    if (names) Object.assign(out, { createdBy: row.createdBy, createdByName: names.get(row.createdBy) ?? null });
    put('createdAt', { createdAt: row.createdAt });
    return out;
  });
}

/** 列表行只要头列（§4.5“列表只返回头字段”）：去掉详情才有的说明与执行计数。 */
export function listColumns(row: Record<string, unknown>) {
  const { content, dataVolume, successCount, failureCount, approvedAt, executedAt, ...rest } = row;
  void [content, dataVolume, successCount, failureCount, approvedAt, executedAt];
  return rest;
}
