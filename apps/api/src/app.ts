import type { Db } from '@italent/db';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { type Authorizer, defaultAuthorizer } from './authorization.js';
import { AppError, errorResponse, handleError } from './errors.js';
import { denyAllIdentity, type IdentityResolver } from './identity.js';
import { limitBody, requireJson } from './middleware.js';
import type { TenantRouteDeps, TenantRouteModule } from './routes.js';
import { type TenantEnv, tenantContext } from './tenant-context.js';
import { registerTenantSettingRoutes } from './modules/tenant-settings/routes.js';

/** 租户业务模块：新模块只在此追加一行注册，不改其他装配逻辑。 */
const TENANT_MODULES: readonly TenantRouteModule[] = [
  registerTenantSettingRoutes, // R1-T00 两层配置
];

export interface AppDeps {
  /** 不传则 /healthz 只报告进程存活，不探测数据库，也不挂载租户接口。 */
  readonly db?: Db;
  /** 身份解析；缺省谁都不认（401）。生产实现由 B-01 提供，见 identity.ts。 */
  readonly identity?: IdentityResolver;
  /** 授权钩子；缺省只放行读（R1-T01 接入真实判定）。 */
  readonly authorize?: Authorizer | undefined;
  readonly clock?: () => Date;
  /** 额外的租户路由模块（后续业务模块、测试夹具）。 */
  readonly tenantRoutes?: readonly TenantRouteModule[];
}

export function createApp(deps: AppDeps = {}): Hono {
  const app = new Hono();

  app.use('*', requireJson);
  app.use('*', limitBody());

  app.get('/healthz', async (c) => {
    if (deps.db) {
      try {
        await deps.db.execute(sql`SELECT 1`);
      } catch {
        throw new AppError('SERVICE_UNAVAILABLE', '数据库不可用');
      }
    }
    return c.json({ status: 'ok' as const });
  });

  if (deps.db) app.route('/', createTenantRouter(deps.db, deps));

  app.notFound((c) => errorResponse(c, 'NOT_FOUND', '接口不存在'));
  app.onError(handleError);
  return app;
}

function createTenantRouter(db: Db, deps: AppDeps): Hono<TenantEnv> {
  const routeDeps: TenantRouteDeps = {
    db,
    authorize: deps.authorize ?? defaultAuthorizer,
    clock: deps.clock ?? (() => new Date()),
  };
  const router = new Hono<TenantEnv>();
  // 所有租户接口都在 /api/tenant/ 之下，每次请求都重验身份、成员关系与租户状态
  router.use('/api/tenant/*', tenantContext(db, deps.identity ?? denyAllIdentity));
  for (const register of [...TENANT_MODULES, ...(deps.tenantRoutes ?? [])]) register(router, routeDeps);
  return router;
}
