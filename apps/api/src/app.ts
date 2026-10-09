import { registerContractRoutes } from './modules/contracts/routes.js';
import { registerEmployeeSelfServiceRoutes } from './modules/employee-self-service/routes.js';
import type { Db } from '@italent/db';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Authorizer } from './authorization.js';
import { AppError, errorResponse, handleError } from './errors.js';
import { denyAllIdentity, type IdentityResolver } from './identity.js';
import { DEFAULT_BODY_LIMIT, limitBody, requireJson } from './middleware.js';
import type { TenantRouteDeps, TenantRouteModule } from './routes.js';
import { type TenantEnv, tenantContext } from './tenant-context.js';
import { registerTenantSettingRoutes } from './modules/tenant-settings/routes.js';
import {
  createPermissionAuthorizer,
  PERMISSION_BODY_LIMITS,
  registerPermissionRoutes,
} from './modules/permission/index.js';
import { registerOrgRoutes } from './modules/org/routes.js';
import { registerJobEstablishmentRoutes } from './modules/job/register.js';
import { registerPersonnelRoutes } from './modules/personnel/routes.js';
import { registerEmploymentRoutes } from './modules/employment/routes.js';
import { registerApprovalRoutes } from './modules/approval/routes.js';
import { createPlatformRouter } from './modules/platform/routes.js';
import { auditRequestContext } from './audit/request-context.js';
import { registerAuditRoutes } from './audit/routes.js';
import { captureCommandFailures } from './audit/capture.js';
import { ROOT_POLICIES, tenantPolicyTable } from './app-policy.js';
import { policed, type PolicyTable, useMiddleware, verifyRouteDeclarations } from './route-policy/index.js';

/** 租户业务模块：新模块只在此追加一行注册，不改其他装配逻辑。 */
const TENANT_MODULES: readonly TenantRouteModule[] = [
  registerTenantSettingRoutes, // R1-T00 两层配置
  registerPermissionRoutes, // R1-T01 权限模型
  registerOrgRoutes, // R1-T03 多维组织
  registerJobEstablishmentRoutes, // R1-T04 职务体系与编制
  registerEmploymentRoutes, // R1-T05 任职记录版本链
  registerPersonnelRoutes, // R1-T12 人员信息与子集
  registerApprovalRoutes, // R1-T07 审批中心
  registerContractRoutes, // R2-T06 合同协议
  registerEmployeeSelfServiceRoutes, // R1-T13 员工自助，仅本人
  registerAuditRoutes, // R1-T16 审计日志
];

export interface AppDeps {
  /** 不传则 /healthz 只报告进程存活，不探测数据库，也不挂载租户接口。 */
  readonly db?: Db;
  /** 身份解析；缺省谁都不认（401）。生产实现由 B-01 提供，见 identity.ts。 */
  readonly identity?: IdentityResolver;
  /** 授权钩子；缺省按权限模型判定（R1-T01），无数据库时一律拒绝。测试可注入替身。 */
  readonly authorize?: Authorizer | undefined;
  readonly clock?: () => Date;
  /** 额外的租户路由模块（后续业务模块、测试夹具）。 */
  readonly tenantRoutes?: readonly TenantRouteModule[];
  /** 额外租户路由模块的声明登记表（F-039）：每条注册都必须在表里有声明，否则 createApp 抛错。 */
  readonly routePolicies?: readonly PolicyTable[];
}

export function createApp(deps: AppDeps = {}): Hono {
  const app = new Hono();
  // F-039：根路由器套登记表，每条注册与中间件都登记，createApp 末尾校验「缺失即失败」并封闭
  const root = policed(app, ROOT_POLICIES);

  // 审计的请求来源（IP、终端、来源页面、TraceID，R1-T16）：最先挂载，失败的请求同样带 TraceID
  useMiddleware(root, '*', auditRequestContext(deps.clock ?? (() => new Date())), 'auditRequestContext');
  useMiddleware(root, '*', requireJson, 'requireJson');
  // 默认 32KB；只有登记的个别接口放宽且仍有上限（身份对象权限整对象替换，见 permission/routes.ts）
  useMiddleware(
    root,
    '*',
    limitBody(DEFAULT_BODY_LIMIT, [
      ...PERMISSION_BODY_LIMITS,
      {
        method: 'POST',
        path: /^\/api\/tenant\/contracts\/imports(?:\/(?:preview|errors))?$/,
        maxSize: 16 * 1024 * 1024,
      },
      { method: 'POST', path: /^\/api\/tenant\/contracts\/batch$/, maxSize: 1024 * 1024 },
    ]),
    'limitBody',
  );

  root.get('/healthz', async (c) => {
    if (deps.db) {
      try {
        await deps.db.execute(sql`SELECT 1`);
      } catch {
        throw new AppError('SERVICE_UNAVAILABLE', '数据库不可用');
      }
    }
    return c.json({ status: 'ok' as const });
  });

  if (deps.db) {
    root.route('/', createTenantRouter(deps.db, deps));
    // 平台运营层（R1-T17）：只认平台运营身份，与租户上下文和租户内权限互不相通
    root.route('/', createPlatformRouter(deps.db, deps.identity ?? denyAllIdentity, deps.clock ?? (() => new Date())));
  }

  app.notFound((c) => errorResponse(c, 'NOT_FOUND', '接口不存在'));
  app.onError(handleError);
  // 缺失声明即失败（DEC-300 / DEC-303）：任何未声明、别名或未登记中间件都在这里抛错，应用无法启动
  verifyRouteDeclarations(app);
  return app;
}

function createTenantRouter(db: Db, deps: AppDeps): Hono<TenantEnv> {
  const routeDeps: TenantRouteDeps = {
    db,
    authorize: deps.authorize ?? createPermissionAuthorizer(db, undefined, deps.clock),
    clock: deps.clock ?? (() => new Date()),
  };
  const router = policed(new Hono<TenantEnv>(), tenantPolicyTable(deps.routePolicies));
  // 所有租户接口都在 /api/tenant/ 之下，每次请求都重验身份、成员关系与租户状态
  useMiddleware(router, '/api/tenant/*', tenantContext(db, deps.identity ?? denyAllIdentity), 'tenantContext');
  // 身份与租户确认后，兜底记录执行器之前被拒绝的写命令（R1-T16 第二轮 P2-7）
  useMiddleware(router, '/api/tenant/*', captureCommandFailures(db), 'captureCommandFailures');
  for (const register of [...TENANT_MODULES, ...(deps.tenantRoutes ?? [])]) register(router, routeDeps);
  return router;
}
