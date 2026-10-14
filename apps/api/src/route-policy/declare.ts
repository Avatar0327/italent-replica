/**
 * 声明登记（§2.3 注册与绑定；§3.1 PR-A 的执行点）。
 *
 * - `declare(router, method, path, policy, handler)`：为每次注册生成独立的包装函数 w，登记 Declaration，再把 w 注册到
 *   原生 Hono 路由器。校验按**注册实例**（w 的函数身份）绑定，不只看 method / path。
 * - `policed(router, table)`：返回一个代理路由器——`get / post / put / patch / delete / on` 从登记表按
 *   `METHOD localPath` 取 policy 后走 declare；`use` 走 useMiddleware；`route` 走 mount；`all / basePath / mount`
 *   直接拒绝。模块的路由文件因此不用改：注册行照旧，声明集中在模块级 policy.ts。
 * - PR-A 的包装只做运行时自检（有效方法 HEAD → GET、routePath 与声明一致），然后原样调用处理函数：
 *   不解析请求体、不鉴权、不改响应（DEC-297④ / DEC-300）。
 * - 接管 T1：所在模块列在 TAKEN_OVER_MODULES 时，verifyRouteDeclarations 给声明编译执行计划，包装改由引擎
 *   按声明执行准入后再调用处理函数（enforce.ts）；未接管模块没有计划，行为不变。
 */
import type { Context, Env, Hono, Next } from 'hono';
import { routePath } from 'hono/route';
import { AppError } from '../errors.js';
import { runPlan } from './enforce.js';
import {
  attachRegistry,
  type Declaration,
  moveMiddlewarePath,
  registryOf,
  RoutePolicyError,
  type RouteRegistry,
} from './registry.js';
import { METHODS, type PolicyTable, policyKey } from './table.js';
import type { HttpMethod, RoutePolicy } from './types.js';

const RAW = Symbol.for('italent.route-policy.raw');
const COMPOSED_HANDLER = '__COMPOSED_HANDLER';

/** 原生 Hono 路由器在本模块内用到的最小结构（避免在 Hono 的泛型上做类型体操）。 */
interface RouteEntry {
  readonly method: string;
  readonly path: string;
  readonly handler: unknown;
}
interface RawRouter {
  readonly routes: RouteEntry[];
  readonly router: { match(method: string, path: string): unknown };
  on(method: string, path: string, handler: unknown): unknown;
  use(path: string, handler: unknown): unknown;
  route(path: string, app: RawRouter): unknown;
}
type RouteHandler<E extends Env = Env> = (c: Context<E>, next: Next) => unknown;

/** 取代理背后的原生路由器（未代理的原样返回）。 */
export function rawRouter<E extends Env>(router: Hono<E>): Hono<E> {
  return ((router as unknown as Record<symbol, unknown>)[RAW] as Hono<E> | undefined) ?? router;
}

function raw(router: object): RawRouter {
  return rawRouter(router as Hono<Env>) as unknown as RawRouter;
}

/** 剥掉 Hono 为子应用 onError 生成的包装层（可能多层），得到注册时的原函数。 */
export function unwrapComposed(handler: unknown): unknown {
  let fn = handler;
  while (typeof fn === 'function' && (fn as unknown as Record<string, unknown>)[COMPOSED_HANDLER]) {
    fn = (fn as unknown as Record<string, unknown>)[COMPOSED_HANDLER];
  }
  return fn;
}

function lastRoute(router: RawRouter): RouteEntry {
  const entry = router.routes.at(-1);
  if (!entry) throw new RoutePolicyError('ROUTE_ALIAS', '注册后路由表为空');
  return entry;
}

function wrap<E extends Env>(handler: RouteHandler<E>, declaration: Declaration): RouteHandler<E> {
  return async function routePolicyWrapper(c, next) {
    const effective = c.req.method === 'HEAD' ? 'GET' : c.req.method;
    const actual = routePath(c);
    if (effective !== declaration.method || actual !== declaration.expectedFullPath) {
      throw new AppError('ROUTE_POLICY_MISMATCH', '路由声明与注册实例不一致', {
        declared: declaration.key,
        expectedPath: declaration.expectedFullPath,
        method: effective,
        path: actual,
      });
    }
    // 接管 T1：模块已接管时由引擎按声明执行准入；否则原样调用（PR-A 行为，零变化）
    if (declaration.plan) return runPlan(declaration.plan, c as Context, next, handler as never);
    return handler(c, next);
  };
}

export interface DeclareOptions {
  /** 所属模块（统计用）；经登记表声明时取表里的模块名。 */
  readonly module?: string;
}

/** 为一条路由登记声明并注册：同一路由器上同一 `METHOD localPath` 只能声明一次。 */
export function declare<E extends Env>(
  router: Hono<E>,
  method: HttpMethod,
  path: string,
  policy: RoutePolicy,
  handler: RouteHandler<E>,
  options: DeclareOptions = {},
): Hono<E> {
  const target = raw(router);
  const registry = registryOf(target);
  const key = policyKey(method, path);
  registry.claimKey(target, key);
  const declaration: Declaration = {
    key,
    module: options.module ?? 'inline',
    method,
    localPath: path,
    expectedFullPath: path,
    policy,
    seen: false,
  };
  const wrapper = wrap(handler, declaration);
  registry.bindWrapper(wrapper, declaration);
  target.on(method, path, wrapper);
  declaration.expectedFullPath = lastRoute(target).path;
  return router;
}

/** 多方法同一处理函数：每个方法一条独立声明与包装（§2.3）。 */
export function declareEach<E extends Env>(
  router: Hono<E>,
  methods: readonly HttpMethod[],
  path: string,
  policy: RoutePolicy,
  handler: RouteHandler<E>,
  options: DeclareOptions = {},
): Hono<E> {
  for (const method of methods) declare(router, method, path, policy, handler, options);
  return router;
}

/** 登记中间件：注册后读回 Hono 规范化的路径（`'*'` → `/*`），经 mount 时再回填挂载后的最终路径。 */
export function useMiddleware<E extends Env>(
  router: Hono<E>,
  path: string,
  middleware: RouteHandler<E>,
  label?: string,
): Hono<E> {
  const target = raw(router);
  target.use(path, middleware);
  registryOf(target).bindMiddleware(middleware, lastRoute(target).path, label || middleware.name || 'anonymous');
  return router;
}

/** 挂载子路由器：挂载后按注册顺序把每条新增条目的最终路径回填给对应的声明 / 中间件登记，并合并登记簿。 */
export function mount<E extends Env, S extends Env>(router: Hono<E>, prefix: string, sub: Hono<S>): Hono<E> {
  const target = raw(router);
  const subTarget = raw(sub);
  const registry = registryOf(target);
  const subRegistry = registryOf(subTarget);
  const before = target.routes.length;
  target.route(prefix, subTarget);
  const added = target.routes.slice(before);
  if (added.length !== subTarget.routes.length) {
    throw new RoutePolicyError(
      'ROUTE_ALIAS',
      `挂载 ${prefix} 后新增 ${added.length} 条，子路由器有 ${subTarget.routes.length} 条`,
    );
  }
  subTarget.routes.forEach((subRoute, index) => {
    const parentRoute = added[index]!;
    const fn = unwrapComposed(subRoute.handler) as (...args: unknown[]) => unknown;
    const declaration = subRegistry.declarationOf(fn);
    if (declaration) {
      declaration.expectedFullPath = parentRoute.path;
      return;
    }
    const middleware = subRegistry.middlewareOf(fn);
    if (middleware) {
      moveMiddlewarePath(middleware, subRoute.path, parentRoute.path);
    }
  });
  registry.absorb(subRegistry);
  attachRegistry(subTarget, registry);
  return router;
}

const LOWER_METHODS = new Set([...METHODS].map((m) => m.toLowerCase()));
const FORBIDDEN = new Set(['all', 'basePath', 'mount']);

function declareFromTable(
  target: RawRouter,
  registry: RouteRegistry,
  table: PolicyTable,
  method: string,
  path: string,
  handlers: readonly unknown[],
): void {
  if (handlers.length !== 1 || typeof handlers[0] !== 'function') {
    throw new RoutePolicyError(
      'ROUTE_POLICY_INLINE_HANDLERS',
      `${method} ${path}：每条路由只能注册一个处理函数，中间件请经 useMiddleware 登记`,
    );
  }
  const key = policyKey(method, path);
  const hit = table.lookup(key);
  if (!hit) throw new RoutePolicyError('ROUTE_UNDECLARED', `${key} 不在登记表 ${table.name} 里，拒绝注册`);
  registry.markUsed(table, key);
  declare(
    target as unknown as Hono<Env>,
    method.toUpperCase() as HttpMethod,
    path,
    hit.policy,
    handlers[0] as RouteHandler,
    {
      module: hit.module,
    },
  );
}

/**
 * 给路由器套上登记表：此后在它上面的每次注册都必须在表里有对应声明，否则注册当场失败（应用无法启动）。
 * 返回值在类型上仍是 Hono，模块的注册函数签名不用改。
 */
export function policed<E extends Env>(router: Hono<E>, table: PolicyTable): Hono<E> {
  const target = raw(router);
  const registry = registryOf(target);
  registry.tables.add(table);
  const handler: ProxyHandler<object> = {
    get(obj, prop, receiver) {
      if (prop === RAW) return target;
      if (typeof prop !== 'string') return Reflect.get(obj, prop, obj);
      if (LOWER_METHODS.has(prop)) {
        return (path: string | readonly string[], ...handlers: unknown[]) => {
          for (const p of typeof path === 'string' ? [path] : path) {
            declareFromTable(target, registry, table, prop.toUpperCase(), p, handlers);
          }
          return receiver;
        };
      }
      if (prop === 'on') {
        return (method: string | readonly string[], path: string | readonly string[], ...handlers: unknown[]) => {
          for (const m of typeof method === 'string' ? [method] : method) {
            for (const p of typeof path === 'string' ? [path] : path) {
              declareFromTable(target, registry, table, m.toUpperCase(), p, handlers);
            }
          }
          return receiver;
        };
      }
      if (prop === 'use') {
        return (path: string, ...middlewares: unknown[]) => {
          if (typeof path !== 'string') {
            throw new RoutePolicyError('ROUTE_POLICY_INLINE_HANDLERS', 'use 必须写明路径');
          }
          for (const mw of middlewares) useMiddleware(target as unknown as Hono<Env>, path, mw as RouteHandler);
          return receiver;
        };
      }
      if (prop === 'route') {
        return (prefix: string, sub: Hono<Env>) => {
          mount(target as unknown as Hono<Env>, prefix, sub);
          return receiver;
        };
      }
      if (FORBIDDEN.has(prop)) {
        return () => {
          throw new RoutePolicyError('ROUTE_POLICY_ALL_FORBIDDEN', `${prop}() 不纳入声明登记，禁止使用`);
        };
      }
      return Reflect.get(obj, prop, obj);
    },
  };
  return new Proxy(router as object, handler) as Hono<E>;
}

/** 在父路由器的登记簿下新建一个子应用并套上登记表（替代 `new Hono()`），再由父路由器 `route()` 挂载。 */
export function policedSub<E extends Env>(parent: Hono<E>, table: PolicyTable, factory: () => Hono<E>): Hono<E> {
  const sub = factory();
  attachRegistry(raw(sub), registryOf(raw(parent)));
  return policed(sub, table);
}
