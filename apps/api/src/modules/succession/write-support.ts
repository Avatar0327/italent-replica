/**
 * 继任写入口的命令执行协议（设计 §2.1；DEC-067 / AGENTS §10）。所有写入口共用这里的包装器，B2a / B3 及之后的写入口复用：
 * 1. 命令前（路由层，包装器外）：对象数据操作权 + 按钮 + 载荷字段编辑权 + 目标范围（成功后才进入包装器）；
 * 2. 命令内（`runCommand`）：用 #199 的 CommandGuard 在**事务内**按当前授权重新复核（首次执行与每条返回台账结果的路径——
 *    直接重放、并发败者失败后回查——都经过唯一出口 `ledgerExit`，先跑 `before`，命中台账后再跑 `replayed`）；
 * 3. 返回前：首次响应、直接重放、失败回查重放三条路径**同一个函数** `authorizeSuccessionResult`——按台账里的结果记录 ID 逐个
 *    按请求人当时的范围复核（不可见 → 404），再做 §8.4 投影。台账只存结果记录 ID，不存响应对象：响应每次返回前重新取、重新投影。
 */
import { sql, type Tx, withTenant } from '@italent/db';
import { type SuccessionObject, tenantLocalDate } from '@italent/domain';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import {
  authorizeInTransaction,
  type ModuleScope,
  resolveModuleScopeInTransaction,
} from '../permission/module-access.js';
import { button, writeFields } from '../permission/module-route-access.js';
import { codeOf, successionContext, type SuccessionContext } from './access.js';
import { rowsOf } from './read-sql.js';

export type WriteOperation = 'create' | 'update' | 'delete';

/** 写命令的上下文：请求上下文 + 请求日 + 命令事务内解析的当前数据范围。 */
export interface WriteContext extends SuccessionContext {
  readonly scope: ModuleScope;
  /** 请求当日（租户时区）：日期校验、SELF 谓词、生效状态都按它。 */
  readonly today: string;
}

/**
 * 台账里存的结果：只有结果对象 ID 和命令 ID（响应在返回前重新取）。`receipt` = 软删除回执（按删除前的行判范围）。
 * `kind` 只区分响应形状（单个 / 多个 / 回执），不同对象（人员范围、规则设置、计算 run …）用各自的适配器解释 ID。
 */
export interface StoredResult {
  readonly kind: 'record' | 'records' | 'receipt';
  readonly ids: readonly string[];
  readonly commandId: string;
}

/** 写命令的返回（命令 ID 由协议统一补进台账）。 */
export type CommandResult = Omit<StoredResult, 'commandId'>;

/** 适配器读出的结果对象（至少有 ID 与 revision，供响应 ETag 与按序返回）。 */
export interface ResultView {
  readonly id: string;
}

/**
 * 结果对象适配器（B2a 人员范围 / 规则设置、B3 计算 run 等写入口各自实现，统一出口 `authorizeSuccessionResult` 不变）：
 * `load` 在事务内按请求人**当时**的对象权限与范围读出结果对象，任何一个不可见或不存在 → 404；
 * `project` 做该对象的 §8.4 投影（字段裁剪、嵌套人员等）。
 */
export interface ResultAdapter<V extends ResultView = ResultView> {
  /** 结果对象的权限对象与审计对象类型（审计足迹按它过滤）。 */
  readonly object: SuccessionObject;
  load(
    tx: Tx,
    deps: TenantRouteDeps,
    ctx: SuccessionContext,
    ids: readonly string[],
    options: { readonly includeDeleted: boolean },
  ): Promise<{ readonly views: readonly V[]; readonly revisions: ReadonlyMap<string, number> }>;
  project(deps: TenantRouteDeps, ctx: SuccessionContext, views: readonly V[]): Promise<Partial<V>[]>;
}

export interface WriteSpec<V extends ResultView = ResultView> {
  readonly operation: WriteOperation;
  /** 对象按钮编码与级别（设计 §8.1）：end 属于 update 操作的列表级按钮。 */
  readonly button: { readonly code: string; readonly level: 'list' | 'detail' };
  readonly expectedRevision: number;
  /** 载荷字段编辑权（create / update，含显式置空）。 */
  readonly payload?: Readonly<Record<string, unknown>>;
  /** 请求指纹里的输入（决定“同内容”）。 */
  readonly input: unknown;
  readonly status: ContentfulStatusCode;
  /** 结果对象适配器：同时决定命令前 / 命令内权限判定所用的权限对象。 */
  readonly results: ResultAdapter<V>;
  readonly execute: (tx: Tx, ctx: WriteContext) => Promise<CommandResult>;
}

/** 命令前：对象数据操作权 + 按钮 + 载荷字段编辑权（含置空）。路由层调用一次，命令事务内再按当前授权重复一次。 */
export async function checkWriteAccess(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  spec: Pick<WriteSpec, 'operation' | 'button' | 'expectedRevision' | 'payload'> & {
    readonly object: SuccessionObject;
  },
): Promise<SuccessionContext> {
  const ctx = await successionContext(c, deps, spec.object, spec.operation, spec.expectedRevision);
  await button(deps, ctx, codeOf(spec.object), spec.button.code, spec.button.level);
  if (spec.payload && spec.operation !== 'delete') {
    await writeFields(deps, ctx, codeOf(spec.object), spec.operation, spec.payload);
  }
  return ctx;
}

const todayOf = (ctx: SuccessionContext) => tenantLocalDate(ctx.now, ctx.timezone);

/** 命令事务内的当前权限复核：对象 / 按钮 / 字段 / 范围都按**事务内**当前授权重新解析，拒绝即整体回滚。 */
async function recheck(c: Context<TenantEnv>, deps: TenantRouteDeps, tx: Tx, spec: WriteSpec): Promise<WriteContext> {
  const txDeps: TenantRouteDeps = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  const object = spec.results.object;
  const ctx = await checkWriteAccess(c, txDeps, { ...spec, object });
  const scope = await resolveModuleScopeInTransaction(txDeps, ctx, tx, codeOf(object));
  return { ...ctx, scope, today: todayOf(ctx) };
}

/** 本命令写下的审计足迹（按命令 ID）：命令实际动过的对象 ID，与台账结果 ID 合并后一并复核，不能只信台账。 */
async function footprintIds(tx: Tx, ctx: SuccessionContext, commandId: string, object: SuccessionObject) {
  return rowsOf<{ object_id: string }>(
    await tx.execute(sql`SELECT DISTINCT object_id FROM audit_events
      WHERE tenant_id = ${ctx.tenantId}::uuid AND command_id = ${commandId} AND object_type = ${codeOf(object)}
        AND object_id IS NOT NULL`),
  ).map((row) => row.object_id);
}

/** 事务内按请求人当前权限与范围读结果对象（含审计足迹里的对象）；任何一个不可见 / 不存在 → 404，数量不符同样 404。 */
async function visibleViews<V extends ResultView>(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: SuccessionContext,
  result: StoredResult,
  results: ResultAdapter<V>,
) {
  const footprint = await footprintIds(tx, ctx, result.commandId, results.object);
  const wanted = [...new Set(result.ids)];
  const all = [...new Set([...wanted, ...footprint])];
  const loaded = await results.load(tx, deps, ctx, all, { includeDeleted: result.kind === 'receipt' });
  const byId = new Map(loaded.views.map((view) => [view.id, view]));
  const views = wanted.map((id) => byId.get(id));
  if (loaded.views.length !== all.length || views.some((view) => view === undefined)) {
    throw new AppError('NOT_FOUND', '对象不存在');
  }
  return { views: views as V[], revisions: loaded.revisions };
}

/**
 * 返回前复核（设计 §2.1 第 3 步）：首次响应、直接重放、失败回查重放同一函数，**所有写入口共用**（B2a、B3 及之后的写入口
 * 只需提供各自的结果对象适配器）。按台账里的结果 ID 与命令 ID 的审计足迹逐个按请求人**当时**的权限与范围复核（不可见 → 404），
 * 再做 §8.4 投影。软删除回执按删除前的行（行仍在，带 deleted_at）判范围。
 */
export async function authorizeSuccessionResult<V extends ResultView>(
  deps: TenantRouteDeps,
  ctx: SuccessionContext,
  result: StoredResult,
  results: ResultAdapter<V>,
): Promise<{ readonly items: Partial<V>[]; readonly revisions: ReadonlyMap<string, number> }> {
  const { views, revisions } = await withTenant(deps.db, ctx.tenantId, (tx) =>
    visibleViews(tx, deps, ctx, result, results),
  );
  return { items: await results.project(deps, ctx, views), revisions };
}

/**
 * 执行一个写命令：命令事务内先按当前授权复核（CommandGuard.before，首次与各重放路径共用），再执行；命中台账的路径经
 * `ledgerExit` 的 `replayed` 钩子再按当前权限与范围复核结果对象。返回台账里的结果（调用方再走 authorizeSuccessionResult）。
 */
export async function runSuccessionCommand(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: SuccessionContext,
  spec: WriteSpec,
): Promise<{ readonly status: ContentfulStatusCode; readonly result: StoredResult }> {
  let current: WriteContext | undefined;
  const response = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: spec.expectedRevision, input: spec.input },
    guard: {
      before: async (tx) => {
        current = await recheck(c, deps, tx, spec);
      },
      replayed: async (tx, replay) => {
        await visibleViews(tx, deps, ctx, replay.body as StoredResult, spec.results);
      },
    },
    execute: async (tx, commandId) => ({
      status: spec.status,
      body: { ...(await spec.execute(tx, { ...current!, commandId })), commandId } satisfies StoredResult,
    }),
  });
  return { status: response.status, result: response.body as StoredResult };
}

/** 候选下拉的入口权限：持新增或编辑（对象数据操作权 + 按钮）任一即可，不看数据范围（DEC-308）；都没有时按新增的拒绝返回 403。 */
export async function checkCandidateAccess(c: Context<TenantEnv>, deps: TenantRouteDeps): Promise<SuccessionContext> {
  const object = 'record';
  try {
    return await checkWriteAccess(c, deps, {
      object,
      operation: 'create',
      button: { code: 'create', level: 'list' },
      expectedRevision: 0,
    });
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'FORBIDDEN') throw error;
    try {
      return await checkWriteAccess(c, deps, {
        object,
        operation: 'update',
        button: { code: 'update', level: 'detail' },
        expectedRevision: 0,
      });
    } catch {
      throw error;
    }
  }
}
