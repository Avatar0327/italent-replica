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
  talentReviewFields,
  talentReviewModuleGrades,
  talentReviewRoles,
  talentReviewScoreRules,
  type Tx,
} from '@italent/db';
import { checkByCount, checkModules, checkPermissions, type ModuleInput, type PermissionInput } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { ModuleScope } from './access.js';
import type { WriteContext } from './config-kit.js';
import { FLOW } from './flow-service.js';
import { MODULE_GRADE } from './module-grade-service.js';
import { checkReferences, type ReferencedTable } from './reference-kit.js';
import { SCORE_RULE } from './score-rule-service.js';
import type { ModuleBody, PermissionBody, TemplateCreate, TemplatePatch } from './template-input.js';
import type { ModuleView, PermissionView, Structure, StepView } from './template-view.js';

export type TemplateReference = 'flow' | 'scoreRule' | 'moduleGrade' | 'field';
export const TEMPLATE_REFERENCES: readonly TemplateReference[] = ['flow', 'scoreRule', 'moduleGrade', 'field'];

export interface TemplateWriteContext extends WriteContext {
  /** 被引用目录对象（流程 / 评价规则 / 模块等级 / 盘点字段）在命令事务内解析的当前范围；请求不引用的对象没有。 */
  readonly scopes: Partial<Record<TemplateReference, ModuleScope>>;
}

const SPECS = {
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
) {
  const spec = SPECS[kind];
  const scoped = { ...ctx, ...(ctx.scopes[kind] ? { referenceScope: ctx.scopes[kind] } : {}) };
  return checkReferences(tx, scoped, { ...spec, table: spec.table as unknown as ReferencedTable }, ids, held);
}

const invalid = (reason: string, message: string) => new AppError('VALIDATION_FAILED', message, { reason });
const unique = <T>(values: readonly (T | null | undefined)[]): T[] => [
  ...new Set(values.filter((value): value is T => value != null)),
];

type ModuleDraft = Omit<ModuleView, 'id'>;
export interface Plan {
  readonly flowId: string | null;
  readonly steps: StepView[];
  readonly modules: ModuleDraft[];
  readonly permissions: PermissionView[];
}

/** 当前版本已持有的引用：停用后仍原样保留可改，只有新增的引用才要求启用。 */
function heldOf(modules: readonly ModuleDraft[]) {
  return {
    rules: new Set(unique(modules.map((m) => m.scoreRuleId))),
    grades: new Set(unique(modules.map((m) => m.moduleGradeId))),
    fields: new Set(modules.flatMap((m) => m.fieldIds)),
    criteria: new Set(unique(modules.map((m) => m.criterionId))),
  };
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

async function planSteps(
  tx: Tx,
  tenantId: string,
  flowId: string | null,
  flowChanged: boolean,
  previous: Structure | null,
  submitted: TemplatePatch['steps'],
): Promise<StepView[]> {
  const frozen = !flowId ? [] : flowChanged || !previous ? await freezeSteps(tx, tenantId, flowId) : previous.steps;
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

/** 指定人才标准：新增的引用须存在且已启用（行加 FOR KEY SHARE，与人才标准删除互斥）；已持有的原样保留。 */
async function checkCriteria(tx: Tx, tenantId: string, modules: readonly ModuleBody[], held: ReadonlySet<string>) {
  for (const id of unique(modules.map((module) => module.criterionId)).filter((criterion) => !held.has(criterion))) {
    const [found] = await tx
      .select({ enabled: talentCriteria.enabled })
      .from(talentCriteria)
      .where(and(eq(talentCriteria.tenantId, tenantId), eq(talentCriteria.id, id)))
      .for('key share');
    if (!found?.enabled) throw invalid('CRITERION_NOT_REFERENCEABLE', '人才标准不存在或已停用，不能引用');
  }
}

/** 提交的模块 → 新版本的模块（评价规则 / 模块等级整份快照）。 */
async function draftModules(
  tx: Tx,
  ctx: TemplateWriteContext,
  bodies: readonly ModuleBody[],
  previous: readonly ModuleDraft[],
): Promise<ModuleDraft[]> {
  const problem = checkModules(bodies.map(asInput));
  if (problem) throw invalid(problem.reason, problem.message);
  const held = heldOf(previous);
  await checkTemplateReferences(tx, ctx, 'scoreRule', unique(bodies.map((m) => m.scoreRuleId)), held.rules);
  await checkTemplateReferences(tx, ctx, 'moduleGrade', unique(bodies.map((m) => m.moduleGradeId)), held.grades);
  await checkTemplateReferences(
    tx,
    ctx,
    'field',
    bodies.flatMap((m) => m.fieldIds ?? []),
    held.fields,
  );
  await checkCriteria(tx, ctx.tenantId, bodies, held.criteria);
  const drafts: ModuleDraft[] = [];
  for (const body of bodies) {
    const rule = body.scoreRuleId ? (await SCORE_RULE.load!(tx, ctx.tenantId, body.scoreRuleId))! : null;
    const grade = body.moduleGradeId ? (await MODULE_GRADE.load!(tx, ctx.tenantId, body.moduleGradeId))! : null;
    if (body.scoring === 'by_count') {
      const countProblem = checkByCount(rule!, grade);
      if (countProblem) throw invalid(countProblem.reason, countProblem.message);
    } else if (grade?.mode === 'count') {
      throw invalid('MODULE_GRADE_MODE', '只有按指标数目算分才能选按指标数目的模块等级');
    }
    drafts.push(moduleDraft(body, rule, grade));
  }
  return drafts;
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
function planPermissions(
  steps: readonly StepView[],
  modules: readonly ModuleDraft[],
  submitted: readonly PermissionBody[] | undefined,
  previous: readonly PermissionView[],
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
    for (const row of previous) given.set(seatKey(row), row);
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
  return rows;
}

/** 合并请求与当前版本，得到新版本的全部内容（只读库、不写）。 */
export async function buildPlan(
  tx: Tx,
  ctx: TemplateWriteContext,
  current: { flowId: string | null; structure: Structure } | null,
  input: TemplateCreate | TemplatePatch,
): Promise<Plan> {
  const flowId = input.flowId !== undefined ? input.flowId : (current?.flowId ?? null);
  const flowChanged = flowId !== (current?.flowId ?? null);
  // 请求里显式提交的流程（含原样带上的当前流程）都须当前操作人可见；停用的流程只在原样保留时豁免
  if (input.flowId) {
    const held = new Set(current?.flowId ? [current.flowId] : []);
    await checkTemplateReferences(tx, ctx, 'flow', [input.flowId], held);
  }
  const previous = current?.structure ?? null;
  const steps = await planSteps(tx, ctx.tenantId, flowId, flowChanged, previous, input.steps);
  const modules = input.modules
    ? await draftModules(tx, ctx, input.modules, previous?.modules ?? [])
    : (previous?.modules ?? []).map(({ id: _id, ...draft }) => draft);
  const permissions = planPermissions(steps, modules, input.permissions, previous?.permissions ?? []);
  return { flowId, steps, modules, permissions };
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
}

async function writeModules(tx: Tx, tenantId: string, versionId: string, modules: readonly ModuleDraft[]) {
  const rows = modules.length
    ? await tx
        .insert(M)
        .values(
          modules.map((module, index) => ({
            tenantId,
            versionId,
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
