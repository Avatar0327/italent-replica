import { and, eq, sql, contractRecords, contractRequests, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { scopeSql } from '../permission/module-access.js';
import { rowsOf, type ContractContext } from './context.js';
import { settings } from './configuration.js';
export async function listContracts(
  tx: Tx,
  ctx: ContractContext,
  view: string,
  limit: number,
  offset: number,
  expiringDays = 0,
) {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const config = await settings(tx, ctx.tenantId);
  if (view === 'all') return allContracts(tx, ctx, limit, offset);
  if (view === 'in_review') {
    const scope = ctx.scope
      ? scopeSql(ctx.scope, { person: sql`contract_requests.employee_id`, creator: sql`contract_requests.created_by` })
      : sql`true`;
    return tx
      .select()
      .from(contractRequests)
      .where(and(eq(contractRequests.tenantId, ctx.tenantId), eq(contractRequests.status, 'in_review'), scope))
      .orderBy(contractRequests.id)
      .limit(limit)
      .offset(offset);
  }
  if (view === 'missing') {
    const scope = ctx.scope ? scopeSql(ctx.scope, { person: sql`e.id` }) : sql`true`;
    return rowsOf(
      await tx.execute(sql`SELECT e.id AS "employeeId",e.code,e.name FROM employment_employees e
      WHERE e.tenant_id=${ctx.tenantId} AND ${scope}
      AND (SELECT r.kind FROM employment_records r WHERE r.tenant_id=e.tenant_id AND r.employee_id=e.id
        AND r.start_date<=${today}::date ORDER BY r.start_date DESC,r.created_at DESC,r.id DESC LIMIT 1)
        NOT IN ('leave','retirement')
      AND NOT EXISTS (SELECT 1 FROM contract_records c WHERE c.tenant_id=e.tenant_id AND c.employee_id=e.id
        AND NOT c.deleted AND c.status='valid' AND c.approval_status='effective' AND c.effective_date<=${today}::date
        AND (c.end_date IS NULL OR c.end_date>=${today}::date)) ORDER BY e.id LIMIT ${limit} OFFSET ${offset}`),
    );
  }
  const scope = ctx.scope
    ? scopeSql(ctx.scope, { person: sql`contract_records.employee_id`, creator: sql`contract_records.created_by` })
    : sql`true`;
  const c = contractRecords;
  let filter = sql`true`;
  if (view === 'valid')
    filter = sql`${c.status}='valid' AND ${c.effectiveDate}<=${today}::date
    AND (${c.endDate} IS NULL OR ${c.endDate}>=${today}::date)`;
  if (view === 'expiring')
    filter = sql`${c.status}='valid' AND ${c.endDate} BETWEEN ${today}::date AND ${today}::date+${expiringDays}`;
  if (view === 'expired_unrenewed') {
    filter = sql`${c.status}<>'void' AND ${c.endDate}<${today}::date
      AND (${c.actualTerminationDate} IS NULL OR ${c.actualTerminationDate}>=${c.endDate})
      AND NOT EXISTS (SELECT 1 FROM contract_changes change
        WHERE change.tenant_id=${c.tenantId} AND change.before_contract_id=${c.id})
      AND NOT EXISTS (
      SELECT 1 FROM contract_records next WHERE next.tenant_id=${c.tenantId} AND next.employee_id=${c.employeeId}
        AND NOT next.deleted AND next.status<>'void' AND next.approval_status='effective'
        AND next.effective_date=${c.endDate}+1 AND (next.type_id=${c.typeId} OR
          (next.type_id::text=ANY(${`{${config.renewalTypeIds.join(',')}}`}::text[])
        AND ${c.typeId}::text=ANY(${`{${config.renewalTypeIds.join(',')}}`}::text[]))))`;
  }
  return tx
    .select()
    .from(c)
    .where(and(eq(c.tenantId, ctx.tenantId), eq(c.deleted, false), scope, filter))
    .orderBy(c.effectiveDate, c.id)
    .limit(limit)
    .offset(offset);
}

/** 全部视图同时包含未生效申请；申请与生效版本分别标识，分页前对两侧应用同一范围。 */
async function allContracts(tx: Tx, ctx: ContractContext, limit: number, offset: number) {
  const recordScope = ctx.scope
    ? scopeSql(ctx.scope, { person: sql`c.employee_id`, creator: sql`c.created_by` })
    : sql`true`;
  const requestScope = ctx.scope
    ? scopeSql(ctx.scope, { person: sql`r.employee_id`, creator: sql`r.created_by` })
    : sql`true`;
  const rows = rowsOf<{ value: Record<string, unknown> }>(
    await tx.execute(sql`
    SELECT value FROM (
      SELECT to_jsonb(c)||jsonb_build_object('row_type','contract') AS value,c.effective_date,c.id
        FROM contract_records c WHERE c.tenant_id=${ctx.tenantId} AND NOT c.deleted AND ${recordScope}
      UNION ALL
      SELECT to_jsonb(r)||jsonb_build_object('row_type','request','approval_status',r.status) AS value,
        r.effective_date,r.id
        FROM contract_requests r WHERE r.tenant_id=${ctx.tenantId}
          AND r.status IN ('approved','in_review','returned') AND ${requestScope}
    ) combined ORDER BY effective_date,id LIMIT ${limit} OFFSET ${offset}`),
  );
  return rows.map(({ value }) =>
    Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase()),
        item,
      ]),
    ),
  );
}
