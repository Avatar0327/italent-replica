/**
 * 接管 T1 的 `access` 对象（docs/08_设计/F-039_接管T1_设计.md §2.2）：引擎在调用处理函数之前完成准入后，
 * 把结果交给处理函数。Hono 处理函数的第二个参数是 `next`，所以处理函数用 `accessOf(c)` 取得它。
 *
 * - `getScope()` 是显式的异步调用：同一请求只解析一次。处理函数必须在任何事务回调**之外**调用它——真实授权器
 *   解析范围时另开事务，在业务事务里首次解析会造成连接等待（§2.2，审查实测 PGlite 1 秒超时）。
 * - `inScopedTx(fn)`：`shared` 点校验（§2.4）。引擎开事务，先执行登记的点校验，再在同一事务里执行 fn。
 */
import type { Context } from 'hono';

export interface AccessRuntime<Ctx, Scope, Tx> {
  readonly resolveScope: (ctx: Ctx) => Promise<Scope>;
  readonly scopedTx?: <T>(
    access: RouteAccess<Ctx, Scope, Tx>,
    scope: Scope,
    fn: (tx: Tx, record: unknown) => Promise<T>,
  ) => Promise<T>;
}

export class RouteAccess<Ctx = unknown, Scope = unknown, Tx = unknown> {
  /** S3 解析的授权输入（键见声明的 input.parse）。 */
  readonly input: Record<string, unknown> = {};
  /** S6 点校验 / 看全部 / 范围守卫登记实现的返回值（如定位器加载的记录）。 */
  point: unknown = undefined;
  #ctx: Ctx | undefined;
  #scope: Promise<Scope> | undefined;
  #sharedChecked = false;

  constructor(private readonly runtime: AccessRuntime<Ctx, Scope, Tx>) {}

  /** S1 + S2 得到的业务上下文（与现状 objectContext / readContext 的返回值相同）。 */
  get ctx(): Ctx {
    if (this.#ctx === undefined) throw new Error('access.ctx 尚未就绪：功能权限阶段之前不可读取');
    return this.#ctx;
  }

  setContext(ctx: Ctx): void {
    this.#ctx = ctx;
  }

  getScope(): Promise<Scope> {
    this.#scope ??= this.runtime.resolveScope(this.ctx);
    return this.#scope;
  }

  /** `shared` 点校验：先校验、再读取，同一事务；处理函数不调用即 500 ROUTE_POLICY_UNCHECKED（DEC-363④）。 */
  async inScopedTx<T>(fn: (tx: Tx, record: unknown) => Promise<T>): Promise<T> {
    const scopedTx = this.runtime.scopedTx;
    if (!scopedTx) throw new Error('本路由没有登记 shared 点校验，不能调用 inScopedTx');
    const result = await scopedTx(this, await this.getScope(), async (tx, record) => {
      this.point = record;
      this.#sharedChecked = true;
      return fn(tx, record);
    });
    return result;
  }

  get sharedChecked(): boolean {
    return this.#sharedChecked;
  }
}

const accessByContext = new WeakMap<object, RouteAccess<unknown, unknown, unknown>>();

export function bindAccess(c: Context, access: RouteAccess<unknown, unknown, unknown>): void {
  accessByContext.set(c, access);
}

/** 已接管路由的处理函数取得 access；未接管的路由没有 access（编程错误，500）。 */
export function accessOf<Ctx = unknown, Scope = unknown, Tx = unknown>(c: Context): RouteAccess<Ctx, Scope, Tx> {
  const access = accessByContext.get(c);
  if (!access) throw new Error('本路由所在模块未接管（TAKEN_OVER_MODULES），没有 access');
  return access as RouteAccess<Ctx, Scope, Tx>;
}
