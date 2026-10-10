/**
 * R3-T04 PR-B3 接口（设计 §2.2、§7 配置 CRUD / 流程定义 CRUD 行；前缀 /api/tenant/talent-review）：盘点内容表单 forms
 * （字段三档 + required 随表单整组维护）、盘点流程定义 flows（节点与角色随流程整组维护）。路由权限声明见
 * docs/08_设计/R3-T04_PR-B3_路由声明.md。读写模式同 B4（matrix-routes.ts）：没有组织字段，列表按创建人谓词（分页之前）过滤，
 * 详情 / 写入范围外与不存在同一个 404，新建只有看全部可建；写入走命令台账（幂等、If-Match revision 409），首次执行、直接重放
 * 与失败后回查都在命令事务内按当前授权复核（`guard.before` / `guard.replayed`，AGENTS §10、DEC-388①），拒绝即整体回滚。
 * 引用盘点字段（表单）/ 盘点角色（流程）= 读取对应目录：另需目录对象的查看权，看不到的引用与不存在同一个 404。
 */
import { talentReviewFields, talentReviewRoles, type Tx } from '@italent/db';
import type { Context, Hono } from 'hono';
import { runCommand } from '../../commands.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { authorizeInTransaction, resolveModuleScopeInTransaction } from '../permission/module-access.js';
import { parseBody, requireNew, revision, uuidParam } from '../talent/http.js';
import {
  checkWriteFields,
  codeOf,
  requireConfigVisible,
  reviewContext,
  reviewScope,
  reviewWriteContext,
  TALENT_REVIEW_BASE,
  trimReview,
  type ModuleScope,
  type TalentReviewContext,
} from './access.js';
import { detailResponse, listResponse, type Viewed } from './config-routes.js';
import { flowCreate, flowPatch, formCreate, formPatch } from './form-flow-input.js';
import * as flows from './flow-service.js';
import * as forms from './form-service.js';
import {
  type ReferencedObject,
  type ReferencedTable,
  type ReferenceWriteContext,
  requireReferencesVisible,
} from './reference-kit.js';

const FORMS = `${TALENT_REVIEW_BASE}/forms`;
const FLOWS = `${TALENT_REVIEW_BASE}/flows`;

interface Kind {
  readonly object: 'form' | 'flow';
  /** 引用的目录对象：表单 → 盘点字段，流程 → 盘点角色。 */
  readonly referenced: ReferencedObject;
  readonly referencedTable: ReferencedTable;
}
const FORM: Kind = { object: 'form', referenced: 'field', referencedTable: talentReviewFields as never };
const FLOW: Kind = { object: 'flow', referenced: 'role', referencedTable: talentReviewRoles as never };

/** 命令事务内要重新复核的内容：操作种类、请求里引用的目录对象 id。 */
interface Recheck {
  readonly operation: 'create' | 'update' | 'delete';
  readonly references: readonly string[];
}
interface Rechecked {
  readonly txDeps: TenantRouteDeps;
  readonly ctx: TalentReviewContext;
  readonly scope: ModuleScope;
  readonly referenceScope?: ModuleScope;
}

/**
 * 引用目录对象 = 读取目录：另需目录对象的查看权，并按其范围判定引用可见性（看不到的引用与不存在同一个 404，命令内判定）。
 * 请求不带引用时不需要。
 */
async function requireCatalog(c: Context<TenantEnv>, deps: TenantRouteDeps, referenced: ReferencedObject) {
  const ctx = await reviewContext(c, deps, referenced);
  await reviewScope(c, deps, ctx, referenced);
}
const requireFieldCatalog = (c: Context<TenantEnv>, deps: TenantRouteDeps) => requireCatalog(c, deps, 'field');
const requireRoleCatalog = (c: Context<TenantEnv>, deps: TenantRouteDeps) => requireCatalog(c, deps, 'role');

/**
 * 命令事务内的当前权限复核（首次执行、直接重放、失败后回查三条路径都经过 commands.ts 的 ledgerExit → guard.before）：
 * 对象数据操作权、按钮、范围、引用目录的查看权与范围都在**事务内**按当前授权重新解析，不沿用事务外保存的快照；
 * 新建 / 修改另复核载荷逐字段的编辑权（含显式清空）。
 */
async function recheck(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  tx: Tx,
  kind: Kind,
  expectedRevision: number,
  spec: Recheck,
  fields: Readonly<Record<string, unknown>> | undefined,
): Promise<Rechecked> {
  const txDeps: TenantRouteDeps = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  const ctx = await reviewWriteContext(c, txDeps, kind.object, spec.operation, expectedRevision);
  const scope = await resolveModuleScopeInTransaction(txDeps, ctx, tx, codeOf(kind.object));
  if (fields) await checkWriteFields(txDeps, ctx, kind.object, spec.operation as 'create' | 'update', fields);
  if (spec.references.length === 0) return { txDeps, ctx, scope };
  await reviewContext(c, txDeps, kind.referenced);
  const referenceScope = await resolveModuleScopeInTransaction(txDeps, ctx, tx, codeOf(kind.referenced));
  return { txDeps, ctx, scope, referenceScope };
}

type Execute<V> = (tx: Tx, ctx: ReferenceWriteContext) => Promise<V>;

/**
 * 命令执行：权限与范围在命令事务内按当前授权复核（`guard.before`，写入之前）；返回台账结果时（直接重放、失败后回查）结果
 * 对象与请求里的引用按当前范围仍须可见（`guard.replayed`，撤权后 404），响应按当前字段权限裁剪。
 */
async function runGuarded<V extends Viewed & { id: string; name: string }>(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: TalentReviewContext,
  kind: Kind,
  body: object,
  status: 200 | 201,
  spec: Recheck,
  fields: Readonly<Record<string, unknown>> | undefined,
  execute: Execute<V>,
) {
  let current: Rechecked | undefined;
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: ctx.expectedRevision, input: body },
    guard: {
      before: async (tx) => {
        current = await recheck(c, deps, tx, kind, ctx.expectedRevision, spec, fields);
      },
      replayed: async (tx, replay) => {
        const { scope, referenceScope } = current!;
        requireConfigVisible(scope, kind.object, (replay.body as V).createdBy);
        if (referenceScope && spec.references.length > 0) {
          await requireReferencesVisible(
            tx,
            kind.referencedTable,
            kind.referenced,
            ctx.tenantId,
            spec.references,
            referenceScope,
          );
        }
      },
    },
    execute: async (tx, commandId) => {
      const { ctx: fresh, scope, referenceScope } = current!;
      const view = await execute(tx, {
        ...fresh,
        commandId,
        scope,
        references: spec.references,
        ...(referenceScope ? { referenceScope } : {}),
      });
      return { status, body: view };
    },
  });
  const view = result.body as V;
  requireConfigVisible(current!.scope, kind.object, view.createdBy);
  if (c.req.method !== 'DELETE') c.header('ETag', `"${view.revision}"`);
  return c.json((await trimReview(deps, ctx, kind.object, [view]))[0], result.status);
}

const formReferences = (body: { fields?: { fieldId: string }[] }): string[] =>
  (body.fields ?? []).map((f) => f.fieldId);
const flowReferences = (body: { nodes?: { roleIds: string[] }[] }): string[] =>
  (body.nodes ?? []).flatMap((node) => node.roleIds);

export function registerFormFlowRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  registerForms(router, deps);
  registerFlows(router, deps);
}

function registerForms(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(FORMS, async (c) => {
    const ctx = await reviewContext(c, deps, 'form');
    return listResponse(c, deps, ctx, 'form', 'talent_review_forms', forms.FORM, (tx, found) =>
      forms.withFields(tx, ctx.tenantId, found as never),
    );
  });
  router.get(`${FORMS}/:id`, async (c) => {
    const ctx = await reviewContext(c, deps, 'form');
    return detailResponse(c, deps, ctx, 'form', forms.FORM);
  });
  router.post(FORMS, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'form', 'create', revision(c));
    requireNew(ctx.expectedRevision);
    const body = await parseBody(c, formCreate);
    await checkWriteFields(deps, ctx, 'form', 'create', body);
    const references = formReferences(body);
    // 路由层的前置检查只管早失败；以命令事务内的复核（runGuarded）为准
    if (references.length > 0) await requireFieldCatalog(c, deps);
    const spec = { operation: 'create', references } as const;
    return runGuarded(c, deps, ctx, FORM, body, 201, spec, body, (tx, w) => forms.createForm(tx, w, body));
  });
  router.patch(`${FORMS}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'form', 'update', revision(c));
    const id = uuidParam(c);
    const body = await parseBody(c, formPatch);
    await checkWriteFields(deps, ctx, 'form', 'update', body);
    const references = formReferences(body);
    if (references.length > 0) await requireFieldCatalog(c, deps);
    const spec = { operation: 'update', references } as const;
    return runGuarded(c, deps, ctx, FORM, body, 200, spec, body, (tx, w) => forms.updateForm(tx, w, id, body));
  });
  router.delete(`${FORMS}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'form', 'delete', revision(c));
    const id = uuidParam(c);
    const spec = { operation: 'delete', references: [] } as const;
    return runGuarded(c, deps, ctx, FORM, { id }, 200, spec, undefined, (tx, w) => forms.deleteForm(tx, w, id));
  });
}

function registerFlows(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(FLOWS, async (c) => {
    const ctx = await reviewContext(c, deps, 'flow');
    return listResponse(c, deps, ctx, 'flow', 'talent_review_flows', flows.FLOW, (tx, found) =>
      flows.withNodes(tx, ctx.tenantId, found as never),
    );
  });
  router.get(`${FLOWS}/:id`, async (c) => {
    const ctx = await reviewContext(c, deps, 'flow');
    return detailResponse(c, deps, ctx, 'flow', flows.FLOW);
  });
  router.post(FLOWS, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'flow', 'create', revision(c));
    requireNew(ctx.expectedRevision);
    const body = await parseBody(c, flowCreate);
    await checkWriteFields(deps, ctx, 'flow', 'create', body);
    const references = flowReferences(body);
    if (references.length > 0) await requireRoleCatalog(c, deps);
    const spec = { operation: 'create', references } as const;
    return runGuarded(c, deps, ctx, FLOW, body, 201, spec, body, (tx, w) => flows.createFlow(tx, w, body));
  });
  router.patch(`${FLOWS}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'flow', 'update', revision(c));
    const id = uuidParam(c);
    const body = await parseBody(c, flowPatch);
    await checkWriteFields(deps, ctx, 'flow', 'update', body);
    const references = flowReferences(body);
    if (references.length > 0) await requireRoleCatalog(c, deps);
    const spec = { operation: 'update', references } as const;
    return runGuarded(c, deps, ctx, FLOW, body, 200, spec, body, (tx, w) => flows.updateFlow(tx, w, id, body));
  });
  router.delete(`${FLOWS}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'flow', 'delete', revision(c));
    const id = uuidParam(c);
    const spec = { operation: 'delete', references: [] } as const;
    return runGuarded(c, deps, ctx, FLOW, { id }, 200, spec, undefined, (tx, w) => flows.deleteFlow(tx, w, id));
  });
}
