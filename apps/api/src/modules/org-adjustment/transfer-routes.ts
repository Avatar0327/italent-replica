/**
 * 调动明细写路由（R2-T08 §9.3 路由 16～18，BE-11c-b）：POST / PATCH / DELETE `…/adjustments/:id/transfer-items[/:itemId]`。
 * 与组织明细同一台账幂等；守卫（首次与重放都经过）在事务内按当前权限判：按钮 `EditAdjustOrgDetailBtn@detail`、
 * 主体组织在主对象范围、调动表单与联动授权（`transferGate`，与人工调动同一条链）；重放再按结果行复核来源员工与目标部门。
 * 联动目标范围（非事务连接）与任职对象上下文在命令外先算（PGlite 单连接下事务内嵌套会死锁）。
 * 响应按 `transferItems.*` 查看权裁剪；行的身份列总是返回。
 */
import { withTenant, type Tx } from '@italent/db';
import { ORG_ADJUSTMENT_CONTRACT_CONTAINER, ORG_ADJUSTMENT_OBJECT_CODE } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { contextOf, EMPLOYMENT_OBJECT } from '../employment/context.js';
import { parseBody, revision, uuidParam } from '../job/context.js';
import { resolveLinkageAccess } from '../transfer/linkage/access.js';
import { normalizeLinkage, type LinkageOptions } from '../transfer/linkage/input.js';
import { getModuleViewableFields } from '../permission/module-access.js';
import type { ScopeBusinessContext } from '../permission/module-contracts.js';
import { button, objectContext, writeFields } from '../permission/module-route-access.js';
import { ADJUSTMENT_NOT_FOUND, authorizeItem, HEAD_BUTTONS } from './access.js';
import { hiddenItemIds } from './hidden-rows.js';
import { loadAdjustment } from './service.js';
import { transferGate } from './transfer-access.js';
import {
  addTransferItem,
  addTransferSchema,
  deleteTransferItem,
  draftOf,
  EMPTY,
  patchTransferItem,
  patchTransferSchema,
  transferRaw,
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
const LINKAGE_CODE: Readonly<Record<string, string>> = {
  dutyTransfer: 'transferItems.dutyTransfer',
  onTrial: 'transferItems.trial',
  adjustSalary: 'transferItems.adjustSalary',
  contract: ORG_ADJUSTMENT_CONTRACT_CONTAINER,
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
    const gate = await gateFor(c, deps, ctx, input.linkage ? normalizeLinkage(input.linkage) : null, null);
    return transferCommand(c, deps, ctx, id, input, {
      gate,
      check: (tx, view) =>
        gate.save(tx, input.employeeId, transferRaw(view.effectiveDate, draftOf(EMPTY, input)), null),
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
    const stored = await storedRow(deps, ctx, id, itemId);
    const options = input.linkage !== undefined ? (input.linkage ? normalizeLinkage(input.linkage) : null) : null;
    const gate = await gateFor(c, deps, ctx, options ?? stored?.linkage ?? null, stored?.linkage ?? null);
    return transferCommand(c, deps, ctx, id, input, {
      gate,
      check: async (tx, view) => {
        const row = (await loadTransfers(tx, ctx.tenantId, id)).find((item) => item.id === itemId);
        if (row) await gate.save(tx, row.employeeId, transferRaw(view.effectiveDate, draftOf(row, input)), row.linkage);
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
    const stored = await storedRow(deps, ctx, id, itemId);
    const gate = await gateFor(c, deps, ctx, null, stored?.linkage ?? null);
    return transferCommand(
      c,
      deps,
      ctx,
      id,
      {},
      {
        gate,
        check: async (tx) => {
          const row = (await loadTransfers(tx, ctx.tenantId, id)).find((item) => item.id === itemId);
          if (row) await gate.remove(tx, row);
        },
        execute: (tx, commandCtx) => deleteTransferItem(tx, commandCtx, id, itemId, gate),
      },
    );
  });
}

/** 路由事务外：任职对象上下文（对象 create 权 + 任职范围）与联动目标范围按当前权限算好，交给事务内的 gate。 */
async function gateFor(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: ScopeBusinessContext,
  options: LinkageOptions | null,
  before: LinkageOptions | null,
): Promise<TransferGate> {
  const employment = await contextOf(
    tenantOf(c),
    deps,
    'object.create',
    ctx.expectedRevision,
    undefined,
    EMPLOYMENT_OBJECT,
  );
  const access = await resolveLinkageAccess(deps, tenantOf(c), options, before);
  return transferGate(deps, employment, access);
}

/**
 * 提交（路由 10）的调动行复核（§6.3“提交”列：全部行按新建口径再判一遍当前权限）：联动目标范围与任职对象上下文在命令外按库里的行
 * 先算好；返回的函数在命令事务内（首次与重放都经过）逐行走保存同一条授权链（before = null）。没有调动行时什么都不做。
 */
export async function prepareTransferSubmitCheck(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: ScopeBusinessContext,
  id: string,
): Promise<(tx: Tx, effectiveDate: string) => Promise<void>> {
  const rows = await withTenant(deps.db, ctx.tenantId, (tx) => loadTransfers(tx, ctx.tenantId, id));
  if (!rows.length) return async () => {};
  const gates = new Map<string, TransferGate>();
  for (const row of rows) gates.set(row.id, await gateFor(c, deps, ctx, row.linkage, null));
  return async (tx, effectiveDate) => {
    for (const row of rows) {
      await gates.get(row.id)!.save(tx, row.employeeId, transferRaw(effectiveDate, draftOf(row, {})), null);
    }
  };
}

/** 改 / 删前先读库里的行（只读，用于解析旧联动的目标范围）；申请单或行不存在由命令内报 404。 */
async function storedRow(deps: TenantRouteDeps, ctx: ScopeBusinessContext, id: string, itemId: string) {
  return withTenant(deps.db, ctx.tenantId, async (tx) =>
    (await loadTransfers(tx, ctx.tenantId, id)).find((row) => row.id === itemId),
  );
}

interface TransferCommand {
  readonly gate: TransferGate;
  /** 守卫内按当前权限与表单规则校验请求（首次与重放都经过）；行不存在留给写服务报 404。 */
  check(tx: Tx, view: NonNullable<Awaited<ReturnType<typeof loadAdjustment>>>): Promise<unknown>;
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
        await authorizeItem(tx, deps, ctx, {
          button: [OBJECT, ...HEAD_BUTTONS.update],
          subjectOrgId: stored.approvalSubjectOrgId,
          orgIds: [],
        });
        await command.check(tx, stored);
      },
      replayed: async (tx, stored) => {
        await command.gate.replay(tx, (stored.body as TransferResult).items);
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

async function trimTransfers(deps: TenantRouteDeps, ctx: ScopeBusinessContext, result: TransferResult) {
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
