/**
 * 调动明细写路由（R2-T08 §9.3 路由 16～18，BE-11c-b）：POST / PATCH / DELETE `…/adjustments/:id/transfer-items[/:itemId]`。
 * 与组织明细同一台账幂等；守卫（首次与重放都经过）在命令事务内、锁住申请单之后，按当前权限与库里当前的行判：
 * 按钮 `EditAdjustOrgDetailBtn@detail`、主体组织在主对象范围、新旧目标部门在组织对象范围、字段写权、调动表单、
 * 联动与带编授权（`transferGate`，新旧两侧都判，与人工调动同一条链）；重放再按结果行按当前权限复核。
 * 任职上下文与联动目标范围都在事务内解析（第 2 轮 P1-1：不在锁外先算）。
 * 响应按 `transferItems.*` 查看权裁剪；行的身份列总是返回。
 */
import type { Tx } from '@italent/db';
import { ORG_ADJUSTMENT_OBJECT_CODE } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { parseBody, revision, uuidParam } from '../job/context.js';
import { getModuleViewableFields } from '../permission/module-access.js';
import type { ScopeBusinessContext } from '../permission/module-contracts.js';
import { button, objectContext, writeFields } from '../permission/module-route-access.js';
import { ADJUSTMENT_NOT_FOUND, HEAD_BUTTONS } from './access.js';
import { hiddenItemIds, hiddenTransferIds, ROW_NOT_FOUND } from './hidden-rows.js';
import { rebaseTransferItem } from './transfer-rebase.js';
import { loadAdjustment, type AdjustmentView } from './service.js';
import { LINKAGE_CODE, transferGate } from './transfer-access.js';
import {
  addTransferItem,
  addTransferSchema,
  deleteTransferItem,
  draftOf,
  EMPTY,
  patchTransferItem,
  patchTransferSchema,
  type TransferGate,
  type TransferResult,
  type TransferWrite,
} from './transfer-items.js';
import { loadTransfers, type TransferItem } from './transfer-items-store.js';

const OBJECT = ORG_ADJUSTMENT_OBJECT_CODE;
const BASE = '/api/tenant/org-adjustment/adjustments';
const TRANSFER_ITEMS = `${BASE}/:id/transfer-items`;

/** 载荷键 → 调动明细字段编码；联动里的合同变更走外部字段容器（逐行编码随读侧，§4.5）。 */
const FIELD_CODE: Readonly<Record<string, string>> = {
  employeeId: 'employeeId',
  department: 'departmentId',
  positionId: 'positionId',
  postId: 'postId',
  levelId: 'levelId',
  directManagerId: 'directManagerId',
  dottedManagerId: 'directManagerId',
  withEstablishment: 'withEstablishment',
};
function transferFieldCodes(input: { readonly linkage?: Record<string, unknown> | null }, keys: readonly string[]) {
  const codes = keys.flatMap((key) => (FIELD_CODE[key] ? [`transferItems.${FIELD_CODE[key]}`] : []));
  const linkage = Object.keys(input.linkage ?? {}).flatMap((key) => (LINKAGE_CODE[key] ? [LINKAGE_CODE[key]!] : []));
  return Object.fromEntries([...codes, ...linkage].map((code) => [code, null]));
}

export function registerTransferRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post(TRANSFER_ITEMS, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT, 'update', revision(c));
    const id = uuidParam(c);
    const input = await parseBody(c, addTransferSchema);
    await button(deps, ctx, OBJECT, ...HEAD_BUTTONS.update);
    await writeFields(deps, ctx, OBJECT, 'update', transferFieldCodes(input, Object.keys(input)));
    const gate = transferGate(deps, ctx);
    return transferCommand(c, deps, ctx, id, input, {
      kind: 'save',
      gate,
      check: (tx, view) => gate.save(tx, view, input.employeeId, draftOf(EMPTY, input), null),
      execute: async (tx, commandCtx) =>
        addTransferItem(tx, commandCtx, id, input, gate, await hiddenItemIds(tx, deps, ctx, id)),
    });
  });

  router.patch(`${TRANSFER_ITEMS}/:itemId`, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT, 'update', revision(c));
    const id = uuidParam(c);
    const itemId = uuidParam(c, 'itemId');
    const input = await parseBody(c, patchTransferSchema);
    await button(deps, ctx, OBJECT, ...HEAD_BUTTONS.update);
    await writeFields(deps, ctx, OBJECT, 'update', transferFieldCodes(input, Object.keys(input)));
    const gate = transferGate(deps, ctx);
    return transferCommand(c, deps, ctx, id, input, {
      kind: 'save',
      gate,
      check: async (tx, view) => {
        const row = (await loadTransfers(tx, ctx.tenantId, id)).find((item) => item.id === itemId);
        if (row) await gate.save(tx, view, row.employeeId, draftOf(row, input), row);
      },
      execute: async (tx, commandCtx) =>
        patchTransferItem(tx, commandCtx, id, itemId, input, gate, await hiddenItemIds(tx, deps, ctx, id)),
    });
  });

  router.delete(`${TRANSFER_ITEMS}/:itemId`, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT, 'update', revision(c));
    const id = uuidParam(c);
    const itemId = uuidParam(c, 'itemId');
    await button(deps, ctx, OBJECT, ...HEAD_BUTTONS.update);
    const gate = transferGate(deps, ctx);
    return transferCommand(
      c,
      deps,
      ctx,
      id,
      {},
      {
        kind: 'remove',
        gate,
        check: async (tx, view) => {
          const row = (await loadTransfers(tx, ctx.tenantId, id)).find((item) => item.id === itemId);
          if (row) await gate.remove(tx, view, row);
        },
        execute: (tx, commandCtx) => deleteTransferItem(tx, commandCtx, id, itemId, gate),
      },
    );
  });
}

interface TransferCommand {
  /** 保存类（增 / 改）重放按结果行的新值再判；删除类重放按被删的旧行再判。 */
  readonly kind: 'save' | 'remove';
  readonly gate: TransferGate;
  /** 守卫内按当前权限与表单规则校验请求（首次与重放都经过）；行不存在留给写服务报 404。 */
  check(tx: Tx, view: AdjustmentView): Promise<unknown>;
  execute(tx: Tx, ctx: ScopeBusinessContext): Promise<TransferWrite>;
}

async function transferCommand(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: ScopeBusinessContext,
  id: string,
  body: unknown,
  command: TransferCommand,
) {
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: ctx.expectedRevision, body },
    guard: {
      before: async (tx) => {
        const stored = await loadAdjustment(tx, ctx.tenantId, id, true);
        if (!stored) throw new AppError('NOT_FOUND', ADJUSTMENT_NOT_FOUND);
        await command.check(tx, stored);
      },
      replayed: async (tx, stored) => {
        const view = await loadAdjustment(tx, ctx.tenantId, id);
        if (!view) throw new AppError('NOT_FOUND', ADJUSTMENT_NOT_FOUND);
        const { items: rows, previous } = stored.body as TransferResult;
        await (command.kind === 'save'
          ? command.gate.rejudge(tx, view, rows, previous)
          : command.gate.rejudgeRemoved(tx, view, rows));
      },
    },
    execute: async (tx, commandId) => {
      const written = await command.execute(tx, { ...ctx, commandId });
      return { status: written.status, body: written.result };
    },
  });
  const written = result.body as TransferResult;
  c.header('ETag', `"${written.revision}"`);
  return c.json(await trimTransfers(deps, ctx, written), result.status as 200 | 201);
}

/** 行的身份与基线列总是返回；内容列按 `transferItems.<字段>` 查看权，虚线经理随直线经理，联动随其区块。 */
const IDENTITY = new Set(['id', 'seq', 'baseRecordId', 'baseEmployeeRevision', 'generatedByItemId', 'generatedReason']);
const FOLLOWS: Readonly<Record<string, string>> = {
  departmentItemId: 'departmentId',
  positionItemId: 'positionId',
  dottedManagerId: 'directManagerId',
  dottedManagerSpecified: 'directManagerId',
};

async function trimTransfers(deps: TenantRouteDeps, ctx: ScopeBusinessContext, full: TransferResult) {
  const { previous: _previous, ...result } = full; // 变更前的行只供重放重判，不属于响应
  const fields = await getModuleViewableFields(deps, ctx, OBJECT);
  if (!fields) return { ...result, items: result.items.map(publicRow) };
  const keep = (key: string) => IDENTITY.has(key) || fields.has(`transferItems.${FOLLOWS[key] ?? key}`);
  return {
    ...result,
    items: result.items.map((item) => Object.fromEntries(Object.entries(publicRow(item)).filter(([key]) => keep(key)))),
  };
}

/** 执行期内部列（阶段、结果、业务 ID）不属于写路由的响应。 */
function publicRow(row: TransferItem) {
  const {
    execPhase: _phase,
    executionResult: _result,
    executionReason: _reason,
    executionMessage: _message,
    createdBusinessId: _created,
    tenantId: _tenant,
    adjustmentId: _adjustment,
    ...rest
  } = row;
  return rest;
}

/** 路由 8（section = transfer）：单行刷新调动明细基线。按钮同其它调动写路由；隐藏行 / 不存在同一 404，再按当前权限重判。 */
export async function rebaseTransferRoute(c: Context<TenantEnv>, deps: TenantRouteDeps) {
  const ctx = await objectContext(c, deps, OBJECT, 'update', revision(c));
  const id = uuidParam(c);
  const itemId = uuidParam(c, 'itemId');
  const input = await parseBody(c, z.strictObject({}));
  await button(deps, ctx, OBJECT, ...HEAD_BUTTONS.update);
  const gate = transferGate(deps, ctx);
  const hiddenOf = async (tx: Tx) => hiddenTransferIds(tx, deps, ctx, id, await hiddenItemIds(tx, deps, ctx, id));
  return transferCommand(c, deps, ctx, id, input, {
    kind: 'save',
    gate,
    check: async (tx, view) => {
      const row = (await loadTransfers(tx, ctx.tenantId, id)).find((item) => item.id === itemId);
      if (row && (await hiddenOf(tx)).has(row.id)) throw new AppError('NOT_FOUND', ROW_NOT_FOUND);
      if (row) await gate.rejudge(tx, view, [row]);
    },
    execute: async (tx, commandCtx) => rebaseTransferItem(tx, commandCtx, id, itemId, gate, await hiddenOf(tx)),
  });
}
