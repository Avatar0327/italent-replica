/**
 * 盘点模板结构的编排与落库（设计 §2.3、§13 第 4 条）：把请求里的 steps / modules / permissions 与当前版本合并成新版本的内容，
 * 先全部校验再写入（任何一步拒绝都在写入之前，命令事务整体回滚）。
 * - 步骤：流程换了才重新冻结节点副本（含角色 resolver），按 node_key 保留 show_matrix；流程不变沿用当前版本的副本；
 * - 模块：提交了就按提交整份重建并重新快照评价规则 / 模块等级；没提交原样沿用（含当时的快照）；
 * - 权限：步骤 × 角色 × 模块的席位由服务端物化——提交了就以提交行为准、未提交的席位取缺省；没提交整组则沿用当前版本同席位的行。
 */
import {
  and,
  eq,
  inArray,
  talentCriteria,
  talentReviewTemplateModuleFields as MF,
  talentReviewTemplateModuleLevels as ML,
  talentReviewTemplateModules as M,
  talentReviewTemplateStepModulePermissions as P,
  talentReviewTemplateStepRoles as SR,
  talentReviewTemplateSteps as S,
  talentReviewTemplateVersions as V,
  talentReviewFlows,
  talentReviewForms,
  talentReviewFields,
  talentReviewModuleGrades,
  talentReviewRoles,
  talentReviewScoreRules,
  type Tx,
} from '@italent/db';
import {
  checkByCount,
  checkFinalPermissions,
  checkModules,
  checkPermissions,
  type ModuleInput,
  type PermissionInput,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import type { ModuleScope } from './access.js';
import type { WriteContext } from './config-kit.js';
import { FLOW } from './flow-service.js';
import { MODULE_GRADE } from './module-grade-service.js';
import { checkReferences, type ReferencedTable } from './reference-kit.js';
import { SCORE_RULE } from './score-rule-service.js';
import type { ModuleBody, PermissionBody, TemplatePatch } from './template-input.js';
import type { ModuleView, PermissionView, Structure, StepView } from './template-view.js';

export type TemplateReference = 'flow' | 'scoreRule' | 'moduleGrade' | 'field' | 'form';
export const TEMPLATE_REFERENCES: readonly TemplateReference[] = ['flow', 'scoreRule', 'moduleGrade', 'field', 'form'];

import type { StepFormView } from './template-forms.js';
import type { ResultRuleView } from './template-results.js';
export { buildPlan } from './template-save-plan.js';
import { writeTemplateExtras } from './template-extra-store.js';
import type { CatalogAccess } from './calc-rule-catalog.js';

export interface TemplateWriteContext extends WriteContext {
  readonly fieldAccess?: CatalogAccess | undefined;
  /** 被引用目录对象（流程 / 评价规则 / 模块等级 / 盘点字段）在命令事务内解析的当前范围；请求不引用的对象没有。 */
  readonly scopes: Partial<Record<TemplateReference, ModuleScope>>;
}

const SPECS = {
  form: { table: talentReviewForms, object: 'form', disabledReason: 'TEMPLATE_FORM_DISABLED', label: '盘点表单' },
  flow: { table: talentReviewFlows, object: 'flow', disabledReason: 'TEMPLATE_FLOW_DISABLED', label: '盘点流程' },
  scoreRule: {
    table: talentReviewScoreRules,
    object: 'scoreRule',
    disabledReason: 'MODULE_RULE_DISABLED',
    label: '评价规则',
  },
  moduleGrade: {
    table: talentReviewModuleGrades,
    object: 'moduleGrade',
    disabledReason: 'MODULE_GRADE_DISABLED',
    label: '模块等级',
  },
  field: { table: talentReviewFields, object: 'field', disabledReason: 'MODULE_FIELD_DISABLED', label: '盘点字段' },
} as const;

/** 对一类被引用对象做存在 / 可见 / 启用复核（行加 FOR KEY SHARE，与被引用对象的删除互斥）。 */
export function checkTemplateReferences(
  tx: Tx,
  ctx: TemplateWriteContext,
  kind: TemplateReference,
  ids: readonly string[],
  held: ReadonlySet<string>,
  lock = true,
) {
  const spec = SPECS[kind];
  const scoped = { ...ctx, ...(ctx.scopes[kind] ? { referenceScope: ctx.scopes[kind] } : {}) };
  return checkReferences(tx, scoped, { ...spec, table: spec.table as unknown as ReferencedTable }, ids, held, lock);
}

const invalid = (reason: string, message: string) => new AppError('VALIDATION_FAILED', message, { reason });
const unique = <T>(values: readonly (T | null | undefined)[]): T[] => [
  ...new Set(values.filter((value): value is T => value != null)),
];

type ModuleDraft = Omit<ModuleView, 'id'>;
export interface Plan {
  readonly stepForms: StepFormView[];
  readonly resultRules: ResultRuleView[];
  readonly flowId: string | null;
  readonly steps: StepView[];
  readonly modules: ModuleView[];
  readonly permissions: PermissionView[];
}

/** 版本内冻结流程节点副本；角色 resolver 取自盘点角色当前值。 */
async function freezeSteps(tx: Tx, tenantId: string, flowId: string): Promise<StepView[]> {
  const flow = (await FLOW.load!(tx, tenantId, flowId))!;
  const roleIds = unique(flow.nodes.flatMap((node) => node.roleIds));
  const roles = roleIds.length
    ? await tx
        .select({ id: talentReviewRoles.id, resolver: talentReviewRoles.resolver })
        .from(talentReviewRoles)
        .where(and(eq(talentReviewRoles.tenantId, tenantId), inArray(talentReviewRoles.id, roleIds)))
    : [];
  const resolver = new Map(roles.map((role) => [role.id, role.resolver]));
  return flow.nodes.map((node) => ({
    nodeKey: node.nodeKey,
    name: node.name,
    kind: node.kind as StepView['kind'],
    stepType: node.stepType,
    mode: node.mode,
    showMatrix: false,
    allowReturn: node.allowReturn,
    allowTransfer: node.allowTransfer,
    allowDisagree: node.allowDisagree,
    roles: node.roleIds.map((roleId) => ({ roleId, resolver: resolver.get(roleId)! })),
  }));
}

export async function planSteps(
  tx: Tx,
  tenantId: string,
  flowId: string | null,
  flowChanged: boolean,
  previous: Structure | null,
  submitted: TemplatePatch['steps'],
): Promise<StepView[]> {
  // 流程换了（或还没有版本）才重新冻结节点副本；同一流程沿用当前版本的副本，流程之后的修改不影响已保存版本
  let frozen: StepView[] = [];
  if (flowId) frozen = flowChanged || !previous ? await freezeSteps(tx, tenantId, flowId) : previous.steps;
  const matrix = new Map(previous?.steps.map((step) => [step.nodeKey, step.showMatrix]));
  const requested = new Map<string, boolean>();
  for (const step of submitted ?? []) {
    if (requested.has(step.nodeKey)) throw invalid('TEMPLATE_STEP_DUPLICATE', `步骤 ${step.nodeKey} 重复`);
    if (!frozen.some((item) => item.nodeKey === step.nodeKey)) {
      throw invalid('TEMPLATE_STEP_UNKNOWN', `步骤 ${step.nodeKey} 不在所选流程里`);
    }
    requested.set(step.nodeKey, step.showMatrix);
  }
  return frozen.map((step) => ({
    ...step,
    showMatrix: requested.get(step.nodeKey) ?? matrix.get(step.nodeKey) ?? false,
  }));
}

const asInput = (module: ModuleBody): ModuleInput => module;

/**
 * 提交的模块里带的 `id` = 上一版本（当前版本）的模块 ID：带了就是同一模块（改名不丢身份）；ID 不存在 / 不属于上一版本 /
 * 重复 → 400。返回与 bodies 逐项对应的上一版本模块（没带 ID 的是新模块 → undefined）。
 */
function matchPrevious(bodies: readonly ModuleBody[], previous: readonly ModuleView[]): (ModuleView | undefined)[] {
  const byId = new Map(previous.map((module) => [module.id, module]));
  const seen = new Set<string>();
  return bodies.map((body) => {
    if (body.id === undefined) return undefined;
    if (seen.has(body.id)) throw invalid('MODULE_ID_DUPLICATE', `模块标识 ${body.id} 重复`);
    seen.add(body.id);
    const found = byId.get(body.id);
    if (!found) throw invalid('MODULE_ID_UNKNOWN', '模块标识不属于上一版本，不能沿用');
    return found;
  });
}

/**
 * 某类引用的全部 id 与“原样保留”集合（按模块判断，与流程节点 × 角色同口径，DEC-425②）：只有原模块继续持有的引用才豁免启用检查；
 * 挪到另一模块 / 新模块的同一个 id 算新引用——同一个 id 只要在任一处是新引用，就不在豁免集合里。
 */
function referencesOf(
  bodies: readonly ModuleBody[],
  before: readonly (ModuleView | undefined)[],
  pick: (body: ModuleBody) => readonly (string | null | undefined)[],
  kept: (module: ModuleView) => readonly (string | null)[],
) {
  const ids = new Set<string>();
  const fresh = new Set<string>();
  bodies.forEach((body, index) => {
    const own = new Set(before[index] ? kept(before[index]) : []);
    for (const id of pick(body)) {
      if (!id) continue;
      ids.add(id);
      if (!own.has(id)) fresh.add(id);
    }
  });
  return { ids: [...ids], held: new Set([...ids].filter((id) => !fresh.has(id))) };
}

/** 指定人才标准：调用方已持来源锁，新增引用须存在且启用；原模块继续持有的原样保留。 */
async function checkCriteria(tx: Tx, tenantId: string, refs: { ids: string[]; held: ReadonlySet<string> }) {
  for (const id of refs.ids.filter((criterion) => !refs.held.has(criterion))) {
    const [found] = await tx
      .select({ enabled: talentCriteria.enabled })
      .from(talentCriteria)
      .where(and(eq(talentCriteria.tenantId, tenantId), eq(talentCriteria.id, id)));
    if (!found?.enabled) throw invalid('CRITERION_NOT_REFERENCEABLE', '人才标准不存在或已停用，不能引用');
  }
}

/** 提交的模块 → 新版本的模块（评价规则 / 模块等级整份快照；带上一版本模块 ID 且引用未变的沿用原快照）。 */
export async function draftModules(
  tx: Tx,
  ctx: TemplateWriteContext,
  bodies: readonly ModuleBody[],
  previous: readonly ModuleView[],
): Promise<ModuleDraft[]> {
  const before = matchPrevious(bodies, previous);
  const problem = checkModules(bodies.map(asInput));
  if (problem) throw invalid(problem.reason, problem.message);
  const rules = referencesOf(
    bodies,
    before,
    (m) => [m.scoreRuleId],
    (m) => [m.scoreRuleId],
  );
  const grades = referencesOf(
    bodies,
    before,
    (m) => [m.moduleGradeId],
    (m) => [m.moduleGradeId],
  );
  const fields = referencesOf(
    bodies,
    before,
    (m) => m.fieldIds ?? [],
    (m) => m.fieldIds,
  );
  const criteria = referencesOf(
    bodies,
    before,
    (m) => [m.criterionId],
    (m) => [m.criterionId],
  );
  await checkTemplateReferences(tx, ctx, 'scoreRule', rules.ids, rules.held, false);
  await checkTemplateReferences(tx, ctx, 'moduleGrade', grades.ids, grades.held, false);
  await checkTemplateReferences(tx, ctx, 'field', fields.ids, fields.held, false);
  await checkCriteria(tx, ctx.tenantId, criteria);
  const drafts: ModuleDraft[] = [];
  for (const [index, body] of bodies.entries()) {
    const rule = body.scoreRuleId ? (await SCORE_RULE.load!(tx, ctx.tenantId, body.scoreRuleId))! : null;
    const grade = body.moduleGradeId ? (await MODULE_GRADE.load!(tx, ctx.tenantId, body.moduleGradeId))! : null;
    const draft = withIdentity(moduleDraft(body, rule, grade), before[index]);
    checkScoringAgainstSnapshots(draft);
    drafts.push(draft);
  }
  return drafts;
}

/** 在统一字段锁内复核显式模块字段；新引用不能借旧模块绕过停用校验（DEC-425②）。 */
export async function checkModuleFields(
  tx: Tx,
  ctx: TemplateWriteContext,
  bodies: readonly ModuleBody[],
  previous: readonly ModuleView[],
) {
  const fields = referencesOf(
    bodies,
    matchPrevious(bodies, previous),
    (m) => m.fieldIds ?? [],
    (m) => m.fieldIds,
  );
  await checkTemplateReferences(tx, ctx, 'field', fields.ids, fields.held, false);
}

/**
 * 同一模块（带了上一版本的 ID）：记映射 previousModuleId；引用没换且计分方式没变就沿用原快照，改名不改变已冻结的规则内容。
 * 计分方式换了（如加权求和 ↔ 按指标数目）要的是新口径，改取实时快照，再由 checkScoringAgainstSnapshots 校验。
 */
function withIdentity(draft: ModuleDraft, before: ModuleView | undefined): ModuleDraft {
  if (!before) return draft;
  const sameScoring = before.scoring === draft.scoring;
  const rule = sameScoring && before.scoreRuleId === draft.scoreRuleId && before.ruleSnapshot;
  const grade = sameScoring && before.moduleGradeId === draft.moduleGradeId && before.gradeSnapshot;
  return {
    ...draft,
    previousModuleId: before.id,
    ruleSnapshot: rule || draft.ruleSnapshot,
    gradeSnapshot: grade || draft.gradeSnapshot,
  };
}

/** 模块等级快照的口径：等级项带 minCount 为按指标数目，否则得分区间（同 module-grade-service 的 mode 派生）。 */
const snapshotMode = (snapshot: NonNullable<ModuleDraft['gradeSnapshot']>) =>
  snapshot.items[0]?.minCount != null ? 'count' : 'score';

/** 计分方式与**最终保存的快照**一致（不看源对象的实时口径——沿用旧快照时实时口径可能已变，TR-R15）。 */
function checkScoringAgainstSnapshots(draft: ModuleDraft): void {
  if (draft.kind !== 'indicator') return;
  const grade = draft.gradeSnapshot ? { mode: snapshotMode(draft.gradeSnapshot) } : null;
  if (draft.scoring === 'by_count') {
    const problem = checkByCount(draft.ruleSnapshot ?? { kind: 'numeric' }, grade);
    if (problem) throw invalid(problem.reason, problem.message);
  } else if (grade?.mode === 'count') {
    throw invalid('MODULE_GRADE_MODE', '只有按指标数目算分才能选按指标数目的模块等级');
  }
}

function moduleDraft(
  body: ModuleBody,
  rule: Awaited<ReturnType<NonNullable<typeof SCORE_RULE.load>>> | null,
  grade: Awaited<ReturnType<NonNullable<typeof MODULE_GRADE.load>>> | null,
): ModuleDraft {
  const succession = body.kind === 'succession';
  return {
    kind: body.kind,
    name: body.name,
    source: body.source ?? null,
    criterionMode: body.criterionMode ?? null,
    criterionId: body.criterionId ?? null,
    dimensionTypes: body.dimensionTypes?.length ? [...body.dimensionTypes] : null,
    scoring: body.scoring ?? null,
    scoreRuleId: body.scoreRuleId ?? null,
    moduleGradeId: body.moduleGradeId ?? null,
    ruleSnapshot: rule
      ? {
          kind: rule.kind,
          min: rule.minScore,
          max: rule.maxScore,
          display: rule.display,
          allowUnable: rule.allowUnable,
          levels: rule.levels.map((level) => ({ name: level.name, value: level.value })),
        }
      : null,
    gradeSnapshot: grade
      ? {
          items: grade.items.map((item) => ({
            name: item.name,
            value: item.value,
            minScore: item.minScore,
            maxScore: item.maxScore,
            minCount: item.minCount,
          })),
        }
      : null,
    fieldIds: body.fieldIds ?? [],
    previousModuleId: null,
    allowOrg: succession ? (body.allowOrg ?? true) : null,
    allowPosition: succession ? (body.allowPosition ?? true) : null,
    allowTarget: succession ? (body.allowTarget ?? true) : null,
  };
}

const seatKey = (row: { nodeKey: string; roleId?: string | null; moduleName: string }) =>
  `${row.nodeKey}|${row.roleId ?? ''}|${row.moduleName}`;

function defaultPermission(kind: ModuleDraft['kind']): Omit<PermissionView, 'nodeKey' | 'roleId' | 'moduleName'> {
  const succession = kind === 'succession';
  return {
    visible: true,
    scoreEnabled: !succession,
    scoreRequired: false,
    commentEnabled: !succession,
    commentRequired: false,
    weight: null,
    successorAccess: succession ? 'hidden' : null,
    targetAccess: succession ? 'hidden' : null,
  };
}

/** 物化席位：步骤（单人一个、会签每个角色一个）× 非信息模块；提交行覆盖缺省，未提交整组时沿用当前版本同席位的行。 */
export function planPermissions(
  steps: readonly StepView[],
  modules: readonly ModuleDraft[],
  submitted: readonly PermissionBody[] | undefined,
  previous: { readonly rows: readonly PermissionView[]; readonly modules: readonly ModuleView[] },
): PermissionView[] {
  const problem = checkPermissions(
    steps.map((step) => ({ nodeKey: step.nodeKey, kind: step.kind, roleIds: step.roles.map((role) => role.roleId) })),
    modules,
    (submitted ?? []) as PermissionInput[],
  );
  if (problem) throw invalid(problem.reason, problem.message);
  const given = new Map<string, Partial<PermissionView>>();
  if (submitted) {
    for (const row of submitted) {
      const { roleId, weight, successorAccess, targetAccess, ...flags } = row;
      const defined = Object.fromEntries(Object.entries(flags).filter(([, value]) => value !== undefined));
      given.set(seatKey(row), {
        ...defined,
        ...(weight !== undefined ? { weight } : {}),
        ...(successorAccess != null ? { successorAccess } : {}),
        ...(targetAccess != null ? { targetAccess } : {}),
        roleId: roleId ?? null,
      } as Partial<PermissionView>);
    }
  } else {
    // 沿用同一模块（previousModuleId 指向的旧模块，改名后按新名称）同席位的旧行；不带 ID 的新模块不继承；
    // 模块类型变了（指标 ↔ 继任）旧行里的设置对新类型不适用，整行丢弃取缺省
    const successor = new Map<string, ModuleDraft>();
    for (const module of modules) {
      const old = previous.modules.find((item) => item.id === module.previousModuleId);
      if (old && old.kind === module.kind) successor.set(old.name, module);
    }
    for (const row of previous.rows) {
      const next = successor.get(row.moduleName);
      if (next) given.set(seatKey({ ...row, moduleName: next.name }), { ...row, moduleName: next.name });
    }
  }
  const rows: PermissionView[] = [];
  for (const step of steps) {
    const seatRoles = step.kind === 'countersign' ? step.roles.map((role) => role.roleId) : [null];
    for (const roleId of seatRoles) {
      for (const module of modules.filter((item) => item.kind !== 'info')) {
        const key = { nodeKey: step.nodeKey, roleId, moduleName: module.name };
        rows.push({ ...defaultPermission(module.kind), ...given.get(seatKey(key)), ...key } as PermissionView);
      }
    }
  }
  // 最终完整结构整体再校验一遍（继承 / 缺省物化出来的行也不能是读回后会被自己拒绝的状态）
  const final = checkFinalPermissions(modules, rows);
  if (final) throw invalid(final.reason, final.message);
  return rows;
}

const sortNo = (index: number) => index + 1;

/** 写入新版本的全部结构行。 */
export async function writeVersion(
  tx: Tx,
  ctx: TemplateWriteContext,
  templateId: string,
  versionNo: number,
  plan: Plan,
): Promise<void> {
  const tenantId = ctx.tenantId;
  const [version] = await tx
    .insert(V)
    .values({ tenantId, templateId, versionNo, flowId: plan.flowId, createdBy: ctx.userId, createdAt: ctx.now })
    .returning({ id: V.id });
  const versionId = version!.id;
  const stepRows = plan.steps.length
    ? await tx
        .insert(S)
        .values(
          plan.steps.map(({ roles: _roles, ...step }, index) => ({
            tenantId,
            versionId,
            ...step,
            sortNo: sortNo(index),
          })),
        )
        .returning({ id: S.id, nodeKey: S.nodeKey })
    : [];
  const stepId = new Map(stepRows.map((row) => [row.nodeKey, row.id]));
  const roleRows = plan.steps.flatMap((step) =>
    step.roles.map((role, index) => ({
      tenantId,
      stepId: stepId.get(step.nodeKey)!,
      roleId: role.roleId,
      resolver: role.resolver,
      sortNo: sortNo(index),
    })),
  );
  if (roleRows.length) await tx.insert(SR).values(roleRows);
  const moduleId = await writeModules(tx, tenantId, versionId, plan.modules);
  const permissionRows = plan.permissions.map(({ nodeKey, moduleName, ...row }) => ({
    tenantId,
    stepId: stepId.get(nodeKey)!,
    moduleId: moduleId.get(moduleName)!,
    ...row,
  }));
  if (permissionRows.length) await tx.insert(P).values(permissionRows);
  await writeTemplateExtras(tx, tenantId, versionId, stepId, plan.stepForms, plan.resultRules);
}

async function writeModules(tx: Tx, tenantId: string, versionId: string, modules: readonly ModuleView[]) {
  const rows = modules.length
    ? await tx
        .insert(M)
        .values(
          modules.map((module, index) => ({
            tenantId,
            versionId,
            id: module.id,
            kind: module.kind,
            name: module.name,
            sortNo: sortNo(index),
            source: module.source,
            criterionMode: module.criterionMode,
            criterionId: module.criterionId,
            dimensionTypes: module.dimensionTypes,
            scoring: module.scoring,
            ruleKind: module.ruleSnapshot?.kind ?? null,
            ruleMin: module.ruleSnapshot?.min ?? null,
            ruleMax: module.ruleSnapshot?.max ?? null,
            ruleDisplay: module.ruleSnapshot?.display ?? null,
            ruleAllowUnable: module.ruleSnapshot?.allowUnable ?? null,
            sourceScoreRuleId: module.scoreRuleId,
            sourceModuleGradeId: module.moduleGradeId,
            allowOrg: module.allowOrg,
            allowPosition: module.allowPosition,
            allowTarget: module.allowTarget,
            previousModuleId: module.previousModuleId,
          })),
        )
        .returning({ id: M.id, name: M.name })
    : [];
  const idOf = new Map(rows.map((row) => [row.name, row.id]));
  const levels = modules.flatMap((module) => {
    const moduleId = idOf.get(module.name)!;
    return [
      ...(module.ruleSnapshot?.levels ?? []).map((level, index) => ({
        tenantId,
        moduleId,
        source: 'rule',
        name: level.name,
        value: String(level.value),
        sortNo: sortNo(index),
      })),
      ...(module.gradeSnapshot?.items ?? []).map((item, index) => ({
        tenantId,
        moduleId,
        source: 'grade',
        sortNo: sortNo(index),
        ...item,
      })),
    ];
  });
  if (levels.length) await tx.insert(ML).values(levels);
  const fields = modules.flatMap((module) =>
    module.fieldIds.map((fieldId, index) => ({
      tenantId,
      moduleId: idOf.get(module.name)!,
      fieldId,
      sortNo: sortNo(index),
    })),
  );
  if (fields.length) await tx.insert(MF).values(fields);
  return idOf;
}
