/**
 * 人事看板路由（R2-T10 BE-12b，规格 35 §2.1）：
 * - GET /api/tenant/analytics/hr-dashboard?asOf=：23 项指标的数字（编码、名称、数值）；
 * - GET /api/tenant/analytics/hr-dashboard/indicators/:code?asOf=&page=&pageSize=：构成该数字的明细 ID 列表（分页）。
 * 权限链：对象 TenantBase.HrDashboard 的查看权（授权项“人事分析 - 人事看板 查看”）→ 同对象的数据范围（看全部默认给人事预置管理员，
 * 其余按管理单元，默认空即 0，不退回全部）。数字与明细共用 hr-dashboard.ts 的同一份候选行，所以范围、asOf 完全一致。
 * 只读：不写台账、不写审计；asOf 只是业务有效日，权限一律取当前（AGENTS §10）。
 */
import { withTenant } from '@italent/db';
import { HR_DASHBOARD_INDICATORS, HR_DASHBOARD_OBJECT, tenantLocalDate, type HrDashboardCode } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { pageQuery } from '../job/context.js';
import { objectContext, requestScope } from '../permission/module-route-access.js';
import { registerPersonScopedObject } from '../permission/scope-resolver.js';
import { dashboardRenewalTypes, hrDashboardCounts, hrDashboardPage, type DashboardAsOf } from './hr-dashboard.js';

export const HR_DASHBOARD_BASE = '/api/tenant/analytics/hr-dashboard';

// 人员类指标按员工归属裁剪：组织类范围规则对本对象同样带出“按人员”的关联谓词（与员工信息类对象同口径）
registerPersonScopedObject(HR_DASHBOARD_OBJECT);

const asOfSchema = z.iso.date();

async function dashboardContext(c: Context<TenantEnv>, deps: TenantRouteDeps) {
  const base = await objectContext(c, deps, HR_DASHBOARD_OBJECT, 'view');
  const scope = await requestScope(c, deps, base, HR_DASHBOARD_OBJECT);
  const raw = c.req.query('asOf');
  const parsed = raw === undefined ? undefined : asOfSchema.safeParse(raw);
  if (parsed && !parsed.success) throw new AppError('VALIDATION_FAILED', 'asOf 必须是 YYYY-MM-DD 日期');
  const asOf = parsed?.data ?? tenantLocalDate(base.now, base.timezone);
  return { base, scope, asOf };
}

export function registerHrDashboardRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(HR_DASHBOARD_BASE, async (c) => {
    const { base, scope, asOf } = await dashboardContext(c, deps);
    const counts = await withTenant(deps.db, base.tenantId, async (tx) =>
      hrDashboardCounts(tx, {
        tenantId: base.tenantId,
        asOf,
        timezone: base.timezone,
        scope,
        renewalTypeIds: await dashboardRenewalTypes(tx, base.tenantId),
      }),
    );
    return c.json({
      asOf,
      hasDataPermission: scope.hasDataPermission,
      indicators: HR_DASHBOARD_INDICATORS.map((indicator) => ({
        ...indicator,
        value: counts.get(indicator.code) ?? 0,
      })),
    });
  });

  router.get(`${HR_DASHBOARD_BASE}/indicators/:code`, async (c) => {
    const { base, scope, asOf } = await dashboardContext(c, deps);
    const indicator = HR_DASHBOARD_INDICATORS.find((item) => item.code === c.req.param('code'));
    if (!indicator) throw new AppError('NOT_FOUND', '指标不存在');
    const page = pageQuery(c);
    const result = await withTenant(deps.db, base.tenantId, async (tx) => {
      const context: DashboardAsOf = {
        tenantId: base.tenantId,
        asOf,
        timezone: base.timezone,
        scope,
        renewalTypeIds: await dashboardRenewalTypes(tx, base.tenantId),
      };
      return hrDashboardPage(tx, indicator.code as HrDashboardCode, context, page);
    });
    return c.json({
      asOf,
      ...indicator,
      ...result,
      page: page.page,
      pageSize: page.pageSize,
      hasDataPermission: scope.hasDataPermission,
    });
  });
}
