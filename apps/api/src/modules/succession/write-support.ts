/**
 * 继任写入口的命令执行协议（设计 §2.1；DEC-067 / AGENTS §10）。所有写入口共用这里的包装器，B2a / B3 及之后的写入口复用：
 * 1. 命令前（路由层，包装器外）：对象数据操作权 + 按钮 + 载荷字段编辑权 + 目标范围（成功后才进入包装器）；
 * 2. 命令内（`runCommand`）：用 #199 的 CommandGuard 在**事务内**按当前授权重新复核（首次执行与每条返回台账结果的路径——
 *    直接重放、并发败者失败后回查——都经过唯一出口 `ledgerExit`，先跑 `before`，命中台账后再跑 `replayed`）；
 * 3. 返回前：首次响应、直接重放、失败回查重放三条路径**同一个函数** `authorizeSuccessionResult`——按台账里的结果记录 ID 逐个
 *    按请求人当时的范围复核（不可见 → 404），再做 §8.4 投影。台账只存结果记录 ID，不存响应对象：响应每次返回前重新取、重新投影。
 */
import { type Tx, withTenant } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import type { Context } from 'hono';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { authorizeInTransaction, resolveModuleScopeInTransaction } from '../permission/module-access.js';
import { button, writeFields } from '../permission/module-route-access.js';
import { codeOf, successionContext, type SuccessionContext } from './access.js';
import { projectSuccession, buildRecordViews, type RecordView } from './projection.js';
import { listRecordRows, type RecordVisibility } from './record-read.js';
import type { ModuleScope } from '../permission/module-access.js';

export type WriteOperation = 'create' | 'update' | 'delete';

/** 写命令的上下文：请求上下文 + 请求日 + 命令事务内解析的当前数据范围。 */
export interface WriteContext extends SuccessionContext {
  readonly scope: ModuleScope;
  /** 请求当日（租户时区）：日期校验、SELF 谓词、生效状态都按它。 */
  readonly today: string;
}

/** 台账里存的结果：只有记录 ID（响应在返回前重新取），`receipt` = 软删除回执（按删除前的行判范围）。 */
export interface StoredResult {
  readonly kind: 'record' | 'records' | 'receipt';
  readonly ids: readonly string[];
}

export interface WriteSpec {
  readonly operation: WriteOperation;
  /** 对象按钮编码与级别（设计 §8.1）：end 属于 update 操作的列表级按钮。 */
  readonly button: { readonly code: string; readonly level: 'list' | 'detail' };
  readonly expectedRevision: number;
  /** 载荷字段编辑权（create / update，含显式置空）。 */
  readonly payload?: Readonly<Record<string, unknown>>;
  /** 请求指纹里的输入（决定“同内容”）。 */
  readonly input: unknown;
  readonly status: 200 | 201;
  readonly execute: (tx: Tx, ctx: WriteContext) => Promise<StoredResult>;
}

/** 命令前：对象数据操作权 + 按钮 + 载荷字段编辑权（含置空）。路由层调用一次，命令事务内再按当前授权重复一次。 */
export async function checkWriteAccess(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  spec: Pick<WriteSpec, 'operation' | 'button' | 'expectedRevision' | 'payload'>,
): Promise<SuccessionContext> {
  const ctx = await successionContext(c, deps, 'record', spec.operation, spec.expectedRevision);
  await button(deps, ctx, codeOf('record'), spec.button.code, spec.button.level);
  if (spec.payload && spec.operation !== 'delete') {
    await writeFields(deps, ctx, codeOf('record'), spec.operation, spec.payload);
  }
  return ctx;
}

const todayOf = (ctx: SuccessionContext) => tenantLocalDate(ctx.now, ctx.timezone);

/** 命令事务内的当前权限复核：对象 / 按钮 / 字段 / 范围都按**事务内**当前授权重新解析，拒绝即整体回滚。 */
async function recheck(c: Context<TenantEnv>, deps: TenantRouteDeps, tx: Tx, spec: WriteSpec): Promise<WriteContext> {
  const txDeps: TenantRouteDeps = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  const ctx = await checkWriteAccess(c, txDeps, spec);
  const scope = await resolveModuleScopeInTransaction(txDeps, ctx, tx, codeOf('record'));
  return { ...ctx, scope, today: todayOf(ctx) };
}

/** 事务内按请求人当前范围读结果记录；数量不符（范围外 / 已不存在）一律 404。 */
async function visibleViews(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: SuccessionContext,
  result: StoredResult,
): Promise<{ readonly views: RecordView[]; readonly revisions: ReadonlyMap<string, number> }> {
  const txDeps: TenantRouteDeps = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  const scope = await resolveModuleScopeInTransaction(txDeps, ctx, tx, codeOf('record'));
  const today = todayOf(ctx);
  const visibility: RecordVisibility = { tenantId: ctx.tenantId, userId: ctx.userId, today, asOf: today, scope };
  const { rows } = await listRecordRows(
    tx,
    visibility,
    { status: 'all', ids: result.ids, includeDeleted: result.kind === 'receipt' },
    { limit: result.ids.length || 1, offset: 0 },
  );
  if (rows.length !== result.ids.length) throw new AppError('NOT_FOUND', '继任记录不存在');
  const views = await buildRecordViews(tx, ctx.tenantId, rows, today);
  const order = new Map(result.ids.map((id, index) => [id, index]));
  views.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return { views, revisions: new Map(rows.map((row) => [row.id, row.revision])) };
}

/**
 * 返回前复核（设计 §2.1 第 3 步）：首次响应、直接重放、失败回查重放同一函数。按台账里的结果记录 ID 逐个按请求人**当时**的
 * 范围复核（不可见 → 404），再做 §8.4 投影。软删除回执按删除前的行（行仍在，带 deleted_at）判范围。
 */
export async function authorizeSuccessionResult(
  deps: TenantRouteDeps,
  ctx: SuccessionContext,
  result: StoredResult,
): Promise<{ readonly items: Partial<RecordView>[]; readonly revisions: ReadonlyMap<string, number> }> {
  const { views, revisions } = await withTenant(deps.db, ctx.tenantId, (tx) => visibleViews(tx, deps, ctx, result));
  return { items: await projectSuccession(deps, ctx, 'record', views), revisions };
}

/**
 * 执行一个写命令：命令事务内先按当前授权复核（CommandGuard.before，首次与各重放路径共用），再执行；命中台账的路径经
 * `ledgerExit` 的 `replayed` 钩子再按当前范围复核结果记录。返回台账里的结果（调用方再走 authorizeSuccessionResult）。
 */
export async function runSuccessionCommand(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: SuccessionContext,
  spec: WriteSpec,
): Promise<{ readonly status: 200 | 201; readonly result: StoredResult }> {
  let current: WriteContext | undefined;
  const response = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: spec.expectedRevision, input: spec.input },
    guard: {
      before: async (tx) => {
        current = await recheck(c, deps, tx, spec);
      },
      replayed: async (tx, replay) => {
        await visibleViews(tx, deps, ctx, replay.body as StoredResult);
      },
    },
    execute: async (tx, commandId) => ({
      status: spec.status,
      body: await spec.execute(tx, { ...current!, commandId }),
    }),
  });
  return { status: response.status as 200 | 201, result: response.body as StoredResult };
}

/** 候选下拉的入口权限：持新增或编辑（对象数据操作权 + 按钮）任一即可，不看数据范围（DEC-308）；都没有时按新增的拒绝返回 403。 */
export async function checkCandidateAccess(c: Context<TenantEnv>, deps: TenantRouteDeps): Promise<SuccessionContext> {
  try {
    return await checkWriteAccess(c, deps, {
      operation: 'create',
      button: { code: 'create', level: 'list' },
      expectedRevision: 0,
    });
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'FORBIDDEN') throw error;
    try {
      return await checkWriteAccess(c, deps, {
        operation: 'update',
        button: { code: 'update', level: 'detail' },
        expectedRevision: 0,
      });
    } catch {
      throw error;
    }
  }
}
