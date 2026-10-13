/**
 * 盘点模板的读写（设计 §2.3；TR-R11～R20）。模板 = 头部（名称、所属组织、向下公开、流程、启停）+ 版本化结构（步骤 / 模块 / 权限，
 * template-structure.ts）。头部字段修改不生成版本，结构保存（流程换了、或提交了任一结构件）生成新版本，旧版本不变。
 * 写入在命令台账的同一租户事务里完成“业务写 + 审计”；写入前对模板行 FOR UPDATE，再校验范围（404 / 403）与 revision（409）。
 * 被引用拒删：流程 / 角色 / 评价规则 / 模块等级 / 盘点字段 / 人才标准被模板版本引用时，对应删除返回 409（守卫在文件末登记）。
 */
import {
  and,
  eq,
  orgObjects,
  talentReviewTemplateModuleFields as MF,
  talentReviewTemplateModules as M,
  talentReviewTemplateStepModulePermissions as P,
  talentReviewTemplateStepRoles as SR,
  talentReviewTemplates as T,
  talentReviewTemplateVersions as V,
  type Tx,
} from '@italent/db';
import { AppError } from '../../errors.js';
import { recordAudit } from '../../audit/record.js';
import { auditActor } from '../../system-actor.js';
import { codeOf, notFoundMessage, TALENT_REVIEW_AUDIT_ACTIONS } from './access.js';
import { configReferrer, registerConfigReferenceGuard, uniqueOr } from './config-kit.js';
import { registerTalentCriterionReferenceGuard } from '../talent/port.js';
import type { TemplateCreate, TemplatePatch } from './template-input.js';
import { requireCreatable, requireEditable, type TemplateAnchor } from './template-access.js';
import { buildPlan, checkTemplateReferences, type TemplateWriteContext, writeVersion } from './template-structure.js';
import { loadTemplate, type TemplateView } from './template-view.js';

import { copyPlan } from './template-copy.js';
import { loadFullCatalog } from './calc-rule-catalog.js';

const invalid = (reason: string, message: string) => new AppError('VALIDATION_FAILED', message, { reason });

async function requireOrg(tx: Tx, tenantId: string, orgId: string) {
  const [found] = await tx
    .select({ id: orgObjects.id })
    .from(orgObjects)
    .where(and(eq(orgObjects.tenantId, tenantId), eq(orgObjects.id, orgId)));
  if (!found) throw new AppError('NOT_FOUND', notFoundMessage('template'));
}

const requireFlowWhenEnabled = (enabled: boolean, flowId: string | null) => {
  if (enabled && !flowId) throw invalid('TEMPLATE_FLOW_REQUIRED', '启用模板须先选择评价流程');
};

/** 审计：快照里不带派生的版本清单；归属带所属组织（审计查询按查看人当前的范围裁剪）。 */
async function audit(
  tx: Tx,
  ctx: TemplateWriteContext,
  operation: 'create' | 'update' | 'delete',
  id: string,
  before: TemplateView | null,
  after: TemplateView | null,
) {
  const names = new Map((await loadFullCatalog(tx, ctx.tenantId)).map((f) => [f.id, f.name]));
  const strip = (view: TemplateView | null) =>
    view
      ? {
          ...view,
          versions: undefined,
          versionId: undefined,
          resultRules: view.resultRules.map(({ refModuleIds: _moduleIds, ...r }) => ({
            ...r,
            fieldNames: Object.fromEntries(r.refFieldIds.map((id) => [id, names.get(id)])),
          })),
        }
      : null;
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    action: `${TALENT_REVIEW_AUDIT_ACTIONS.template}.${operation}`,
    objectType: codeOf('template'),
    objectId: id,
    before: strip(before),
    after: strip(after),
    commandId: ctx.commandId,
    occurredAt: ctx.now,
    scope: { orgId: (after ?? before)!.ownerOrgId },
  });
}

/** 行锁 → 范围（404 / 403）→ revision（409）；返回锁住的锚点。 */
async function lockTemplate(
  tx: Tx,
  ctx: TemplateWriteContext,
  id: string,
): Promise<TemplateAnchor & { revision: number }> {
  const [row] = await tx
    .select({
      revision: T.revision,
      ownerOrgId: T.ownerOrgId,
      downwardPublic: T.downwardPublic,
      createdBy: T.createdBy,
    })
    .from(T)
    .where(and(eq(T.tenantId, ctx.tenantId), eq(T.id, id)))
    .for('update');
  if (!row) throw new AppError('NOT_FOUND', notFoundMessage('template'));
  await requireEditable(tx, ctx, ctx.scope, row);
  if (row.revision !== ctx.expectedRevision) {
    throw new AppError('REVISION_CONFLICT', '盘点模板已变更，请刷新后显式重提', {
      expected: ctx.expectedRevision,
      actual: row.revision,
    });
  }
  return row;
}

export async function createTemplate(tx: Tx, ctx: TemplateWriteContext, input: TemplateCreate): Promise<TemplateView> {
  requireCreatable(ctx.scope, input.ownerOrgId);
  await requireOrg(tx, ctx.tenantId, input.ownerOrgId);
  requireFlowWhenEnabled(input.enabled ?? false, input.flowId ?? null);
  const plan = await buildPlan(tx, ctx, null, input);
  const [created] = await uniqueOr('TEMPLATE_DUPLICATE', '盘点模板', () =>
    tx
      .insert(T)
      .values({
        tenantId: ctx.tenantId,
        name: input.name,
        ownerOrgId: input.ownerOrgId,
        downwardPublic: input.downwardPublic ?? false,
        flowId: plan.flowId,
        enabled: input.enabled ?? false,
        currentVersionNo: 1,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .returning({ id: T.id }),
  );
  await writeVersion(tx, ctx, created!.id, 1, plan);
  const after = (await loadTemplate(tx, ctx.tenantId, created!.id))!;
  await audit(tx, ctx, 'create', after.id, null, after);
  return after;
}

/** 复制持有原件行锁，revision 校验与冻结结构读取在同一事务，不与原件编辑混读。 */
export async function copyTemplate(tx: Tx, ctx: TemplateWriteContext, id: string, name: string): Promise<TemplateView> {
  await lockTemplate(tx, ctx, id);
  const source = (await loadTemplate(tx, ctx.tenantId, id))!;
  requireCreatable(ctx.scope, source.ownerOrgId);
  const plan = await copyPlan(tx, ctx, source);
  const [created] = await uniqueOr('TEMPLATE_DUPLICATE', '盘点模板', () =>
    tx
      .insert(T)
      .values({
        tenantId: ctx.tenantId,
        name,
        ownerOrgId: source.ownerOrgId,
        downwardPublic: source.downwardPublic,
        flowId: null,
        enabled: false,
        currentVersionNo: 1,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .returning({ id: T.id }),
  );
  await writeVersion(tx, ctx, created!.id, 1, plan);
  const after = (await loadTemplate(tx, ctx.tenantId, created!.id))!;
  await audit(tx, ctx, 'create', after.id, null, after);
  return after;
}

const structural = (patch: TemplatePatch, flowChanged: boolean) =>
  flowChanged ||
  patch.steps !== undefined ||
  patch.modules !== undefined ||
  patch.permissions !== undefined ||
  patch.stepForms !== undefined ||
  patch.resultRules !== undefined;

export async function updateTemplate(
  tx: Tx,
  ctx: TemplateWriteContext,
  id: string,
  patch: TemplatePatch,
): Promise<TemplateView> {
  const locked = await lockTemplate(tx, ctx, id);
  const before = (await loadTemplate(tx, ctx.tenantId, id))!;
  if (patch.ownerOrgId !== undefined && patch.ownerOrgId !== before.ownerOrgId) {
    requireCreatable(ctx.scope, patch.ownerOrgId);
    await requireOrg(tx, ctx.tenantId, patch.ownerOrgId);
  }
  const flowId = patch.flowId !== undefined ? patch.flowId : before.flowId;
  requireFlowWhenEnabled(patch.enabled ?? before.enabled, flowId);
  const flowChanged = flowId !== before.flowId;
  const isStructural = structural(patch, flowChanged);
  // 只改头部字段但原样带上流程时，引用的流程同样须当前可见（显式提交的引用每次都复核，与 B3 同口径）
  if (!isStructural && patch.flowId) {
    await checkTemplateReferences(tx, ctx, 'flow', [patch.flowId], new Set(before.flowId ? [before.flowId] : []));
  }
  const versionNo = isStructural ? before.currentVersionNo + 1 : before.currentVersionNo;
  if (isStructural) {
    const plan = await buildPlan(tx, ctx, { flowId: before.flowId, structure: before }, patch);
    await writeVersion(tx, ctx, id, versionNo, plan);
  }
  const {
    steps: _s,
    modules: _m,
    permissions: _p,
    flowId: _f,
    stepForms: _sf,
    resultRules: _rr,
    fieldCatalogVersion: _cv,
    ...header
  } = patch;
  await uniqueOr('TEMPLATE_DUPLICATE', '盘点模板', () =>
    tx
      .update(T)
      .set({
        ...header,
        flowId,
        currentVersionNo: versionNo,
        revision: locked.revision + 1,
        updatedBy: ctx.userId,
        updatedAt: ctx.now,
      })
      .where(and(eq(T.tenantId, ctx.tenantId), eq(T.id, id))),
  );
  const after = (await loadTemplate(tx, ctx.tenantId, id))!;
  await audit(tx, ctx, 'update', id, before, after);
  return after;
}

export async function deleteTemplate(tx: Tx, ctx: TemplateWriteContext, id: string): Promise<TemplateView> {
  await lockTemplate(tx, ctx, id);
  const before = (await loadTemplate(tx, ctx.tenantId, id))!;
  const referrer = await configReferrer(tx, ctx.tenantId, 'template', id);
  if (referrer) {
    throw new AppError('CONFLICT', '盘点模板已被引用，不能删除，可以停用', { reason: 'TEMPLATE_IN_USE', referrer });
  }
  await tx.delete(T).where(and(eq(T.tenantId, ctx.tenantId), eq(T.id, id)));
  await audit(tx, ctx, 'delete', id, before, null);
  return before;
}

/** 某个版本的视图；不存在 404（版本号越界与模板不存在同一个提示）。 */
export async function readTemplate(tx: Tx, tenantId: string, id: string, versionNo?: number) {
  const view = await loadTemplate(tx, tenantId, id, versionNo);
  if (!view) throw new AppError('NOT_FOUND', notFoundMessage('template'));
  return view;
}

// ---- 被模板引用拒删（外键 restrict 兜底；这里给出可读的 409 *_IN_USE 而不是 500）-------------------------------------

const exists = async (tx: Tx, query: Promise<unknown[]>) => (await query).length > 0;

// 流程被任一版本引用都不能删：头部的当前流程，以及换流程 / 清空流程之后旧版本冻结的流程
registerConfigReferenceGuard('flow', async (tx, tenantId, id) => {
  const header = tx
    .select({ id: T.id })
    .from(T)
    .where(and(eq(T.tenantId, tenantId), eq(T.flowId, id)))
    .limit(1);
  const versions = tx
    .select({ id: V.id })
    .from(V)
    .where(and(eq(V.tenantId, tenantId), eq(V.flowId, id)))
    .limit(1);
  return (await exists(tx, header)) || (await exists(tx, versions)) ? 'TEMPLATE' : null;
});
registerConfigReferenceGuard('role', async (tx, tenantId, id) => {
  const steps = tx
    .select({ id: SR.id })
    .from(SR)
    .where(and(eq(SR.tenantId, tenantId), eq(SR.roleId, id)))
    .limit(1);
  const seats = tx
    .select({ id: P.id })
    .from(P)
    .where(and(eq(P.tenantId, tenantId), eq(P.roleId, id)))
    .limit(1);
  return (await exists(tx, steps)) || (await exists(tx, seats)) ? 'TEMPLATE_STEP' : null;
});
registerConfigReferenceGuard('scoreRule', async (tx, tenantId, id) =>
  (await exists(
    tx,
    tx
      .select({ id: M.id })
      .from(M)
      .where(and(eq(M.tenantId, tenantId), eq(M.sourceScoreRuleId, id)))
      .limit(1),
  ))
    ? 'TEMPLATE_MODULE'
    : null,
);
registerConfigReferenceGuard('moduleGrade', async (tx, tenantId, id) =>
  (await exists(
    tx,
    tx
      .select({ id: M.id })
      .from(M)
      .where(and(eq(M.tenantId, tenantId), eq(M.sourceModuleGradeId, id)))
      .limit(1),
  ))
    ? 'TEMPLATE_MODULE'
    : null,
);
registerConfigReferenceGuard('field', async (tx, tenantId, id) =>
  (await exists(
    tx,
    tx
      .select({ id: MF.id })
      .from(MF)
      .where(and(eq(MF.tenantId, tenantId), eq(MF.fieldId, id)))
      .limit(1),
  ))
    ? 'TEMPLATE_MODULE'
    : null,
);
registerTalentCriterionReferenceGuard(async (tx, tenantId, id) =>
  (await exists(
    tx,
    tx
      .select({ id: M.id })
      .from(M)
      .where(and(eq(M.tenantId, tenantId), eq(M.criterionId, id)))
      .limit(1),
  ))
    ? 'TALENT_REVIEW_TEMPLATE'
    : null,
);
