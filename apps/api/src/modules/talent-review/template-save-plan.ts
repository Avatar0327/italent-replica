/**
 * 模板结构保存唯一入口（F-082 §3.4、设计 §2.3 / §4.3）：
 * 模板行（调用方已持有）→ 流程 → 角色 → 评价规则 → 模块等级 → 人才标准 → 来源表单 → 字段 F → 目录 V。
 * 每类来源 ID 去重排序一次；沿用来源同样先锁住。V 后只读复核和写新版本，外键涉及的旧来源均已持锁。
 */
import { randomUUID } from 'node:crypto';
import {
  and,
  asc,
  eq,
  inArray,
  talentCriteria,
  talentReviewFlows,
  talentReviewForms,
  talentReviewRoles,
  talentReviewScoreRules,
  talentReviewModuleGrades,
  type Tx,
} from '@italent/db';
import { AppError } from '../../errors.js';
import { loadFullCatalog, lockFields } from './calc-rule-catalog.js';
import { readFieldCatalogVersion, shareLockFieldCatalog } from './field-catalog.js';
import { FLOW } from './flow-service.js';
import type { ReferencedTable } from './reference-kit.js';
import { planStepForms, selectStepForms, type StepFormView } from './template-forms.js';
import type { TemplateCreate, TemplatePatch } from './template-input.js';
import { resultRulesPass, type ResultRuleView } from './template-results.js';
import {
  checkModuleFields,
  checkTemplateReferences,
  draftModules,
  planPermissions,
  planSteps,
  type Plan,
  type TemplateWriteContext,
} from './template-structure.js';
import type { ModuleView, Structure } from './template-view.js';

type Current = { flowId: string | null; structure: Structure } | null;
const sorted = (ids: readonly (string | null | undefined)[]) =>
  [...new Set(ids.filter((id): id is string => id !== null && id !== undefined))].sort();

async function lockSources(tx: Tx, tenantId: string, table: ReferencedTable, ids: readonly string[]) {
  if (!ids.length) return;
  await tx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.tenantId, tenantId), inArray(table.id, [...ids])))
    .orderBy(asc(table.id))
    .for('share');
}

/** 配置行在 F 之前取完；来源内容在共享锁内读取，之后的字段集合不会被源表单修改扩展。 */
async function lockConfiguration(
  tx: Tx,
  ctx: TemplateWriteContext,
  current: Current,
  input: TemplateCreate | TemplatePatch,
  flowId: string | null,
) {
  await lockSources(tx, ctx.tenantId, talentReviewFlows as ReferencedTable, sorted([flowId]));
  if (input.flowId) {
    await checkTemplateReferences(tx, ctx, 'flow', [input.flowId], new Set(sorted([current?.flowId])), false);
  }
  let roles: string[] = [];
  if (flowId) {
    if (flowId !== current?.flowId || !current) {
      roles = (await FLOW.load!(tx, ctx.tenantId, flowId))!.nodes.flatMap((node) => node.roleIds);
    } else {
      roles = current.structure.steps.flatMap((step) => step.roles.map((role) => role.roleId));
    }
  }
  await lockSources(tx, ctx.tenantId, talentReviewRoles as ReferencedTable, sorted(roles));
  const modules = input.modules ?? current?.structure.modules ?? [];
  for (const [table, ids] of [
    [talentReviewScoreRules, modules.map((m) => m.scoreRuleId)],
    [talentReviewModuleGrades, modules.map((m) => m.moduleGradeId)],
    [talentCriteria, modules.map((m) => m.criterionId)],
  ] as const) {
    await lockSources(tx, ctx.tenantId, table as ReferencedTable, sorted(ids));
  }
}

/** R 已取完。第一遍只收集最终 F 并集，按序一次取 F，再取 V；第二遍不准扩展锁集合。 */
async function prepareResults(
  tx: Tx,
  ctx: TemplateWriteContext,
  current: Current,
  input: TemplateCreate | TemplatePatch,
  modules: ModuleView[],
  stepForms: StepFormView[],
): Promise<ResultRuleView[]> {
  const pass = resultRulesPass(
    ctx,
    modules,
    current?.structure.modules ?? [],
    input.resultRules,
    current?.structure.resultRules ?? [],
    input.fieldCatalogVersion,
  );
  const first = pass(await loadFullCatalog(tx, ctx.tenantId), await readFieldCatalogVersion(tx, ctx.tenantId));
  const fields = sorted([
    ...modules.flatMap((m) => m.fieldIds),
    ...stepForms.flatMap((f) => f.formSnapshot.map((field) => field.fieldId)),
    ...first.flatMap((r) => [r.targetFieldId, ...r.refFieldIds]),
  ]);
  await lockFields(tx, ctx.tenantId, fields);
  const version = first.length ? await shareLockFieldCatalog(tx, ctx.tenantId) : 0;
  if (input.modules) await checkModuleFields(tx, ctx, input.modules, current?.structure.modules ?? []);
  const second = first.length ? pass(await loadFullCatalog(tx, ctx.tenantId), version) : [];
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new AppError('CONFLICT', '字段目录已变化，请刷新后重新编辑', { reason: 'CALC_FIELD_CHANGED' });
  }
  return second;
}

/** 收集来源 → 按序取锁 → 物化完整结构 → 整体校验；新建和全部结构 PATCH 都经此入口。 */
export async function buildPlan(
  tx: Tx,
  ctx: TemplateWriteContext,
  current: Current,
  input: TemplateCreate | TemplatePatch,
): Promise<Plan> {
  const flowId = input.flowId !== undefined ? input.flowId : (current?.flowId ?? null);
  await lockConfiguration(tx, ctx, current, input, flowId);
  const previous = current?.structure ?? null;
  const steps = await planSteps(tx, ctx.tenantId, flowId, flowId !== current?.flowId, previous, input.steps);
  const candidates = selectStepForms(steps, input.stepForms, previous?.stepForms ?? []);
  await lockSources(
    tx,
    ctx.tenantId,
    talentReviewForms as ReferencedTable,
    sorted(candidates.map((row) => row.formId)),
  );
  const drafts = input.modules
    ? await draftModules(tx, ctx, input.modules, previous?.modules ?? [])
    : (previous?.modules ?? []).map(({ id, ...draft }) => ({ ...draft, previousModuleId: id }));
  const modules = drafts.map((draft) => ({ ...draft, id: randomUUID() }));
  const stepForms = await planStepForms(tx, ctx, candidates, input.stepForms, previous?.stepForms ?? []);
  const resultRules = await prepareResults(tx, ctx, current, input, modules, stepForms);
  const permissions = planPermissions(steps, modules, input.permissions, {
    rows: previous?.permissions ?? [],
    modules: previous?.modules ?? [],
  });
  return { flowId, steps, modules, permissions, stepForms, resultRules };
}
