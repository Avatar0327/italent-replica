/**
 * 缺失即失败（§2.3 验证算法）：createApp 末尾枚举 app.routes，每条条目都必须是已登记的中间件或已声明的包装函数，
 * 且 method / 最终路径与登记一致；未声明 → 抛错（应用无法启动，测试失败）。随后封闭注册（Hono 匹配器一经构建
 * 即拒绝新增路由，实测）。
 */
import type { Env, Hono } from 'hono';
import { rawRouter, unwrapComposed } from './declare.js';
import { type Declaration, registryOf, type RouteRegistry, RoutePolicyError } from './registry.js';
import type { RoutePolicy } from './types.js';

/** 运行时清单里的一条已声明端点：`key` 是登记表键（METHOD 本地路径），`path` 是挂载后的最终路径。 */
export interface ManifestRoute {
  readonly key: string;
  readonly method: string;
  readonly path: string;
  readonly module: string;
  readonly policy: RoutePolicy;
}

export interface RouteManifest {
  readonly declared: readonly ManifestRoute[];
  readonly middleware: readonly { readonly label: string; readonly paths: readonly string[] }[];
}

interface RouteEntry {
  readonly method: string;
  readonly path: string;
  readonly handler: unknown;
}
interface Sealable {
  readonly routes: RouteEntry[];
  readonly router: { match(method: string, path: string): unknown };
}

const manifestByRouter = new WeakMap<object, RouteManifest>();

function fail(code: ConstructorParameters<typeof RoutePolicyError>[0], message: string): never {
  throw new RoutePolicyError(code, message);
}

function checkEntry(
  registry: RouteRegistry,
  entry: RouteEntry,
  seenPaths: Map<string, Declaration>,
): Declaration | undefined {
  const fn = unwrapComposed(entry.handler) as (...args: unknown[]) => unknown;
  const middleware = registry.middlewareOf(fn);
  if (middleware) {
    if (entry.method !== 'ALL' || !middleware.paths.has(entry.path)) {
      fail(
        'ROUTE_MIDDLEWARE_MISMATCH',
        `${middleware.label} 登记在 ${[...middleware.paths].join(' | ')}，实际 ${entry.method} ${entry.path}`,
      );
    }
    return undefined;
  }
  const declaration = registry.declarationOf(fn);
  if (!declaration) {
    if (entry.method === 'ALL') {
      fail('ROUTE_MIDDLEWARE_UNREGISTERED', `ALL ${entry.path}：.all() 或未经 useMiddleware 登记的中间件`);
    }
    fail('ROUTE_UNDECLARED', `${entry.method} ${entry.path} 没有声明`);
  }
  if (entry.method !== declaration.method || entry.path !== declaration.expectedFullPath) {
    fail('ROUTE_ALIAS', `${declaration.key} 的处理函数又被注册为 ${entry.method} ${entry.path}`);
  }
  if (declaration.seen) fail('ROUTE_DUPLICATE_REGISTRATION', `${declaration.key} 的同一包装注册了两次`);
  const pathKey = `${entry.method} ${entry.path}`;
  const other = seenPaths.get(pathKey);
  if (other) fail('ROUTE_DUPLICATE_PATH', `${pathKey} 同时由 ${other.key} 与 ${declaration.key} 注册`);
  seenPaths.set(pathKey, declaration);
  declaration.seen = true;
  return declaration;
}

/**
 * 校验并封闭。返回运行时清单（已声明端点与中间件），供 FW-01 统计与现状必测基准对账。
 * 任何失败都抛 RoutePolicyError（DEC-300：缺失声明与身份不匹配始终失败）。
 */
export function verifyRouteDeclarations<E extends Env>(app: Hono<E>): RouteManifest {
  const target = rawRouter(app) as unknown as Sealable;
  const registry = registryOf(target);
  const seenPaths = new Map<string, Declaration>();
  const declared: ManifestRoute[] = [];
  for (const entry of target.routes) {
    const declaration = checkEntry(registry, entry, seenPaths);
    if (declaration) {
      declared.push({
        key: declaration.key,
        method: entry.method,
        path: entry.path,
        module: declaration.module,
        policy: declaration.policy,
      });
    }
  }
  for (const declaration of registry.declarations) {
    if (!declaration.seen) fail('ROUTE_DECLARATION_UNMOUNTED', `${declaration.key} 已声明但没有出现在应用路由里`);
  }
  for (const table of registry.tables) {
    for (const key of table.keys()) {
      if (!registry.isUsed(table, key))
        fail('ROUTE_DECLARATION_UNUSED', `登记表 ${table.name} 的 ${key} 没有对应的注册`);
    }
  }
  // 封闭：预构建匹配器后 Hono 自身拒绝再 add（实测），再冻结 routes 数组
  target.router.match('GET', '/__route_policy_seal__');
  Object.freeze(target.routes);
  const manifest: RouteManifest = {
    declared,
    middleware: registry.middleware.map((m) => ({ label: m.label, paths: [...m.paths] })),
  };
  manifestByRouter.set(target, manifest);
  return manifest;
}

/** 取某个应用经 verifyRouteDeclarations 校验后的运行时清单（createApp 末尾已校验）。 */
export function routeManifest<E extends Env>(app: Hono<E>): RouteManifest {
  const manifest = manifestByRouter.get(rawRouter(app));
  if (!manifest) throw new Error('应用尚未经过 verifyRouteDeclarations 校验');
  return manifest;
}
