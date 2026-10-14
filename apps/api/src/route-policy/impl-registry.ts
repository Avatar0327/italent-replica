/**
 * 接管 T1 的实现登记（docs/08_设计/F-039_接管T1_设计.md §2.3 / §2.6）：框架编排，模块实现。
 *
 * 引擎本身不含任何对象编码、按钮编码、范围算法；每个已接管模块用 `implement(router, module, impls)` 登记：
 * - `primitives`：各阶段的通用判定（现状的 revision / objectContext / readContext / writeFields / button /
 *   requestScope / withTenant），直接复用现有函数，错误码与文案因此不变；
 * - `inputs`：S3 授权输入解析器（现状的 uuidParam / queryDate / parseBody(zod)），按现状位置原样调用；
 * - `t1`：声明里由引擎执行的具名点校验 / 看全部 / 范围守卫；
 * - `deferred`：声明里出现、但留在原位执行的名称及其阶段（T2 / T3 / T4 / command），引擎不执行。
 * 声明里每个需要归类的名称都必须出现在 t1 或 deferred 里，否则应用无法启动（ROUTE_POLICY_IMPL_MISSING）。
 */
import type { AdminCapability } from '@italent/domain';
import type { Context, Env, Hono } from 'hono';
import type { RouteAccess } from './access.js';
import { rawRouter } from './declare.js';
import { registryOf } from './registry.js';
import type { DeferredStage } from './takeover.js';
import type { ButtonRef } from './types.js';

export type DataOperation = 'view' | 'create' | 'update' | 'delete';

export interface AdminNode {
  readonly capability: AdminCapability;
  readonly alias?: string;
}

/** 各阶段的通用判定。按路由实际用到的阶段要求齐全（启动期检查）。 */
export interface EnforcePrimitives<Ctx, Scope, Tx> {
  /** S1：写请求的 If-Match。 */
  readonly revision?: (c: Context) => number;
  /** S2：路由没有对象 / 管理员节点时（只有本人 / 成员），取业务上下文。 */
  readonly context?: (c: Context, expectedRevision: number) => Promise<Ctx>;
  /** S2：对象 × 数据操作。 */
  readonly operation?: (c: Context, object: string, operation: DataOperation, expectedRevision: number) => Promise<Ctx>;
  /** S2：管理员能力（或现有 tenant.* 别名）。 */
  readonly admin?: (c: Context, node: AdminNode, expectedRevision: number) => Promise<Ctx>;
  /** S4：写字段。 */
  readonly writeFields?: (ctx: Ctx, object: string, operation: 'create' | 'update', payload: unknown) => Promise<void>;
  /** S5：按钮。 */
  readonly button?: (ctx: Ctx, object: string, ref: ButtonRef) => Promise<void>;
  /** S6 / getScope：本请求的数据范围（事务外解析）。 */
  readonly scope?: (c: Context, ctx: Ctx, object: string, view: string | undefined) => Promise<Scope>;
  /** shared 点校验的租户事务。 */
  readonly transaction?: <T>(ctx: Ctx, fn: (tx: Tx) => Promise<T>) => Promise<T>;
}

export interface CheckArgs<Ctx, Scope, Tx> {
  readonly c: Context;
  readonly access: RouteAccess<Ctx, Scope, Tx>;
  /** 引擎在调用前已在事务外解析的范围。 */
  readonly scope: Scope;
  /** 只在 shared 方式下提供：与处理函数共用的事务。 */
  readonly tx?: Tx;
}

export type T1Check<Ctx, Scope, Tx> = (args: CheckArgs<Ctx, Scope, Tx>) => Promise<unknown>;
export type InputParser<Ctx, Scope, Tx> = (c: Context, access: RouteAccess<Ctx, Scope, Tx>) => unknown;

export interface ModuleImplementations<Ctx = unknown, Scope = unknown, Tx = unknown> {
  readonly primitives: EnforcePrimitives<Ctx, Scope, Tx>;
  readonly inputs?: Readonly<Record<string, InputParser<Ctx, Scope, Tx>>>;
  readonly t1?: Readonly<Record<string, T1Check<Ctx, Scope, Tx>>>;
  readonly deferred?: Readonly<Record<string, DeferredStage>>;
}

/** 引擎内部用的类型擦除形状。 */
export type AnyImplementations = ModuleImplementations<unknown, unknown, unknown>;

/** 登记一个模块的实现（每个模块一次）。经 mount 挂载时随登记簿合并。 */
export function implement<E extends Env, Ctx, Scope, Tx>(
  router: Hono<E>,
  module: string,
  impls: ModuleImplementations<Ctx, Scope, Tx>,
): void {
  registryOf(rawRouter(router)).bindImplementations(module, impls as unknown as AnyImplementations);
}
