/**
 * R3-T04 PR-B6a 盘点模板接口（设计 §2.3、§7；前缀 /api/tenant/talent-review）：模板列表 / 详情（可按 ?version=n 读历史版本）/
 * 新建 / 修改 / 删除。路由权限声明见 docs/08_设计/R3-T04_PR-B6a_路由声明.md。模板按所属组织 ∪ 创建人判定范围，可向下公开
 * （只读，template-access.ts）；写入走命令台账（幂等、If-Match revision 409），首次执行、直接重放与失败后回查都在命令事务内按当前
 * 授权复核（`guard.before` / `guard.replayed`，AGENTS §10、DEC-388①），拒绝即整体回滚。
 * 引用流程 / 评价规则 / 模块等级 / 盘点字段 = 读取对应目录：另需目录对象的查看权，看不到的引用与不存在同一个 404。
 */
import {
  talentReviewFields,
  talentReviewForms,
  talentReviewFlows,
  talentReviewModuleGrades,
  talentReviewScoreRules,
  talentReviewTemplates,
  withTenant,
  type Tx,
} from '@italent/db';
import type { Context, Hono } from 'hono';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import {
  authorizeInTransaction,
  getModuleViewableFields,
  resolveModuleScopeInTransaction,
} from '../permission/module-access.js';
import { booleanQuery, pageQuery, parseBody, requireNew, revision, uuidParam } from '../talent/http.js';
import {
  checkWriteFields,
  codeOf,
  notFoundMessage,
  requireFilterVisible,
  reviewContext,
  reviewScope,
  reviewWriteContext,
  TALENT_REVIEW_BASE,
  trimReview,
  type ModuleScope,
  type TalentReviewContext,
} from './access.js';
import { listConfig, type ConfigTable } from './config-kit.js';
import { requireReferencesVisible, type ReferencedTable } from './reference-kit.js';
import {
  templateCopy,
  templateCreate,
  templatePatch,
  type TemplateCreate,
  type TemplatePatch,
} from './template-input.js';
import {
  listAccess,
  requireCreatable,
  requireEditable,
  requireReadable,
  templateReadable,
  type TemplateAccess,
} from './template-access.js';
import * as service from './template-service.js';
import { TEMPLATE_REFERENCES, type TemplateReference, type TemplateWriteContext } from './template-structure.js';
import { button } from '../permission/module-route-access.js';
import { copyReferences } from './template-copy.js';
import { headerColumns, headerOf, type TemplateView } from './template-view.js';

import { projectTemplateResults, resultCatalogAccess, templateBusinessFields } from './template-extra-present.js';
import { requireBoundItemsReferenceable } from './calc-rule-bound.js';
import { loadFullCatalog } from './calc-rule-catalog.js';

const TEMPLATES = `${TALENT_REVIEW_BASE}/templates`;
const TABLE = talentReviewTemplates as unknown as ConfigTable;
const CATALOG_TABLES: Record<TemplateReference, ReferencedTable> = {
  flow: talentReviewFlows as never,
  form: talentReviewForms as never,
  scoreRule: talentReviewScoreRules as never,
  moduleGrade: talentReviewModuleGrades as never,
  field: talentReviewFields as never,
};

type References = Record<TemplateReference, string[]>;
const uniq = (ids: readonly (string | null | undefined)[]) => [...new Set(ids.filter((id): id is string => !!id))];

/** 请求里显式提交的目录引用（含原样带上的已有引用）：命令内逐类复核目录查看权与可见性。 */
function referencesOf(body: TemplateCreate | TemplatePatch): References {
  const modules = body.modules ?? [];
  return {
    flow: uniq([body.flowId]),
    scoreRule: uniq(modules.map((m) => m.scoreRuleId)),
    moduleGrade: uniq(modules.map((m) => m.moduleGradeId)),
    form: uniq((body.stepForms ?? []).map((s) => s.formId)),
    field: uniq([...modules.flatMap((m) => m.fieldIds ?? []), ...(body.resultRules ?? []).map((r) => r.targetFieldId)]),
  };
}
const referenced = (references: References) => TEMPLATE_REFERENCES.filter((kind) => references[kind].length > 0);

/** 响应视图：去掉内部的版本行 id，带上当前查看人对该模板的访问级别。 */
function present(view: TemplateView, access: Exclude<TemplateAccess, 'none'>) {
  const { versionId: _versionId, ...rest } = view;
  return { ...rest, versionNo: view.versionNo, accessLevel: access };
}

/**
 * 字段裁剪后的响应。`configErrors` 是从 `modules`（模块名称）与 `permissions`（权重）派生的，两者任一被裁掉就不得把派生值
 * 重新挂回（嵌套内容逐层裁剪）；其余字段各按本对象字段权限。
 */
async function trimmed(deps: TenantRouteDeps, ctx: TalentReviewContext, view: ReturnType<typeof present>) {
  const projected = await projectTemplateResults(deps, ctx, view);
  const [shown] = await trimReview(deps, ctx, 'template', [projected]);
  if (shown && !('modules' in shown && 'permissions' in shown)) delete shown.configErrors;
  return shown;
}

/** 目录准入：事务内调用必须传 tx，避免范围查询另开连接或在单连接环境等待自身事务。 */
async function requireCatalogs(c: Context<TenantEnv>, deps: TenantRouteDeps, references: References, tx?: Tx) {
  for (const kind of referenced(references)) {
    const ctx = await reviewContext(c, deps, kind);
    if (tx) await resolveModuleScopeInTransaction(deps, ctx, tx, codeOf(kind));
    else await reviewScope(c, deps, ctx, kind);
  }
}

async function copyContext(c: Context<TenantEnv>, deps: TenantRouteDeps, expectedRevision: number) {
  const ctx = await reviewContext(c, deps, 'template', 'create', expectedRevision);
  await reviewContext(c, deps, 'template');
  await button(deps, ctx, codeOf('template'), 'copy', 'list');
  return ctx;
}

interface Rechecked {
  readonly ctx: TalentReviewContext;
  readonly scope: ModuleScope;
  readonly scopes: TemplateWriteContext['scopes'];
  readonly fieldAccess?: TemplateWriteContext['fieldAccess'];
}

/**
 * 命令事务内的当前权限复核（首次执行、直接重放、失败后回查三条路径都经过 commands.ts 的 ledgerExit → guard.before）：对象数据操作权、
 * 按钮、所属组织范围、提交字段的编辑权、被引用目录的查看权与范围，都在**事务内**按当前授权重新解析，不沿用事务外保存的快照。
 */
async function recheck(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  tx: Tx,
  operation: 'create' | 'update' | 'delete',
  expectedRevision: number,
  references: References,
  copying = false,
): Promise<Rechecked & { txDeps: TenantRouteDeps }> {
  const txDeps: TenantRouteDeps = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  const ctx = copying
    ? await copyContext(c, txDeps, expectedRevision)
    : await reviewWriteContext(c, txDeps, 'template', operation, expectedRevision);
  const scope = await resolveModuleScopeInTransaction(txDeps, ctx, tx, codeOf('template'));
  const scopes: Rechecked['scopes'] = {};
  for (const kind of referenced(references)) {
    await reviewContext(c, txDeps, kind);
    scopes[kind] = await resolveModuleScopeInTransaction(txDeps, ctx, tx, codeOf(kind));
  }
  return { ctx, scope, scopes, txDeps };
}

/** 新建 / 修改：另复核载荷逐字段的编辑权（含显式清空）；删除没有字段输入，只用 recheck。 */
async function recheckFields(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  tx: Tx,
  operation: 'create' | 'update',
  expectedRevision: number,
  references: References,
  fields: Readonly<Record<string, unknown>>,
): Promise<Rechecked> {
  const checked = await recheck(c, deps, tx, operation, expectedRevision, references);
  const input = fields as TemplatePatch;
  await checkWriteFields(checked.txDeps, checked.ctx, 'template', operation, templateBusinessFields(input));
  const fieldAccess = input.resultRules?.length
    ? await resultCatalogAccess(checked.txDeps, checked.ctx, tx)
    : undefined;
  if (fieldAccess && input.resultRules) {
    await requireBoundItemsReferenceable(
      await loadFullCatalog(tx, checked.ctx.tenantId),
      input.resultRules,
      fieldAccess,
    );
  }
  return { ...checked, fieldAccess };
}

/**
 * 命令执行：权限与范围在命令事务内按当前授权复核（`guard.before`，写入之前）；返回台账结果时（直接重放、失败后回查）结果模板按当前
 * 范围仍须可编辑、请求里的目录引用仍须可见（`guard.replayed`，撤权后 404 / 403）。
 */
async function runGuarded(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: TalentReviewContext,
  body: object,
  status: 200 | 201,
  check: { operation: 'create' | 'update' | 'delete'; references: References; copying?: boolean },
  recheckInTx: (tx: Tx) => Promise<Rechecked>,
  execute: (tx: Tx, w: TemplateWriteContext) => Promise<TemplateView>,
) {
  let current: Rechecked | undefined;
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: ctx.expectedRevision, input: body },
    guard: {
      before: async (tx) => {
        current = await recheckInTx(tx);
      },
      replayed: async (tx, replay) => {
        const view = replay.body as TemplateView;
        // 原件后来可以移除引用；复制回执仍持有的引用必须按当前授权单独复核。
        const references = check.copying ? copyReferences(view) : check.references;
        const { scope, scopes } = check.copying
          ? await recheck(c, deps, tx, 'create', ctx.expectedRevision, references, true)
          : current!;
        // 删除的受控快照按删除时的归属判定；其余按模板当前归属（已不存在 → 404）
        const anchor = check.operation === 'delete' ? view : await headerOf(tx, ctx.tenantId, view.id);
        if (!anchor) throw new AppError('NOT_FOUND', notFoundMessage('template'));
        await requireEditable(tx, ctx, scope, anchor);
        for (const kind of referenced(references)) {
          const catalog = scopes[kind];
          if (catalog) {
            await requireReferencesVisible(tx, CATALOG_TABLES[kind], kind, ctx.tenantId, references[kind], catalog);
          }
        }
      },
    },
    execute: async (tx, commandId) => {
      const { ctx: fresh, scope, scopes, fieldAccess } = current!;
      return { status, body: await execute(tx, { ...fresh, commandId, scope, scopes, fieldAccess }) };
    },
  });
  const view = result.body as TemplateView;
  if (c.req.method !== 'DELETE') c.header('ETag', `"${view.revision}"`);
  return c.json(await trimmed(deps, ctx, present(view, 'manage')), result.status);
}

function versionQuery(c: Context): number | undefined {
  const raw = c.req.query('version');
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d{1,9}$/.test(raw) || Number(raw) < 1) throw new AppError('VALIDATION_FAILED', 'version 必须为正整数');
  return Number(raw);
}

function registerTemplateCopyRoute(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.post(`${TEMPLATES}/:id/copy`, async (c) => {
    const ctx = await copyContext(c, deps, revision(c));
    const id = uuidParam(c);
    const body = await parseBody(c, templateCopy);
    const references = referencesOf({});
    const before = async (tx: Tx) => {
      const checked = await recheck(c, deps, tx, 'create', ctx.expectedRevision, references, true);
      await checkWriteFields(checked.txDeps, checked.ctx, 'template', 'create', body);
      const source = await service.readTemplate(tx, ctx.tenantId, id);
      await requireEditable(tx, checked.ctx, checked.scope, source);
      requireCreatable(checked.scope, source.ownerOrgId);
      Object.assign(references, copyReferences(source));
      await requireCatalogs(c, checked.txDeps, references, tx);
      // 自动带入的配置也按当前目录权限复核；同键重放同样经过 before。
      return recheck(c, deps, tx, 'create', ctx.expectedRevision, references, true);
    };
    return runGuarded(c, deps, ctx, body, 201, { operation: 'create', references, copying: true }, before, (tx, w) =>
      service.copyTemplate(tx, w, id, body.name),
    );
  });
}

export function registerTemplateRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  registerTemplateCopyRoute(router, deps);
  router.get(TEMPLATES, async (c) => {
    const ctx = await reviewContext(c, deps, 'template');
    const page = pageQuery(c);
    const enabled = booleanQuery(c, 'enabled');
    // 筛选字段同样受字段查看权约束：看不到 enabled 的人不能用筛选还原启用状态
    if (enabled !== undefined) await requireFilterVisible(deps, ctx, 'template', 'enabled');
    const scope = await reviewScope(c, deps, ctx, 'template');
    // 排序只用查看人看得到的字段（隐藏的 name 不能影响顺序与分页）
    const viewable = await getModuleViewableFields(deps, ctx, codeOf('template'));
    const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
      listConfig(
        tx,
        { table: TABLE, view: headerColumns, orderBy: [['name', talentReviewTemplates.name]] },
        ctx.tenantId,
        { ...page, enabled, visible: templateReadable(ctx, scope), viewable },
      ),
    );
    const shown = items.map((item) => ({
      ...item,
      versionNo: item.currentVersionNo,
      accessLevel: listAccess(scope, item as never),
    }));
    return c.json({
      page: page.page,
      pageSize: page.pageSize,
      hasDataPermission: scope.all || scope.hasDataPermission,
      items: await trimReview(deps, ctx, 'template', shown),
    });
  });

  router.get(`${TEMPLATES}/:id`, async (c) => {
    const ctx = await reviewContext(c, deps, 'template');
    const id = uuidParam(c);
    const version = versionQuery(c);
    const scope = await reviewScope(c, deps, ctx, 'template');
    const found = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const header = await headerOf(tx, ctx.tenantId, id);
      if (!header) throw new AppError('NOT_FOUND', notFoundMessage('template'));
      const access = await requireReadable(tx, ctx, scope, header);
      return { view: await service.readTemplate(tx, ctx.tenantId, id, version), access };
    });
    c.header('ETag', `"${found.view.revision}"`);
    return c.json(await trimmed(deps, ctx, present(found.view, found.access)));
  });

  router.post(TEMPLATES, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'template', 'create', revision(c));
    requireNew(ctx.expectedRevision);
    const body = await parseBody(c, templateCreate);
    await checkWriteFields(deps, ctx, 'template', 'create', templateBusinessFields(body));
    const references = referencesOf(body);
    await requireCatalogs(c, deps, references);
    const before = (tx: Tx) => recheckFields(c, deps, tx, 'create', ctx.expectedRevision, references, body);
    return runGuarded(c, deps, ctx, body, 201, { operation: 'create', references }, before, (tx, w) =>
      service.createTemplate(tx, w, body),
    );
  });

  router.patch(`${TEMPLATES}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'template', 'update', revision(c));
    const id = uuidParam(c);
    const body = await parseBody(c, templatePatch);
    await checkWriteFields(deps, ctx, 'template', 'update', templateBusinessFields(body));
    const references = referencesOf(body);
    await requireCatalogs(c, deps, references);
    const before = (tx: Tx) => recheckFields(c, deps, tx, 'update', ctx.expectedRevision, references, body);
    return runGuarded(c, deps, ctx, body, 200, { operation: 'update', references }, before, (tx, w) =>
      service.updateTemplate(tx, w, id, body),
    );
  });

  router.delete(`${TEMPLATES}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'template', 'delete', revision(c));
    const id = uuidParam(c);
    const references = referencesOf({});
    const before = (tx: Tx) => recheck(c, deps, tx, 'delete', ctx.expectedRevision, references);
    return runGuarded(c, deps, ctx, { id }, 200, { operation: 'delete', references }, before, (tx, w) =>
      service.deleteTemplate(tx, w, id),
    );
  });
}
