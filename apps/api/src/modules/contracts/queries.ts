import { and, eq, sql, contractRecords, contractRequests, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { employmentVisibilitySql } from '../employment/visibility.js';
import { rowsOf, type ContractContext } from './context.js';
import { settings } from './configuration.js';
import { applicableQuery, filterPredicate, orderClause, resolveOrgIds, type ListQuery } from './list-query.js';

export interface ListResult {
  items: unknown[];
  total: number;
}

/** 主职当前任职的摘要列（部门、职务 / 职位、工作地点、入职日期）；与 currentPersons 同口径取最新生效快照。 */
export function currentPrimarySummary(tenantId: string, asOf: string): SQL {
  return sql`
    SELECT r.employee_id,r.kind,r.entry_date::text AS entry_date,
      CASE WHEN p.id IS NULL THEN r.department_id ELSE p.department_id END AS department_id,
      CASE WHEN p.id IS NULL THEN r.position_id ELSE p.position_id END AS position_id,
      CASE WHEN p.id IS NULL THEN r.post_id ELSE p.post_id END AS post_id,
      CASE WHEN p.id IS NULL THEN r.place ELSE p.place END AS place
    FROM employment_timeline t JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    LEFT JOIN LATERAL (SELECT p.id,p.department_id,p.position_id,p.post_id,p.place
      FROM employment_payload_versions p WHERE p.tenant_id=r.tenant_id AND p.business_id=r.id
        AND p.employee_id=r.employee_id AND p.is_record_snapshot ORDER BY p.version_no DESC LIMIT 1) p ON true
    WHERE t.tenant_id=${tenantId} AND t.valid_during @> ${asOf}::date AND r.service_type='primary'
  `;
}

/** 下一份合同已接上（同员工、同类型或同属续签类型、生效日为本合同终止日次日）。 */
function successorExists(
  c: { tenantId: SQL; employeeId: SQL; typeId: SQL; endDate: SQL },
  renewalTypes: string[],
  asOf?: string,
) {
  const types = `{${renewalTypes.join(',')}}`;
  // 给出 asOf（人事看板的时点口径）：后续合同在 asOf 当天或之前已生效才算接上；不给（合同列表）按当前
  const reached = asOf ? sql`AND next.effective_date<=${asOf}::date` : sql``;
  return sql`EXISTS (SELECT 1 FROM contract_records next WHERE next.tenant_id=${c.tenantId}
    AND next.employee_id=${c.employeeId} AND NOT next.deleted AND next.status<>'void'
    AND next.approval_status='effective' AND next.effective_date=${c.endDate}+1 ${reached}
    AND (next.type_id=${c.typeId} OR (next.type_id::text=ANY(${types}::text[])
      AND ${c.typeId}::text=ANY(${types}::text[]))))`;
}

export async function listContracts(
  tx: Tx,
  ctx: ContractContext,
  requested: ListQuery,
  limit: number,
  offset: number,
): Promise<ListResult> {
  const query = applicableQuery(requested);
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const orgIds = await resolveOrgIds(tx, ctx, query, today);
  const shared = { ctx, query, limit, offset, today, orgIds };
  if (query.view === 'all') return allContracts(tx, shared);
  if (query.view === 'in_review') return inReviewRequests(tx, shared);
  if (query.view === 'missing') return missingContracts(tx, shared);
  return recordViews(tx, shared);
}
interface Shared {
  ctx: ContractContext;
  query: ListQuery;
  limit: number;
  offset: number;
  today: string;
  orgIds: string[] | null;
}

async function inReviewRequests(tx: Tx, { ctx, query, limit, offset, today, orgIds }: Shared): Promise<ListResult> {
  const q = contractRequests;
  const scope = ctx.scope
    ? employmentVisibilitySql(ctx.scope, {
        department: sql`NULL::uuid`,
        employee: sql`${q.employeeId}`,
        creator: sql`${q.createdBy}`,
      })
    : sql`true`;
  const filter = filterPredicate(
    query,
    {
      side: 'request',
      employee: sql`${q.employeeId}`,
      type: sql`${q.typeId}`,
      company: sql`${q.companyId}`,
      status: sql`${q.status}`,
      termType: sql`${q.termType}`,
      effective: sql`${q.effectiveDate}`,
      end: sql`${q.endDate}`,
    },
    ctx.tenantId,
    today,
    orgIds,
  );
  const where = and(eq(q.tenantId, ctx.tenantId), eq(q.status, 'in_review'), scope, filter);
  const [count] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(q)
    .where(where);
  const items = await tx
    .select()
    .from(q)
    .where(where)
    .orderBy(
      orderClause(query, {
        tenantId: ctx.tenantId,
        employee: sql`${q.employeeId}`,
        effective: sql`${q.effectiveDate}`,
        end: sql`${q.endDate}`,
        signing: sql`${q.signingDate}`,
        number: sql`${q.number}`,
        id: sql`${q.id}`,
      }),
    )
    .limit(limit)
    .offset(offset);
  return { items, total: count?.total ?? 0 };
}

/**
 * 入职缺失：有当前主职（未离职 / 退休）且没有有效合同的员工；带 typeId 时只看该类型的有效合同。
 * 哪些筛选生效由 applicableQuery 统一决定（入口处已收窄），这里的合同列一律给 NULL，不会被引用到。
 */
async function missingContracts(tx: Tx, { ctx, query, limit, offset, today, orgIds }: Shared): Promise<ListResult> {
  const scope = ctx.scope
    ? employmentVisibilitySql(ctx.scope, { department: sql`NULL::uuid`, employee: sql`e.id` })
    : sql`true`;
  const none = sql`NULL`;
  // typeId 在这里不是“合同类型 = x”的筛选，而是“缺该类型的有效合同”，只进下面的 NOT EXISTS
  const { typeId: missingType, ...employeeFilters } = query;
  const filter = filterPredicate(
    employeeFilters,
    {
      side: 'record',
      employee: sql`e.id`,
      type: none,
      company: none,
      status: none,
      termType: none,
      effective: none,
      end: none,
    },
    ctx.tenantId,
    today,
    orgIds,
  );
  const body = sql`FROM employment_employees e
    JOIN (${currentPrimarySummary(ctx.tenantId, today)}) cur ON cur.employee_id=e.id
      AND cur.kind NOT IN ('leave','retirement')
    WHERE e.tenant_id=${ctx.tenantId} AND ${scope} AND ${filter}
      AND NOT EXISTS (SELECT 1 FROM contract_records c WHERE c.tenant_id=e.tenant_id AND c.employee_id=e.id
        AND NOT c.deleted AND c.status='valid' AND c.approval_status='effective' AND c.effective_date<=${today}::date
        AND (c.end_date IS NULL OR c.end_date>=${today}::date)
        AND (${missingType ?? null}::uuid IS NULL OR c.type_id=${missingType ?? null}::uuid))`;
  const direction = query.sort === 'name' && query.order === 'desc' ? sql`DESC` : sql`ASC`;
  const order = query.sort === 'name' ? sql`e.name ${direction},e.id` : sql`e.id`;
  const [count] = rowsOf<{ total: number }>(await tx.execute(sql`SELECT count(*)::int AS total ${body}`));
  const items = rowsOf(
    await tx.execute(sql`SELECT e.id AS "employeeId",e.code,e.name,jsonb_build_object(
        'departmentId',cur.department_id,'positionId',cur.position_id,'postId',cur.post_id,
        'entryDate',cur.entry_date) AS employment ${body} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`),
  );
  return { items, total: count?.total ?? 0 };
}

/**
 * 即将到期的合同（不含在途续签排除）：有效、终止日在 [today, today + days]（含两端）、尚无后续合同接上。
 * 合同列表“即将到期”在此之上再排除在途续签（A1）；人事看板“未来 30 天合同到期”（规格 35 §2.1 #6“尚未续签生效”）不排除。
 */
export function expiringContract(
  today: string,
  days: number,
  config: { renewalTypeIds: string[] },
  pointInTime = false,
): SQL {
  const c = contractRecords;
  return sql`${c.status}='valid' AND ${c.endDate} BETWEEN ${today}::date AND ${today}::date+${days}::int
    AND NOT ${successorExists(
      {
        tenantId: sql`${c.tenantId}`,
        employeeId: sql`${c.employeeId}`,
        typeId: sql`${c.typeId}`,
        endDate: sql`${c.endDate}`,
      },
      config.renewalTypeIds,
      pointInTime ? today : undefined,
    )}`;
}

/** 过期未续签的合同：终止日已过、未终止在到期日之前、没有变更链与后续合同；列表“过期未续签”与人事看板“合同已过期”共用。 */
export function expiredUnrenewedContract(
  today: string,
  config: { renewalTypeIds: string[] },
  pointInTime = false,
): SQL {
  const c = contractRecords;
  return sql`${c.status}<>'void' AND ${c.endDate}<${today}::date
      AND (${c.actualTerminationDate} IS NULL OR ${c.actualTerminationDate}>=${c.endDate})
      AND NOT EXISTS (SELECT 1 FROM contract_changes change
        WHERE change.tenant_id=${c.tenantId} AND change.before_contract_id=${c.id})
      AND NOT ${successorExists(
        {
          tenantId: sql`${c.tenantId}`,
          employeeId: sql`${c.employeeId}`,
          typeId: sql`${c.typeId}`,
          endDate: sql`${c.endDate}`,
        },
        config.renewalTypeIds,
        pointInTime ? today : undefined,
      )}`;
}

/** 三个合同记录视图各自的基础条件。 */
function viewPredicate(query: ListQuery, config: { renewalTypeIds: string[] }, today: string): SQL {
  const c = contractRecords;
  let view = sql`true`;
  if (query.view === 'valid')
    view = sql`${c.status}='valid' AND ${c.effectiveDate}<=${today}::date
      AND (${c.endDate} IS NULL OR ${c.endDate}>=${today}::date)`;
  if (query.view === 'expiring') {
    // A1：已有后续续签合同、或已有针对本合同（或同员工同类型接在终止日次日）的在途 / 已通过续签申请的，不再算即将到期
    view = sql`${expiringContract(today, query.days, config)}
      AND NOT EXISTS (SELECT 1 FROM contract_requests q WHERE q.tenant_id=${c.tenantId}
        AND q.operation IN ('create','renew') AND q.status IN ('in_review','approved')
        AND (q.target_id=${c.id} OR (q.employee_id=${c.employeeId} AND q.type_id=${c.typeId}
          AND q.effective_date=${c.endDate}+1)))`;
  }
  if (query.view === 'expired_unrenewed') view = expiredUnrenewedContract(today, config);
  return view;
}

/** 有效 / 即将到期 / 过期未续签三个只看合同记录的视图。 */
async function recordViews(tx: Tx, { ctx, query, limit, offset, today, orgIds }: Shared): Promise<ListResult> {
  const config = await settings(tx, ctx.tenantId);
  const c = contractRecords;
  const scope = ctx.scope
    ? employmentVisibilitySql(ctx.scope, {
        department: sql`NULL::uuid`,
        employee: sql`${c.employeeId}`,
        creator: sql`${c.createdBy}`,
      })
    : sql`true`;
  const view = viewPredicate(query, config, today);
  const filter = filterPredicate(
    query,
    {
      side: 'record',
      employee: sql`${c.employeeId}`,
      type: sql`${c.typeId}`,
      company: sql`${c.companyId}`,
      status: sql`${c.status}`,
      termType: sql`${c.termType}`,
      effective: sql`${c.effectiveDate}`,
      end: sql`${c.endDate}`,
    },
    ctx.tenantId,
    today,
    orgIds,
  );
  const where = and(eq(c.tenantId, ctx.tenantId), eq(c.deleted, false), scope, view, filter);
  const [count] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(c)
    .where(where);
  const items = await tx
    .select()
    .from(c)
    .where(where)
    .orderBy(
      orderClause(query, {
        tenantId: ctx.tenantId,
        employee: sql`${c.employeeId}`,
        effective: sql`${c.effectiveDate}`,
        end: sql`${c.endDate}`,
        signing: sql`${c.signingDate}`,
        number: sql`${c.number}`,
        id: sql`${c.id}`,
      }),
    )
    .limit(limit)
    .offset(offset);
  return { items, total: count?.total ?? 0 };
}

/** 全部视图同时包含未生效申请；申请与生效版本分别标识，分页前对两侧应用同一范围与同一筛选。 */
async function allContracts(tx: Tx, { ctx, query, limit, offset, today, orgIds }: Shared): Promise<ListResult> {
  const side = (alias: 'c' | 'r', kind: 'record' | 'request') => {
    const column = (name: string) => sql.raw(`${alias}.${name}`);
    const scope = ctx.scope
      ? employmentVisibilitySql(ctx.scope, {
          department: sql`NULL::uuid`,
          employee: column('employee_id'),
          creator: column('created_by'),
        })
      : sql`true`;
    const filter = filterPredicate(
      query,
      {
        side: kind,
        employee: column('employee_id'),
        type: column('type_id'),
        company: column('company_id'),
        status: column('status'),
        termType: column('term_type'),
        effective: column('effective_date'),
        end: column('end_date'),
      },
      ctx.tenantId,
      today,
      orgIds,
    );
    return { scope, filter };
  };
  const record = side('c', 'record');
  const request = side('r', 'request');
  const combined = sql`
    SELECT to_jsonb(c)||jsonb_build_object('row_type','contract') AS value,c.employee_id,c.effective_date,
      c.end_date,c.signing_date,c.number,c.id
      FROM contract_records c WHERE c.tenant_id=${ctx.tenantId} AND NOT c.deleted
        AND ${record.scope} AND ${record.filter}
    UNION ALL
    SELECT to_jsonb(r)||jsonb_build_object('row_type','request','approval_status',r.status),r.employee_id,
      r.effective_date,r.end_date,r.signing_date,r.number,r.id
      FROM contract_requests r WHERE r.tenant_id=${ctx.tenantId}
        AND r.status IN ('approved','in_review','returned') AND ${request.scope} AND ${request.filter}`;
  const order = orderClause(query, {
    tenantId: ctx.tenantId,
    employee: sql`combined.employee_id`,
    effective: sql`combined.effective_date`,
    end: sql`combined.end_date`,
    signing: sql`combined.signing_date`,
    number: sql`combined.number`,
    id: sql`combined.id`,
  });
  const [count] = rowsOf<{ total: number }>(
    await tx.execute(sql`SELECT count(*)::int AS total FROM (${combined}) combined`),
  );
  const rows = rowsOf<{ value: Record<string, unknown> }>(
    await tx.execute(sql`SELECT value FROM (${combined}) combined ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`),
  );
  const items = rows.map(({ value }) =>
    Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase()),
        item,
      ]),
    ),
  );
  return { items, total: count?.total ?? 0 };
}
