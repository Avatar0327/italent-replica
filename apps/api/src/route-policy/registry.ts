/**
 * 声明登记簿：每个 createApp 一份，记录全部声明、已登记中间件与用过的登记表（§2.3 注册与绑定）。
 * 包装函数 → 声明、中间件函数 → 最终路径集合 都存在登记簿自己的 Map 里：键是函数对象本身，按注册实例绑定，
 * 且只在本应用内有效——同一个中间件函数在别的应用登记过，不能让本应用里的原生注册蒙混过关。
 */
import type { PolicyTable } from './table.js';
import type { HttpMethod, RoutePolicy } from './types.js';

export type RoutePolicyErrorCode =
  | 'ROUTE_UNDECLARED'
  | 'ROUTE_ALIAS'
  | 'ROUTE_DUPLICATE_DECLARATION'
  | 'ROUTE_DUPLICATE_PATH'
  | 'ROUTE_DUPLICATE_REGISTRATION'
  | 'ROUTE_MIDDLEWARE_UNREGISTERED'
  | 'ROUTE_MIDDLEWARE_MISMATCH'
  | 'ROUTE_DECLARATION_UNMOUNTED'
  | 'ROUTE_DECLARATION_UNUSED'
  | 'ROUTE_POLICY_INLINE_HANDLERS'
  | 'ROUTE_POLICY_ALL_FORBIDDEN';

/** 注册期 / 校验期的失败：应用无法启动，测试直接失败（DEC-300：缺失声明、身份不匹配始终失败）。 */
export class RoutePolicyError extends Error {
  constructor(
    readonly code: RoutePolicyErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'RoutePolicyError';
  }
}

export interface Declaration {
  /** `METHOD localPath`，即登记表的键。 */
  readonly key: string;
  readonly module: string;
  readonly method: HttpMethod;
  readonly localPath: string;
  /** Hono 规范化并逐层挂载后的最终路径（mount 回填）。 */
  expectedFullPath: string;
  readonly policy: RoutePolicy;
  seen: boolean;
}

export interface MiddlewareEntry {
  readonly label: string;
  /** 允许出现的最终路径（mount 时把本地路径替换为挂载后的路径）。 */
  readonly paths: Set<string>;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
type AnyFn = Function;

const registryByRouter = new WeakMap<object, RouteRegistry>();

export class RouteRegistry {
  readonly declarations: Declaration[] = [];
  readonly middleware: MiddlewareEntry[] = [];
  readonly tables = new Set<PolicyTable>();
  readonly usedKeys = new Set<string>();
  private readonly keysByRouter = new WeakMap<object, Set<string>>();
  private readonly declarationByWrapper = new Map<AnyFn, Declaration>();
  private readonly middlewareByFn = new Map<AnyFn, MiddlewareEntry>();

  /** 同一路由器上同一 `METHOD localPath` 只能声明一次（§2.3）。 */
  claimKey(router: object, key: string): void {
    let keys = this.keysByRouter.get(router);
    if (!keys) this.keysByRouter.set(router, (keys = new Set()));
    if (keys.has(key)) throw new RoutePolicyError('ROUTE_DUPLICATE_DECLARATION', `${key} 在同一路由器上声明了两次`);
    keys.add(key);
  }

  bindWrapper(wrapper: AnyFn, declaration: Declaration): void {
    this.declarationByWrapper.set(wrapper, declaration);
    this.declarations.push(declaration);
  }

  bindMiddleware(fn: AnyFn, path: string, label: string): MiddlewareEntry {
    let entry = this.middlewareByFn.get(fn);
    if (!entry) {
      entry = { label, paths: new Set() };
      this.middlewareByFn.set(fn, entry);
      this.middleware.push(entry);
    }
    entry.paths.add(path);
    return entry;
  }

  declarationOf(fn: AnyFn): Declaration | undefined {
    return this.declarationByWrapper.get(fn);
  }

  middlewareOf(fn: AnyFn): MiddlewareEntry | undefined {
    return this.middlewareByFn.get(fn);
  }

  /** 把子路由器的登记簿并入（子路由器单独声明后再挂载的情况）。 */
  absorb(other: RouteRegistry): void {
    if (other === this) return;
    for (const d of other.declarations) if (!this.declarations.includes(d)) this.declarations.push(d);
    for (const m of other.middleware) if (!this.middleware.includes(m)) this.middleware.push(m);
    for (const [fn, d] of other.declarationByWrapper) this.declarationByWrapper.set(fn, d);
    for (const [fn, m] of other.middlewareByFn) this.middlewareByFn.set(fn, m);
    for (const t of other.tables) this.tables.add(t);
    for (const k of other.usedKeys) this.usedKeys.add(k);
  }
}

/** 取（或建）某个原生 Hono 路由器对应的登记簿（键是路由器对象本身）。 */
export function registryOf(router: object): RouteRegistry {
  let registry = registryByRouter.get(router);
  if (!registry) registryByRouter.set(router, (registry = new RouteRegistry()));
  return registry;
}

export function attachRegistry(router: object, registry: RouteRegistry): void {
  registryByRouter.set(router, registry);
}
