/**
 * R2-T04 BE-5d1 退休五视图与详情路由（设计 §10、§12.1 5d1 行）。权限链同离职视图（exit-routes.ts registerExitViews）：
 * 任职记录查看权（readPageContext）→ 分页前 DEC-177 范围过滤 → 字段按任职记录 / 人员对象字段权裁剪。
 * view=cancelled（撤销的退休记录，F-277）是五视图之外的额外取值：沿用离职撤销视图（#432）的形态，不按 asOf 过滤。
 */
import {
  RETIREMENT_UPCOMING_DAYS,
  RETIREMENT_UPCOMING_DAYS_KEY,
  RETIREMENT_VIEWS,
  tenantLocalDate,
} from '@italent/domain';
import { withTenant } from '@italent/db';
import type { Hono } from 'hono';
import { z } from 'zod';
import { requirePermission } from '../../authorization.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { readEffectiveSetting } from '../tenant-settings/service.js';
import { composeExit, selectEmploymentRead } from './approval-content.js';
import { pageQuery, readContext, readPageContext, uuidParam } from './context.js';
import { resolveDepartmentIds, type ExitViewFilter } from './exit-queries.js';
import { day, parse, requireViewableExitFilters, viewableIn } from './exit-routes.js';
import { inFlightApplications } from './exit-gate.js';
import { normalizedUuid } from './fields.js';
import { loadEmploymentBusiness } from './read-model.js';
import {
  listRetirementBills,
  listRetirementPersons,
  loadRetirementDetail,
  RETIREMENT_CANCELLED_VIEW,
  trimRetirementDetail,
} from './retirement-views.js';

const FALLBACK_UPCOMING_DAYS = 30;
const IN_FLIGHT_STATES = ['draft', 'in_review', 'approved', 'rejected'] as const;

const viewQuery = z.object({
  view: z.enum([...RETIREMENT_VIEWS, RETIREMENT_CANCELLED_VIEW]),
  asOf: day.optional(),
  upcomingDays: z
    .string()
    .regex(/^[0-9]{1,3}$/)
    .transform(Number)
    .refine((days) => days >= RETIREMENT_UPCOMING_DAYS.min && days <= RETIREMENT_UPCOMING_DAYS.max)
    .optional(),
  // F-351：同离职视图的 departmentId / includeChildren / keyword（参数校验同 exit-routes viewQuery）
  departmentId: normalizedUuid.optional(),
  includeChildren: z.enum(['true', 'false']).optional(),
  keyword: z.string().trim().min(1).max(100).optional(),
});

async function upcomingDaysOf(requested: number | undefined, read: () => Promise<unknown>) {
  if (requested !== undefined) return requested;
  const configured = await read();
  return typeof configured === 'number' ? configured : FALLBACK_UPCOMING_DAYS;
}

function registerRetirementInFlight(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  // F-410：员工当前在途的退休单（草稿 / 审批中 / 已批准 / 已驳回，与互斥门禁同一集合）；没有则 item 为 null。
  // 入口以此接续草稿，不再只信页面缓存（DEC-727）。员工范围外与不存在同一个 404；单据内容走详情同一裁剪。
  router.get('/retirements/employees/:id/in-flight', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.view', 0, id);
    const detail = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const [flight] = await inFlightApplications(tx, ctx, id, ['retirement'], IN_FLIGHT_STATES, null);
      return flight ? loadRetirementDetail(tx, ctx.tenantId, flight.id, ctx.scope) : null;
    });
    if (!detail) return c.json({ item: null });
    await requirePermission(deps.authorize, { ...ctx, action: 'tenant.employment.read', resource: detail.employeeId });
    return c.json({ item: trimRetirementDetail(detail, await viewableIn(deps, ctx)) });
  });
}

export function registerRetirementViews(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  registerRetirementInFlight(router, deps);
  router.get('/retirements', async (c) => {
    const ctx = await readPageContext(c, deps, 'list');
    const query = parse(viewQuery, {
      view: c.req.query('view'),
      asOf: c.req.query('asOf'),
      upcomingDays: c.req.query('upcomingDays'),
      departmentId: c.req.query('departmentId'),
      includeChildren: c.req.query('includeChildren'),
      keyword: c.req.query('keyword'),
    });
    const page = pageQuery(c);
    const show = await viewableIn(deps, ctx);
    const requested: ExitViewFilter = {
      ...(query.keyword ? { keyword: query.keyword } : {}),
      ...(query.departmentId ? { departmentIds: [query.departmentId] } : {}),
    };
    requireViewableExitFilters(requested, show);
    const asOf = query.asOf ?? tenantLocalDate(ctx.now, ctx.timezone);
    const at = { asOf, timezone: ctx.timezone };
    const result = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      // 部门不存在 / 在范围外都只是空结果（范围谓词先行），不单独报错，避免成为部门存在性的探针
      const filter = {
        ...(query.keyword ? { keyword: query.keyword } : {}),
        ...(query.departmentId
          ? {
              departmentIds: await resolveDepartmentIds(
                tx,
                ctx.tenantId,
                query.departmentId,
                query.includeChildren !== 'false',
                asOf,
              ),
            }
          : {}),
      };
      if (query.view === 'upcoming' || query.view === 'overdue') {
        const upcomingDays = await upcomingDaysOf(
          query.upcomingDays,
          async () => (await readEffectiveSetting(tx, ctx.tenantId, RETIREMENT_UPCOMING_DAYS_KEY)).value,
        );
        const persons = await listRetirementPersons(
          tx,
          ctx.tenantId,
          { view: query.view, at, upcomingDays, page, show, filter },
          ctx.scope,
        );
        return { ...persons, ...(query.view === 'upcoming' ? { upcomingDays } : {}) };
      }
      return listRetirementBills(tx, ctx.tenantId, { view: query.view, at, page, show, filter }, ctx.scope);
    });
    return c.json({
      ...result,
      asOf,
      page: page.page,
      pageSize: page.pageSize,
      hasDataPermission: ctx.scope?.hasDataPermission ?? true,
    });
  });
  // 详情：范围外 / 不存在 / 不是退休单同一个 404；先按任职业务口径（DEC-177）确认可见，再取退休详情
  router.get('/retirements/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await readPageContext(c, deps, 'detail');
    const today = tenantLocalDate(ctx.now, ctx.timezone);
    const detail = await withTenant(deps.db, ctx.tenantId, async (tx) =>
      (await loadEmploymentBusiness(tx, ctx.tenantId, id, today, ctx.scope))
        ? loadRetirementDetail(tx, ctx.tenantId, id, ctx.scope)
        : null,
    );
    if (!detail) throw new AppError('NOT_FOUND', '任职业务不存在');
    await requirePermission(deps.authorize, { ...ctx, action: 'tenant.employment.read', resource: detail.employeeId });
    // F-476 P4：已办审批人读办理时冻结的退休内容，其余读现值；流程事实始终是现值
    const read = await selectEmploymentRead(deps, ctx, id);
    const frozen = read.frozen ? composeExit(detail, read.frozen.content, read.frozen.allowed) : null;
    if (read.frozen && !frozen) throw new AppError('NOT_FOUND', '任职业务不存在');
    const shown = (frozen ?? detail) as typeof detail;
    return c.json({ ...trimRetirementDetail(shown, await viewableIn(deps, ctx)), contentView: read.contentView });
  });
}
