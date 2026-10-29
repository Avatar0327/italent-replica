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
import { pageQuery, readPageContext, uuidParam } from './context.js';
import { day, parse, viewableIn } from './exit-routes.js';
import { loadEmploymentBusiness } from './read-model.js';
import {
  listRetirementBills,
  listRetirementPersons,
  loadRetirementDetail,
  RETIREMENT_CANCELLED_VIEW,
  trimRetirementDetail,
} from './retirement-views.js';

const FALLBACK_UPCOMING_DAYS = 30;

const viewQuery = z.object({
  view: z.enum([...RETIREMENT_VIEWS, RETIREMENT_CANCELLED_VIEW]),
  asOf: day.optional(),
  upcomingDays: z
    .string()
    .regex(/^[0-9]{1,3}$/)
    .transform(Number)
    .refine((days) => days >= RETIREMENT_UPCOMING_DAYS.min && days <= RETIREMENT_UPCOMING_DAYS.max)
    .optional(),
});

async function upcomingDaysOf(requested: number | undefined, read: () => Promise<unknown>) {
  if (requested !== undefined) return requested;
  const configured = await read();
  return typeof configured === 'number' ? configured : FALLBACK_UPCOMING_DAYS;
}

export function registerRetirementViews(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/retirements', async (c) => {
    const ctx = await readPageContext(c, deps, 'list');
    const query = parse(viewQuery, {
      view: c.req.query('view'),
      asOf: c.req.query('asOf'),
      upcomingDays: c.req.query('upcomingDays'),
    });
    const page = pageQuery(c);
    const show = await viewableIn(deps, ctx);
    const asOf = query.asOf ?? tenantLocalDate(ctx.now, ctx.timezone);
    const at = { asOf, timezone: ctx.timezone };
    const result = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      if (query.view === 'upcoming' || query.view === 'overdue') {
        const upcomingDays = await upcomingDaysOf(
          query.upcomingDays,
          async () => (await readEffectiveSetting(tx, ctx.tenantId, RETIREMENT_UPCOMING_DAYS_KEY)).value,
        );
        const persons = await listRetirementPersons(
          tx,
          ctx.tenantId,
          { view: query.view, at, upcomingDays, page, show },
          ctx.scope,
        );
        return { ...persons, ...(query.view === 'upcoming' ? { upcomingDays } : {}) };
      }
      return listRetirementBills(tx, ctx.tenantId, { view: query.view, at, page, show }, ctx.scope);
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
    return c.json(trimRetirementDetail(detail, await viewableIn(deps, ctx)));
  });
}
