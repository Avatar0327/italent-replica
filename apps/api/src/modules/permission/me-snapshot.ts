/**
 * 当前用户权限快照（DEC-469）：一次请求给出前台首屏需要的会话资料、各应用可见性与入口对象、数据范围摘要、企业设置菜单。
 * 只读，不写库；对象判定走 object-access.ts 的唯一入口，与 /me/objects、授权器 object.view 同口径。
 * 不返回字段清单与按钮清单（任职对象 274 字段 / 349 按钮，体积过大），对象级细节仍走 /me/objects/:objectCode 懒加载。
 * 设计与口径见 docs/08_设计/演示配套_当前用户权限快照_路由声明.md。
 */
import { getTenant, getUser, type Tx, withTenant } from '@italent/db';
import {
  APP_IDS,
  APP_OBJECT_DIRECTORY,
  type AppId,
  buttonResource,
  decide,
  MODULE_OBJECTS,
  type ObjectCatalog,
  tenantLocalDate,
  visibleEnterpriseMenus,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext } from '../../tenant-context.js';
import { boundEmployee } from '../employee-self-service/access.js';
import { managerIdentity, type ManagerQuery } from './manager-identity.js';
import { resolveModuleScopeInTransaction } from './module-access.js';
import { createObjectAccess } from './object-access.js';
import type { ModuleScope } from './scope-types.js';
import { loadSubject } from './subject.js';

/** limited 时最多返回的组织数；超出置 truncated，前台不得把被截断的集合当作完整范围。 */
export const SNAPSHOT_ORG_LIMIT = 200;
/** 没有“数据范围”概念的应用：审批中心按本人待办、员工自助按本人档案、企业设置按管理员能力。 */
const NO_SCOPE_APPS: ReadonlySet<AppId> = new Set<AppId>(['approval', 'self', 'settings']);
const EMPLOYMENT_RECORD = MODULE_OBJECTS.employmentRecord.code;

export interface ScopeSummary {
  readonly app: AppId;
  readonly status: 'all' | 'limited' | 'none';
  readonly organizationIds: string[];
  readonly truncated: boolean;
}

/** 只给摘要：all；有任一数据范围项 → limited（带组织集合，按人员 / 汇报关系 / 创建人取值的项没有组织）；否则 none。 */
export function summarizeScope(app: AppId, scope: ModuleScope): ScopeSummary {
  if (scope.all) return { app, status: 'all', organizationIds: [], truncated: false };
  if (!scope.hasDataPermission) return { app, status: 'none', organizationIds: [], truncated: false };
  const ids = [...new Set([...scope.orgIds, ...(scope.terms ?? []).flatMap((term) => term.orgIds)])];
  return {
    app,
    status: 'limited',
    organizationIds: ids.slice(0, SNAPSHOT_ORG_LIMIT),
    truncated: ids.length > SNAPSHOT_ORG_LIMIT,
  };
}

/** 整个响应体（UTF-8 字节）的上限 = 请求 / 响应的默认 32KB 约定（AGENTS.md §10「请求」）。 */
export const SNAPSHOT_BODY_LIMIT = 32 * 1024;

/**
 * 整包字节预算：各应用的组织集合共用 `budgetBytes`（同一组织在多个应用重复出现时重复计入）。
 * 轮流给每个应用补一个组织，直到预算用完或都给完，因此小范围应用总是完整，大范围应用平分剩余预算；
 * 任何应用被省略或截短都置 truncated=true，status 不变（仍是 limited，前台不得当作完整范围）。
 */
export function fitScopeToBudget(scope: readonly ScopeSummary[], budgetBytes: number): ScopeSummary[] {
  const kept = scope.map(() => 0);
  let remaining = budgetBytes;
  for (let progressed = true; progressed;) {
    progressed = false;
    scope.forEach((item, index) => {
      const id = item.organizationIds[kept[index]!];
      // 每个元素的字节数 = JSON 字符串本身 + 一个逗号分隔符（多算一个逗号，偏保守）
      const cost = id === undefined ? 0 : Buffer.byteLength(JSON.stringify(id), 'utf8') + 1;
      if (id === undefined || cost > remaining) return;
      remaining -= cost;
      kept[index]! += 1;
      progressed = true;
    });
  }
  return scope.map((item, index) => ({
    ...item,
    organizationIds: item.organizationIds.slice(0, kept[index]),
    truncated: item.truncated || kept[index]! < item.organizationIds.length,
  }));
}

type Deps = Pick<TenantRouteDeps, 'db' | 'authorize' | 'clock'>;

export async function buildPermissionSnapshot(deps: Deps, ctx: TenantContext, catalog: ObjectCatalog) {
  // 平台层资料（租户名、显示名）不在租户事务的可读范围内，先读；中间件已校验成员与租户可用，这里只防御
  const [tenant, user] = await Promise.all([getTenant(deps.db, ctx.tenantId), getUser(deps.db, ctx.userId)]);
  if (!tenant || !user) throw new AppError('TENANT_NOT_MEMBER', '不是该租户的成员');
  const today = tenantLocalDate(deps.clock(), ctx.timezone);
  return withTenant(deps.db, ctx.tenantId, async (tx) => {
    const query: ManagerQuery = { tenantId: ctx.tenantId, userId: ctx.userId, asOf: today };
    // 不传 objectCode：一次取全部有效身份（含经理默认身份）的对象权限，不按对象逐个查库
    const subject = await loadSubject(tx, ctx.userId, undefined, query);
    const access = createObjectAccess(tx, ctx.userId, subject, catalog);
    const entryObjects = new Map<AppId, string[]>();
    for (const app of APP_IDS) {
      const codes: string[] = [];
      for (const code of APP_OBJECT_DIRECTORY[app]) if (await access.resolve(code)) codes.push(code);
      entryObjects.set(app, codes);
    }
    const employee = await ownEmployee(tx, ctx);
    const adminMenus = visibleEnterpriseMenus(subject.adminRoles);
    const managerVisible =
      !!(await access.resolve(EMPLOYMENT_RECORD)) &&
      (await managerIdentity(tx, query)).active &&
      ['Transfer.Manager', 'Transfer.Hr'].some((button) =>
        decide(
          subject,
          { action: 'object.button', resource: buttonResource(EMPLOYMENT_RECORD, button, 'detail') },
          catalog,
        ),
      );
    const visible = (app: AppId): boolean => {
      // 以下四个应用的可见性与旧前端探测的专用接口同口径，不以对象授权代替本人关系或管理能力
      if (app === 'settings') return adminMenus.length > 0;
      if (app === 'self') return employee !== null;
      if (app === 'manager') return managerVisible;
      // GET /approval/todos 只按本人待办取数，任何有效成员都可访问
      if (app === 'approval') return true;
      return entryObjects.get(app)!.length > 0;
    };
    const scope: ScopeSummary[] = [];
    for (const app of APP_IDS) {
      if (NO_SCOPE_APPS.has(app)) continue;
      // 数据范围按（用户 × 应用）一份，策略按对象；取该应用第一个可查看的入口对象为代表
      const representative =
        app === 'manager' ? (managerVisible ? EMPLOYMENT_RECORD : undefined) : entryObjects.get(app)![0];
      scope.push(
        representative
          ? summarizeScope(app, await resolveModuleScopeInTransaction(deps, ctx, tx, representative))
          : summarizeScope(app, { orgIds: [], personIds: [], all: false, hasDataPermission: false }),
      );
    }
    const response = {
      session: {
        tenantId: ctx.tenantId,
        tenantName: tenant.name,
        timezone: ctx.timezone,
        today,
        userId: ctx.userId,
        displayName: user.displayName,
        employeeId: employee?.id ?? null,
      },
      apps: APP_IDS.map((app) => ({ app, visible: visible(app), entryObjects: entryObjects.get(app)! })),
      scope,
      adminMenus,
    };
    // 先按“组织集合全空”算出其余部分占用的字节，剩余预算再分给各应用的组织集合
    const base = Buffer.byteLength(
      JSON.stringify({ ...response, scope: scope.map((item) => ({ ...item, organizationIds: [] })) }),
      'utf8',
    );
    return { ...response, scope: fitScopeToBudget(scope, SNAPSHOT_BODY_LIMIT - base) };
  });
}

/** 与 GET /self-service/profile 同一个判定函数（selfAccess 内的 boundEmployee）；未绑定员工 → null。 */
async function ownEmployee(tx: Tx, ctx: TenantContext) {
  try {
    return await boundEmployee(tx, ctx);
  } catch (error) {
    if (error instanceof AppError && error.code === 'FORBIDDEN') return null;
    throw error;
  }
}
