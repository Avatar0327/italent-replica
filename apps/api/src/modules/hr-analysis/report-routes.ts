/**
 * 人事报表目录与 8 张名册分析报表（F-465a；规格 35 §2.1，DEC-763①）：
 * - GET /reports：12 张预置报表的目录，按调用方权限标注可用性（不可用写明原因，不隐藏）；
 * - GET /reports/:code、GET /reports/:code/export：1.01 / 1.04 / 1.05 / 1.08 / 1.1.01 复用 roster-query 的同一条读取语句，
 *   1.06 / 1.07 / 1.1.02 走 report-queries；权限链与花名册相同（rosterAccess：人事分析对象查看权 + 员工档案范围 + 逐列字段权），
 *   另须 1.06 合同、1.07 / 1.1.01 / 1.1.02 任职记录对象的查看权——缺失直接 403（比花名册“缺列”更严）。
 * 数据范围一律进 WHERE、先于分页，空范围返回 0 行且 hasDataPermission=false；导出与列表共用同一份可见列与查询。
 */
import { withTenant } from '@italent/db';
import {
  CONTRACT_LEDGER_COLUMNS,
  EMPLOYMENT_HISTORY_COLUMNS,
  MODULE_OBJECTS,
  MOVEMENT_CATEGORIES,
  MOVEMENT_DETAIL_COLUMNS,
  PERSONNEL_OBJECT,
  PERSONNEL_REPORTS,
  ROSTER_EXPORT_MAX_ROWS,
  reportCellLabel,
  rosterCellText,
  tenantLocalDate,
  type PersonnelReport,
  type RosterColumn,
  type RosterSource,
} from '@italent/domain';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { pageQuery } from '../job/context.js';
import { validIsoDate } from '../org/read-model.js';
import type { Row } from '../personnel/store.js';
import {
  countHistory,
  countLedger,
  countMovements,
  listHistory,
  listLedger,
  listMovements,
  type MovementFilter,
} from './report-queries.js';
import { requireExportButton, requireFilterField, rosterAccess, type RosterAccess } from './roster-access.js';
import { exportLimitResponse, rosterCsv } from './roster-csv.js';
import { countRoster, listRoster, trimRosterRow, type RosterBase, type RosterFilter } from './roster-query.js';

const BASE = '/api/tenant/hr-analysis/reports';
const isoDate = z.string().refine(validIsoDate);
const text = z.string().min(1).max(200);
const paging = { page: z.unknown().optional(), pageSize: z.unknown().optional() };
const person = { name: text.optional() };

const OBJECT_OF: Readonly<Record<RosterSource, string>> = {
  person: PERSONNEL_OBJECT,
  record: MODULE_OBJECTS.employmentRecord.code,
  contract: MODULE_OBJECTS.contract.code,
};
const LABEL_OF = {
  hrRoster: '人事分析花名册',
  hrMovementReport: '入离职报表',
  hrStructureReport: '员工结构报表',
} as const;
const REQUIRED_LABEL = { person: '员工档案', record: '任职记录', contract: '合同' } as const;

/** 名册类报表的人员口径（asOf 当天的主职任职状态 + 雇佣关系）。1.1.01 含退休 / 离职。 */
const ROSTER_BASES: Readonly<Record<string, RosterBase>> = {
  '1.01': { statuses: [2, 3], employTypes: ['internal'] },
  '1.04': { statuses: [2, 3], employTypes: ['intern'] },
  '1.05': { statuses: [2, 3], employTypes: ['external'] },
  '1.08': { statuses: [2, 3], employTypes: ['internal', 'intern'] },
  '1.1.01': { statuses: [2, 3, 6, 8], employTypes: ['internal', 'intern', 'external'] },
};

function rosterSchema(base: RosterBase, withAsOf: boolean) {
  return z.strictObject({
    ...(withAsOf ? { asOf: isoDate.optional() } : {}),
    ...person,
    email: text.optional(),
    workDateFrom: isoDate.optional(),
    workDateTo: isoDate.optional(),
    employeeStatus: z.coerce
      .number()
      .refine((value) => base.statuses.includes(value))
      .optional(),
    ...paging,
  });
}
const SCHEMAS: Readonly<Record<string, z.ZodType<Record<string, unknown>>>> = {
  '1.01': rosterSchema(ROSTER_BASES['1.01']!, true),
  '1.04': rosterSchema(ROSTER_BASES['1.04']!, true),
  '1.05': rosterSchema(ROSTER_BASES['1.05']!, true),
  '1.08': rosterSchema(ROSTER_BASES['1.08']!, true),
  '1.1.01': rosterSchema(ROSTER_BASES['1.1.01']!, false),
  '1.06': z.strictObject({ asOf: isoDate.optional(), ...person, number: text.optional(), ...paging }),
  // 时间范围是必填参数，不是可被字段权拒绝的筛选字段
  '1.07': z.strictObject({
    from: isoDate,
    to: isoDate,
    category: z.enum(MOVEMENT_CATEGORIES).optional(),
    ...person,
    ...paging,
  }),
  '1.1.02': z.strictObject({ ...person, ...paging }),
};

function reportOf(code: string): PersonnelReport {
  const report = PERSONNEL_REPORTS.find((item) => item.code === code && item.endpoint.startsWith(BASE));
  if (!report) throw new AppError('NOT_FOUND', '报表不存在');
  return report;
}

function parseQuery(c: Context<TenantEnv>, code: string): Record<string, unknown> {
  const result = SCHEMAS[code]!.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!result.success) throw new AppError('VALIDATION_FAILED', '报表查询参数不合法');
  const { page: _page, pageSize: _pageSize, ...params } = result.data;
  if (typeof params.from === 'string' && typeof params.to === 'string' && params.from > params.to)
    throw new AppError('VALIDATION_FAILED', '起始日期不能晚于结束日期');
  return params;
}

const DEDICATED_COLUMNS: Readonly<Record<string, readonly RosterColumn[]>> = {
  '1.06': CONTRACT_LEDGER_COLUMNS,
  '1.07': MOVEMENT_DETAIL_COLUMNS,
  '1.1.02': EMPLOYMENT_HISTORY_COLUMNS,
};

/**
 * 具名守卫 hrAnalysis.reportObjects（F-039 required 表登记其调用与拒绝语义）：本报表 requires 里的任职 / 合同对象
 * 缺查看权直接 403，比花名册“只让列缺席”更严；person 已由 rosterAccess 先行拒绝（viewable.person 恒为真）。
 */
function requireReportObjects(rights: RosterAccess, report: PersonnelReport) {
  for (const source of report.requires)
    if (!rights.viewable[source]) throw new AppError('FORBIDDEN', `缺少${REQUIRED_LABEL[source]}对象的查看权限`);
}

function requireFilterRights(rights: RosterAccess, params: Record<string, unknown>) {
  if (params.name) requireFilterField(rights, 'person', 'name');
  if (params.email) requireFilterField(rights, 'person', 'email');
  if (params.workDateFrom || params.workDateTo) requireFilterField(rights, 'person', 'workDate');
  if (params.employeeStatus) requireFilterField(rights, 'person', 'employeeStatus');
  if (params.number) requireFilterField(rights, 'contract', 'number');
  if (params.category) requireFilterField(rights, 'record', 'kind');
}

interface Source {
  readonly count: () => Promise<number>;
  readonly list: (limit: number, offset: number) => Promise<Row[]>;
}

/** 按报表编码取“计数 + 分页读取”两个闭包；计数与分页共用同一份谓词（各 query 模块内的 from 构造函数）。 */
function sourceOf(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  rights: RosterAccess,
  code: string,
  params: Record<string, unknown>,
  asOf: string,
): Source {
  const ctx = rights.ctx;
  const base = ROSTER_BASES[code];
  if (base) {
    const filter = params as RosterFilter;
    return {
      count: () => countRoster(tx, ctx, asOf, filter, base),
      list: (limit, offset) => listRoster(tx, ctx, asOf, filter, { limit, offset }, base),
    };
  }
  if (code === '1.06') {
    const filter = params as { name?: string; number?: string };
    return {
      count: () => countLedger(tx, ctx, asOf, filter),
      list: (limit, offset) => listLedger(tx, ctx, asOf, filter, { limit, offset }),
    };
  }
  if (code === '1.07') {
    const filter = params as unknown as MovementFilter;
    return {
      count: () => countMovements(tx, ctx, filter),
      list: (limit, offset) => listMovements(tx, ctx, asOf, filter, { limit, offset }),
    };
  }
  const filter = params as { name?: string };
  return {
    count: () => countHistory(tx, ctx, filter),
    list: (limit, offset) => listHistory(tx, ctx, asOf, filter, { limit, offset }),
  };
}

const cellText = (key: string, value: unknown) =>
  value === null || value === undefined ? '' : (reportCellLabel(key, value) ?? rosterCellText(key, value));

/** 目录可用性：每条报表所需的对象查看权逐个核对；缺任何一个都标不可用并写原因。 */
async function availability(c: Context<TenantEnv>, deps: TenantRouteDeps, report: PersonnelReport) {
  const tenant = tenantOf(c);
  const needs = [
    { resource: MODULE_OBJECTS[report.permission].code, label: LABEL_OF[report.permission] },
    ...report.requires.map((source) => ({ resource: OBJECT_OF[source], label: `${REQUIRED_LABEL[source]}对象` })),
  ];
  for (const need of needs)
    if (!(await deps.authorize({ ...tenant, action: 'object.view', resource: need.resource })))
      return { available: false, reason: `缺少${need.label}的查看权限` };
  return { available: true };
}

export function registerReportRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(BASE, async (c) => {
    const items = [];
    for (const report of PERSONNEL_REPORTS) {
      const { code, name, group, endpoint } = report;
      items.push({ code, name, group, endpoint, ...(await availability(c, deps, report)) });
    }
    return c.json({ items });
  });

  router.get(`${BASE}/:code`, async (c) => {
    const report = reportOf(c.req.param('code'));
    const params = parseQuery(c, report.code);
    const rights = await rosterAccess(c, deps, DEDICATED_COLUMNS[report.code]);
    requireReportObjects(rights, report);
    requireFilterRights(rights, params);
    const page = pageQuery(c);
    const requested = typeof params.asOf === 'string' ? params.asOf : undefined;
    const asOf = requested ?? tenantLocalDate(rights.ctx.now, rights.ctx.timezone);
    const { total, items } = await withTenant(deps.db, rights.ctx.tenantId, async (tx) => {
      const source = sourceOf(tx, rights, report.code, params, asOf);
      return { total: await source.count(), items: await source.list(page.limit, page.offset) };
    });
    return c.json({
      ...(requested !== undefined || ROSTER_BASES[report.code] ? { asOf } : {}),
      code: report.code,
      name: report.name,
      items: items.map((row) => trimRosterRow(row, rights.columns)),
      columns: rights.columns.map(({ key, label }) => ({ key, label })),
      total,
      page: page.page,
      pageSize: page.pageSize,
      hasDataPermission: rights.ctx.scope.hasDataPermission,
    });
  });

  router.get(`${BASE}/:code/export`, async (c) => {
    const report = reportOf(c.req.param('code'));
    const params = parseQuery(c, report.code);
    const rights = await rosterAccess(c, deps, DEDICATED_COLUMNS[report.code]);
    await requireExportButton(deps, rights.ctx);
    requireReportObjects(rights, report);
    requireFilterRights(rights, params);
    const asOf = typeof params.asOf === 'string' ? params.asOf : tenantLocalDate(rights.ctx.now, rights.ctx.timezone);
    const result = await withTenant(deps.db, rights.ctx.tenantId, async (tx) => {
      const source = sourceOf(tx, rights, report.code, params, asOf);
      const total = await source.count();
      return total > ROSTER_EXPORT_MAX_ROWS
        ? { total }
        : { total, items: await source.list(ROSTER_EXPORT_MAX_ROWS, 0) };
    });
    if (!result.items) return exportLimitResponse(c, result.total);
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="report-${report.code}-${asOf}.csv"`);
    return c.body(
      rosterCsv(
        rights.columns,
        result.items.map((row) => trimRosterRow(row, rights.columns)),
        cellText,
      ),
    );
  });
}
