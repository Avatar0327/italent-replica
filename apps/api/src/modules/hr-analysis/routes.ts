/**
 * 人事分析模块（R2-T10 / M-ana；BE-12a 时点花名册）。BE-12b 的看板指标路由在此追加，模块注册只此一处。
 */
import type { Hono } from 'hono';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { registerRosterRoutes } from './roster-routes.js';

export function registerHrAnalysisRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  registerRosterRoutes(router, deps);
}
