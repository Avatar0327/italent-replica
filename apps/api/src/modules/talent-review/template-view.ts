/**
 * 盘点模板的读取（设计 §2.3）：头部 + 某个版本的结构（步骤、模块、权限）。结构读回的是版本保存时冻结的内容——步骤是流程节点的副本，
 * 模块带评价规则 / 模块等级的整份快照——之后修改流程 / 规则 / 模块等级不影响已保存的版本（TR-R20、AC-TR-15）。
 */
import {
  and,
  asc,
  eq,
  inArray,
  talentReviewTemplateModuleFields as MF,
  talentReviewTemplateModuleLevels as ML,
  talentReviewTemplateModules as M,
  talentReviewTemplateStepModulePermissions as P,
  talentReviewTemplateStepRoles as SR,
  talentReviewTemplates as T,
  talentReviewTemplateSteps as S,
  talentReviewTemplateVersions as V,
  type Tx,
} from '@italent/db';
import { weightConfigErrors, type ConfigError } from '@italent/domain';

export const headerColumns = {
  id: T.id,
  name: T.name,
  ownerOrgId: T.ownerOrgId,
  downwardPublic: T.downwardPublic,
  flowId: T.flowId,
  enabled: T.enabled,
  currentVersionNo: T.currentVersionNo,
  revision: T.revision,
  createdBy: T.createdBy,
  createdAt: T.createdAt,
  updatedBy: T.updatedBy,
  updatedAt: T.updatedAt,
};
export type TemplateHeader = { [K in keyof typeof headerColumns]: (typeof T.$inferSelect)[K] };

export interface StepView {
  nodeKey: string;
  name: string;
  kind: 'single' | 'countersign';
  stepType: string;
  mode: string;
  showMatrix: boolean;
  allowReturn: boolean;
  allowTransfer: boolean;
  allowDisagree: boolean;
  roles: { roleId: string; resolver: string }[];
}
export interface ModuleView {
  id: string;
  kind: 'indicator' | 'info' | 'succession';
  name: string;
  source: string | null;
  criterionMode: string | null;
  criterionId: string | null;
  dimensionTypes: string[] | null;
  scoring: string | null;
  scoreRuleId: string | null;
  moduleGradeId: string | null;
  ruleSnapshot: {
    kind: string;
    min: number | null;
    max: number | null;
    display: string | null;
    allowUnable: boolean;
    levels: { name: string; value: number }[];
  } | null;
  gradeSnapshot: {
    items: {
      name: string;
      value: string;
      minScore: number | null;
      maxScore: number | null;
      minCount: number | null;
    }[];
  } | null;
  fieldIds: string[];
  allowOrg: boolean | null;
  allowPosition: boolean | null;
  allowTarget: boolean | null;
}
export interface PermissionView {
  nodeKey: string;
  roleId: string | null;
  moduleName: string;
  visible: boolean;
  scoreEnabled: boolean;
  scoreRequired: boolean;
  commentEnabled: boolean;
  commentRequired: boolean;
  weight: number | null;
  successorAccess: string | null;
  targetAccess: string | null;
}
export interface Structure {
  versionId: string;
  versionNo: number;
  steps: StepView[];
  modules: ModuleView[];
  permissions: PermissionView[];
}
export type TemplateView = TemplateHeader &
  Structure & {
    configErrors: ConfigError[];
    versions: { versionNo: number; createdBy: string; createdAt: Date }[];
  };

export const headerOf = async (tx: Tx, tenantId: string, id: string): Promise<TemplateHeader | undefined> =>
  (
    await tx
      .select(headerColumns)
      .from(T)
      .where(and(eq(T.tenantId, tenantId), eq(T.id, id)))
  )[0];

const ids = <R extends { id: string }>(rows: R[]) => rows.map((row) => row.id);

/** 某个版本的结构；版本不存在返回 undefined。 */
export async function loadStructure(
  tx: Tx,
  tenantId: string,
  templateId: string,
  versionNo: number,
): Promise<Structure | undefined> {
  const [version] = await tx
    .select({ id: V.id })
    .from(V)
    .where(and(eq(V.tenantId, tenantId), eq(V.templateId, templateId), eq(V.versionNo, versionNo)));
  if (!version) return undefined;
  const steps = await tx
    .select()
    .from(S)
    .where(and(eq(S.tenantId, tenantId), eq(S.versionId, version.id)))
    .orderBy(asc(S.sortNo));
  const modules = await tx
    .select()
    .from(M)
    .where(and(eq(M.tenantId, tenantId), eq(M.versionId, version.id)))
    .orderBy(asc(M.sortNo));
  const roles = steps.length
    ? await tx
        .select()
        .from(SR)
        .where(and(eq(SR.tenantId, tenantId), inArray(SR.stepId, ids(steps))))
        .orderBy(asc(SR.sortNo))
    : [];
  const permissions = steps.length
    ? await tx
        .select()
        .from(P)
        .where(and(eq(P.tenantId, tenantId), inArray(P.stepId, ids(steps))))
    : [];
  const levels = modules.length
    ? await tx
        .select()
        .from(ML)
        .where(and(eq(ML.tenantId, tenantId), inArray(ML.moduleId, ids(modules))))
        .orderBy(asc(ML.sortNo))
    : [];
  const fields = modules.length
    ? await tx
        .select()
        .from(MF)
        .where(and(eq(MF.tenantId, tenantId), inArray(MF.moduleId, ids(modules))))
        .orderBy(asc(MF.sortNo))
    : [];
  const stepOf = new Map(steps.map((step) => [step.id, step]));
  const moduleOf = new Map(modules.map((module) => [module.id, module]));
  const stepOrder = new Map(steps.map((step, index) => [step.id, index]));
  const moduleOrder = new Map(modules.map((module, index) => [module.id, index]));
  const roleOrder = (id: string | null, stepId: string) =>
    roles.findIndex((role) => role.stepId === stepId && role.roleId === id);
  return {
    versionId: version.id,
    versionNo,
    steps: steps.map((step) => ({
      nodeKey: step.nodeKey,
      name: step.name,
      kind: step.kind as StepView['kind'],
      stepType: step.stepType,
      mode: step.mode,
      showMatrix: step.showMatrix,
      allowReturn: step.allowReturn,
      allowTransfer: step.allowTransfer,
      allowDisagree: step.allowDisagree,
      roles: roles
        .filter((role) => role.stepId === step.id)
        .map((role) => ({ roleId: role.roleId, resolver: role.resolver })),
    })),
    modules: modules.map((module) => moduleView(module, levels, fields)),
    permissions: permissions
      .map((row) => ({ row, step: stepOf.get(row.stepId)!, module: moduleOf.get(row.moduleId)! }))
      .sort(
        (a, b) =>
          stepOrder.get(a.row.stepId)! - stepOrder.get(b.row.stepId)! ||
          roleOrder(a.row.roleId, a.row.stepId) - roleOrder(b.row.roleId, b.row.stepId) ||
          moduleOrder.get(a.row.moduleId)! - moduleOrder.get(b.row.moduleId)!,
      )
      .map(({ row, step, module }) => ({
        nodeKey: step.nodeKey,
        roleId: row.roleId,
        moduleName: module.name,
        visible: row.visible,
        scoreEnabled: row.scoreEnabled,
        scoreRequired: row.scoreRequired,
        commentEnabled: row.commentEnabled,
        commentRequired: row.commentRequired,
        weight: row.weight,
        successorAccess: row.successorAccess,
        targetAccess: row.targetAccess,
      })),
  };
}

function moduleView(
  module: typeof M.$inferSelect,
  levels: (typeof ML.$inferSelect)[],
  fields: (typeof MF.$inferSelect)[],
): ModuleView {
  const own = levels.filter((level) => level.moduleId === module.id);
  const rule = own.filter((level) => level.source === 'rule');
  const grade = own.filter((level) => level.source === 'grade');
  return {
    id: module.id,
    kind: module.kind as ModuleView['kind'],
    name: module.name,
    source: module.source,
    criterionMode: module.criterionMode,
    criterionId: module.criterionId,
    dimensionTypes: module.dimensionTypes,
    scoring: module.scoring,
    scoreRuleId: module.sourceScoreRuleId,
    moduleGradeId: module.sourceModuleGradeId,
    ruleSnapshot: module.ruleKind
      ? {
          kind: module.ruleKind,
          min: module.ruleMin,
          max: module.ruleMax,
          display: module.ruleDisplay,
          allowUnable: module.ruleAllowUnable ?? false,
          levels: rule.map((level) => ({ name: level.name, value: Number(level.value) })),
        }
      : null,
    gradeSnapshot: module.sourceModuleGradeId
      ? {
          items: grade.map((level) => ({
            name: level.name,
            value: level.value,
            minScore: level.minScore,
            maxScore: level.maxScore,
            minCount: level.minCount,
          })),
        }
      : null,
    fieldIds: fields.filter((field) => field.moduleId === module.id).map((field) => field.fieldId),
    allowOrg: module.allowOrg,
    allowPosition: module.allowPosition,
    allowTarget: module.allowTarget,
  };
}

/** 完整视图：头部 + 指定版本（缺省当前版本）；版本不存在返回 undefined。 */
export async function loadTemplate(
  tx: Tx,
  tenantId: string,
  id: string,
  versionNo?: number,
): Promise<TemplateView | undefined> {
  const header = await headerOf(tx, tenantId, id);
  if (!header) return undefined;
  const structure = await loadStructure(tx, tenantId, id, versionNo ?? header.currentVersionNo);
  if (!structure) return undefined;
  const versions = await tx
    .select({ versionNo: V.versionNo, createdBy: V.createdBy, createdAt: V.createdAt })
    .from(V)
    .where(and(eq(V.tenantId, tenantId), eq(V.templateId, id)))
    .orderBy(asc(V.versionNo));
  return {
    ...header,
    ...structure,
    configErrors: weightConfigErrors(structure.modules, structure.permissions),
    versions,
  };
}
