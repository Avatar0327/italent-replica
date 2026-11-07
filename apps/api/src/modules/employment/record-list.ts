/**
 * F-474-4b #16（DEC-776）：全租户任职记录列表（原站“任职管理 → 任职记录”，规格 codex-R1bd §2.4）。
 * 只读集合接口，授权沿用既有对象 TenantBase.EmploymentRecord 的查看权，不新增对象 / 字段编码：
 * - 数据范围：employmentVisibilitySql（DEC-177）在 LIMIT / OFFSET 之前过滤，total 与本页同一份物化候选集；
 * - 字段权：任职字段按任职记录对象裁剪；姓名 / 工号按人员对象；机构类列（任职机构、一至三级组织、任职部门）
 *   随任职记录的 departmentId 字段权；用不可见字段筛选一律 403，不让筛选成为探针；
 * - isCurrent / serviceType 同样按任职记录字段权裁剪，用它们筛选（current / serviceType）也须可见；
 * - 只列时间轴上的主职记录（兼职 / 借调 / 外派走兼职接口，不在本列表）；所有任职记录行都是已生效的
 *   （审批中的业务在 employment_business_objects / employment_state_events，不进 employment_records）。
 */
import { sql, withTenant, type Tx } from '@italent/db';
import { EMPLOYEE_STATUS, EMPLOYEE_STATUS_CODES, PERSONNEL_OBJECT, tenantLocalDate } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { orgDisplays } from '../org/org-display.js';
import { getModuleViewableFields } from '../permission/module-access.js';
import {
  EMPLOYEE_OBJECT,
  EMPLOYMENT_OBJECT,
  employmentCreator,
  pageQuery,
  queryDate,
  readPageContext,
  trimEmploymentResponse,
  type EmploymentContext,
} from './context.js';
import { resolveDepartmentIds } from './exit-queries.js';
import { normalizedUuid } from './fields.js';
import { listEmploymentRecordsByIds, rowsOf } from './read-model.js';
import { personnelHooks } from './personnel-hooks.js';
import { employmentVisibilitySql } from './visibility.js';
import type { EmploymentRecord, PageQuery } from './types.js';

/** “任职中”= 试用 / 正式 / 非正式；其余人员状态（待入职、离职、退休等）不算（规格：任职状态默认任职中）。 */
const WORKING_STATUSES = [EMPLOYEE_STATUS.probation, EMPLOYEE_STATUS.regular, EMPLOYEE_STATUS.informal] as const;
/** 本列表只含主职时间轴上的记录；其他任职类型的取值一律 400，不静默给空。 */
const SERVICE_TYPES = ['primary'] as const;

export interface RecordListFilter {
  readonly name?: string;
  readonly email?: string;
  /** 'working' = 任职中，或具体人员状态码。 */
  readonly employeeStatus?: 'working' | number;
  readonly serviceType?: (typeof SERVICE_TYPES)[number];
  readonly departmentId?: string;
  readonly includeChildren: boolean;
  /** 缺省 = 不限；是否当前生效按 asOf 判定。 */
  readonly current?: boolean;
}

function booleanQuery(c: Context, key: string): boolean | undefined {
  const raw = c.req.query(key);
  if (raw === undefined || raw === '') return undefined;
  if (raw !== 'true' && raw !== 'false') throw new AppError('VALIDATION_FAILED', `${key} 只能是 true 或 false`);
  return raw === 'true';
}

function textQuery(c: Context, key: string): string | undefined {
  const value = c.req.query(key)?.trim();
  if (!value) return undefined;
  if (value.length > 100) throw new AppError('VALIDATION_FAILED', `${key} 过长`);
  return value;
}

function parseStatus(raw: string | undefined): RecordListFilter['employeeStatus'] {
  if (raw === undefined || raw === '') return undefined;
  if (raw === 'working') return 'working';
  const code = Number(raw);
  if (!/^\d+$/.test(raw) || !EMPLOYEE_STATUS_CODES.includes(code as never))
    throw new AppError('VALIDATION_FAILED', 'employeeStatus 取值不合法');
  return code;
}

function uuidOf(raw: string): string {
  const parsed = normalizedUuid.safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', 'departmentId 不是合法的 ID');
  return parsed.data;
}

export function parseRecordListQuery(c: Context): RecordListFilter {
  // 审批状态只有“生效”：任职记录表里只有已生效的行，其他状态没有可列的记录
  const approvalState = c.req.query('approvalState');
  if (approvalState !== undefined && approvalState !== '' && approvalState !== 'effective')
    throw new AppError('VALIDATION_FAILED', '任职记录列表只含已生效的记录');
  const serviceType = c.req.query('serviceType');
  if (serviceType !== undefined && serviceType !== '' && !SERVICE_TYPES.includes(serviceType as never))
    throw new AppError('VALIDATION_FAILED', '任职类型取值不合法');
  const departmentId = c.req.query('departmentId');
  const includeChildren = c.req.query('includeChildren');
  if (includeChildren !== undefined && includeChildren !== 'true' && includeChildren !== 'false')
    throw new AppError('VALIDATION_FAILED', 'includeChildren 只能是 true 或 false');
  return {
    name: textQuery(c, 'name'),
    email: textQuery(c, 'email'),
    employeeStatus: parseStatus(c.req.query('employeeStatus')),
    serviceType: serviceType ? (serviceType as RecordListFilter['serviceType']) : undefined,
    departmentId: departmentId ? uuidOf(departmentId) : undefined,
    includeChildren: includeChildren !== 'false',
    current: booleanQuery(c, 'current'),
  };
}

interface Viewable {
  readonly employee: (field: string) => boolean;
  readonly person: (field: string) => boolean;
  readonly employment: (field: string) => boolean;
}

async function viewableFor(deps: TenantRouteDeps, ctx: EmploymentContext): Promise<Viewable> {
  const [employee, person, employment] = await Promise.all([
    getModuleViewableFields(deps, ctx, EMPLOYEE_OBJECT),
    getModuleViewableFields(deps, ctx, PERSONNEL_OBJECT),
    getModuleViewableFields(deps, ctx, EMPLOYMENT_OBJECT),
  ]);
  const has = (set: ReadonlySet<string> | undefined) => (field: string) => set === undefined || set.has(field);
  return { employee: has(employee), person: has(person), employment: has(employment) };
}

/** 筛选用到的字段必须可见，否则 403（同离职 / 实习视图）。 */
function requireViewableFilters(filter: RecordListFilter, show: Viewable): void {
  const allowed =
    (!filter.name || show.employee('name')) &&
    (!filter.email || show.person('email')) &&
    (filter.employeeStatus === undefined || show.employee('employeeStatus')) &&
    (!filter.departmentId || show.employment('departmentId')) &&
    // 是否当前生效 / 任职类型是任职记录字段：隐藏后仍能用筛选比对行集合会恢复字段值，同其它不可见字段一律 403
    (filter.current === undefined || show.employment('isCurrent')) &&
    (!filter.serviceType || show.employment('serviceType'));
  if (!allowed) throw new AppError('FORBIDDEN', '筛选字段不可查看');
}

// 记录的最终部门 / 人员状态：优先取完整生效快照，没有快照的旧行回落到记录本身（同 read-model recordsQuery）
const DEPARTMENT = sql`(CASE WHEN snap.present THEN snap.department_id ELSE r.department_id END)`;
const STATUS = sql`(CASE WHEN snap.present THEN snap.employee_status ELSE r.employee_status END)`;

function likePattern(keyword: string): string {
  return `%${keyword.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

function filterPredicates(tenantId: string, asOf: string, filter: RecordListFilter, departmentIds?: string[]): SQL[] {
  const name = personnelHooks.currentName(tenantId, sql`e.id`, sql`e.name`);
  const parts: SQL[] = [sql`r.service_type='primary'`];
  if (filter.name) parts.push(sql`${name} ILIKE ${likePattern(filter.name)} ESCAPE '\\'`);
  if (filter.email) parts.push(sql`lower(v.email) LIKE ${likePattern(filter.email.toLowerCase())} ESCAPE '\\'`);
  if (filter.employeeStatus === 'working')
    parts.push(
      sql`${STATUS} IN (${sql.join(
        WORKING_STATUSES.map((code) => sql`${code}`),
        sql`,`,
      )})`,
    );
  else if (filter.employeeStatus !== undefined) parts.push(sql`${STATUS}=${filter.employeeStatus}`);
  if (departmentIds) parts.push(sql`${DEPARTMENT}=ANY(${`{${departmentIds.join(',')}}`}::uuid[])`);
  if (filter.current !== undefined)
    parts.push(filter.current ? sql`t.valid_during @> ${asOf}::date` : sql`NOT (t.valid_during @> ${asOf}::date)`);
  return parts;
}

interface PageRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

async function pageOfRecords(
  tx: Tx,
  ctx: EmploymentContext,
  asOf: string,
  filter: RecordListFilter,
  departmentIds: string[] | undefined,
  page: PageQuery,
): Promise<{ rows: PageRow[]; total: number }> {
  const visible = employmentVisibilitySql(ctx.scope, {
    employee: sql`r.employee_id`,
    department: DEPARTMENT,
    creator: employmentCreator(ctx.tenantId, sql`r.id`, true),
  });
  const where = sql.join([visible, ...filterPredicates(ctx.tenantId, asOf, filter, departmentIds)], sql` AND `);
  const name = personnelHooks.currentName(ctx.tenantId, sql`e.id`, sql`e.name`);
  const result = rowsOf<{ total: number; id: string | null; code: string | null; name: string | null }>(
    await tx.execute(sql`
      WITH base AS MATERIALIZED (
        SELECT r.id, e.code, ${name} AS name, t.start_date, t.sort_order
        FROM employment_records r
        JOIN employment_timeline t ON t.tenant_id=r.tenant_id AND t.record_id=r.id
        JOIN employment_employees e ON e.tenant_id=r.tenant_id AND e.id=r.employee_id
        LEFT JOIN LATERAL (SELECT p.department_id, p.employee_status, true AS present
          FROM employment_payload_versions p
          WHERE p.tenant_id=r.tenant_id AND p.employee_id=r.employee_id AND p.business_id=r.id
            AND p.is_record_snapshot
          ORDER BY p.version_no DESC LIMIT 1) snap ON true
        LEFT JOIN LATERAL (SELECT pv.email FROM personnel_employee_versions pv
          WHERE pv.tenant_id=e.tenant_id AND pv.employee_id=e.id ORDER BY pv.revision DESC LIMIT 1) v ON true
        WHERE r.tenant_id=${ctx.tenantId} AND ${where}
      ), counted AS (SELECT count(*)::int AS total FROM base)
      SELECT counted.total, page.id, page.code, page.name FROM counted
      LEFT JOIN LATERAL (SELECT * FROM base ORDER BY start_date DESC, sort_order DESC, id
        LIMIT ${page.limit} OFFSET ${page.offset}) page ON true
      ORDER BY page.start_date DESC NULLS LAST, page.sort_order DESC NULLS LAST, page.id
    `),
  );
  const total = result[0]?.total ?? 0;
  return {
    total,
    rows: result.filter((row) => row.id).map((row) => ({ id: row.id!, code: row.code!, name: row.name! })),
  };
}

/** 页内行的展示字段：先按任职记录对象裁剪，再按裁剪后的 departmentId 给机构类列（无部门字段权则整组缺席）。 */
async function projectRows(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  show: Viewable,
  today: string,
  rows: readonly PageRow[],
  records: ReadonlyMap<string, EmploymentRecord>,
) {
  const slim = rows.map((row) => {
    const record = records.get(row.id)!;
    return {
      kind: record.kind,
      effectiveDate: record.effectiveDate,
      stopDate: record.stopDate,
      isCurrent: record.isCurrent,
      serviceType: record.serviceType,
      fields: {
        departmentId: record.fields.departmentId,
        employmentType: record.fields.employmentType,
        employType: record.fields.employType,
        jobNumber: record.fields.jobNumber,
      },
    };
  });
  const trimmed = ((await trimEmploymentResponse(deps, ctx, { items: slim })) as { items: Record<string, unknown>[] })
    .items;
  const departmentIds = trimmed.map((item) => (item.fields as { departmentId?: string | null }).departmentId ?? null);
  const orgs = await withTenant(deps.db, ctx.tenantId, (tx) => orgDisplays(tx, ctx.tenantId, today, departmentIds));
  return rows.map((row, index) => {
    const record = records.get(row.id)!;
    const org = departmentIds[index] ? orgs.get(departmentIds[index]!) : undefined;
    const levels = org?.levels ?? [];
    return {
      // id / employeeId 是行标识（跳转键），不带字段权；serviceType 与其它任职字段一样随字段权裁剪（审查 R1 P2-2）
      id: row.id,
      employeeId: record.employeeId,
      ...(show.employee('code') ? { employeeCode: row.code } : {}),
      ...(show.employee('name') ? { employeeName: row.name } : {}),
      ...trimmed[index],
      ...('departmentId' in (trimmed[index]!.fields as object)
        ? {
            orgCode: org?.code ?? null,
            orgFullName: org?.fullName ?? null,
            departmentName: levels.at(-1) ?? null,
            orgLevels: [levels[0] ?? null, levels[1] ?? null, levels[2] ?? null],
          }
        : {}),
    };
  });
}

export function registerRecordList(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  // 全租户任职记录列表：只读；分页前按 DEC-177 可见口径过滤，total 同一口径
  router.get('/records', async (c) => {
    const ctx = await readPageContext(c, deps, 'list');
    const filter = parseRecordListQuery(c);
    const page = pageQuery(c);
    const asOf = queryDate(c, ctx);
    const show = await viewableFor(deps, ctx);
    requireViewableFilters(filter, show);
    const today = tenantLocalDate(ctx.now, ctx.timezone);
    const { rows, total, records } = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const departmentIds = filter.departmentId
        ? await resolveDepartmentIds(tx, ctx.tenantId, filter.departmentId, filter.includeChildren, today)
        : undefined;
      const found = await pageOfRecords(tx, ctx, asOf, filter, departmentIds, page);
      const loaded = await listEmploymentRecordsByIds(
        tx,
        ctx.tenantId,
        found.rows.map((row) => row.id),
        asOf,
        ctx.scope,
      );
      return { ...found, records: new Map(loaded.map((record) => [record.id, record])) };
    });
    return c.json({
      items: await projectRows(deps, ctx, show, today, rows, records),
      total,
      page: page.page,
      pageSize: page.pageSize,
      hasDataPermission: ctx.scope?.hasDataPermission ?? true,
    });
  });
}
