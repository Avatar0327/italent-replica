import type { Db } from '@italent/db';
import type { Hono } from 'hono';
import type { Authorizer } from './authorization.js';
import type { TenantEnv } from './tenant-context.js';

/** 租户路由可用的依赖。路由一律挂在 /api/tenant/ 之下，经过租户上下文中间件。 */
export interface TenantRouteDeps {
  readonly db: Db;
  readonly authorize: Authorizer;
  /** 注入时钟，便于测试跨日与时区（DEC-056）；写入的事件时间是 UTC 瞬时。 */
  readonly clock: () => Date;
}

/** 业务模块（及测试夹具）向租户路由器注册接口的方式。 */
export type TenantRouteModule = (router: Hono<TenantEnv>, deps: TenantRouteDeps) => void;
