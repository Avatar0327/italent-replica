/**
 * 盘点模板的请求结构（只做结构校验，不读库；设计 §2.3）。严格对象：未登记的键一律 400。结构三件（steps / modules /
 * permissions）整组提交：提交了就以提交为准（steps 只收 show_matrix 设置，其余来自流程），没提交就沿用当前版本；
 * 提交 flowId 与当前不同、或提交任一结构件都生成新版本，只改头部字段（名称 / 所属组织 / 向下公开 / 启停）不生成。
 */
import {
  CRITERION_MODES,
  INDICATOR_SOURCES,
  SCORING_METHODS,
  SUCCESSION_ACCESS,
  TALENT_DIMENSION_TYPES,
  TEMPLATE_MAX_MODULES,
  TEMPLATE_MAX_PERMISSIONS,
  TEMPLATE_MODULE_KINDS,
  FLOW_MAX_NODES,
} from '@italent/domain';
import { z } from 'zod';

/** 标识统一小写规范化（DEC-194）。 */
const uuid = z.uuid().transform((value) => value.toLowerCase());
const name = z.string().trim().min(1).max(50);
const nodeKey = z.string().min(1).max(32);
const access = z.enum(SUCCESSION_ACCESS);

const step = z.strictObject({ nodeKey, showMatrix: z.boolean() });
const module = z.strictObject({
  kind: z.enum(TEMPLATE_MODULE_KINDS),
  name,
  source: z.enum(INDICATOR_SOURCES).nullish(),
  criterionMode: z.enum(CRITERION_MODES).nullish(),
  criterionId: uuid.nullish(),
  dimensionTypes: z.array(z.enum(TALENT_DIMENSION_TYPES)).max(TALENT_DIMENSION_TYPES.length).nullish(),
  scoring: z.enum(SCORING_METHODS).nullish(),
  scoreRuleId: uuid.nullish(),
  moduleGradeId: uuid.nullish(),
  fieldIds: z.array(uuid).max(100).nullish(),
  allowOrg: z.boolean().optional(),
  allowPosition: z.boolean().optional(),
  allowTarget: z.boolean().optional(),
});
const permission = z.strictObject({
  nodeKey,
  roleId: uuid.nullish(),
  moduleName: name,
  visible: z.boolean().optional(),
  scoreEnabled: z.boolean().optional(),
  scoreRequired: z.boolean().optional(),
  commentEnabled: z.boolean().optional(),
  commentRequired: z.boolean().optional(),
  weight: z.number().min(0).max(100).nullish(),
  successorAccess: access.nullish(),
  targetAccess: access.nullish(),
});

export const templateCreate = z.strictObject({
  name,
  ownerOrgId: uuid,
  downwardPublic: z.boolean().optional(),
  flowId: uuid.nullish(),
  enabled: z.boolean().optional(),
  steps: z.array(step).max(FLOW_MAX_NODES).optional(),
  modules: z.array(module).max(TEMPLATE_MAX_MODULES).optional(),
  permissions: z.array(permission).max(TEMPLATE_MAX_PERMISSIONS).optional(),
});
export const templatePatch = templateCreate.partial();

export type TemplateCreate = z.output<typeof templateCreate>;
export type TemplatePatch = z.output<typeof templatePatch>;
export type ModuleBody = z.output<typeof module>;
export type PermissionBody = z.output<typeof permission>;
