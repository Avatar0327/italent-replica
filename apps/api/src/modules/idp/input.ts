/** IDP 配置接口的请求体（结构校验；业务规则在服务层）。UUID 一律规范为小写（DEC-194）。 */
import {
  COMPETENCY_SOURCES,
  IDP_APPROVAL_TYPES,
  KEY_INFO_SOURCES,
  MAX_SUB_PROCESSES,
  MODULE_TYPES,
  PLAN_TIME_BASES,
  REFERENCE_POINTS,
  REVIEW_TIME_BASES,
  START_FROM,
  START_MODES,
  START_TIME_TYPES,
  SUB_PROCESS_CATEGORIES,
} from '@italent/domain';
import { z } from 'zod';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const name = z.string().trim().min(1).max(100);
const text = (max: number) => z.string().trim().max(max).nullable();
const isoDate = z.iso.date();

const subProcess = z.strictObject({
  /** 已有子流程的标识；新增段不带。 */
  id: uuid.optional(),
  name,
  category: z.enum(SUB_PROCESS_CATEGORIES),
  approvalType: z.enum(IDP_APPROVAL_TYPES),
  approvalProcessId: uuid,
  startMode: z.enum(START_MODES),
  startTimeType: z.enum(START_TIME_TYPES).nullable().default(null),
  fixedDate: isoDate.nullable().default(null),
  referencePoint: z.enum(REFERENCE_POINTS).nullable().default(null),
  startFrom: z.enum(START_FROM).nullable().default(null),
  days: z.number().int().nullable().default(null),
  /** 读接口回传的只读字段，提交时忽略。 */
  seq: z.number().int().optional(),
});
export type SubProcessInput = z.infer<typeof subProcess>;

const subProcesses = z.array(subProcess).min(1).max(MAX_SUB_PROCESSES);

export const processCreate = z.strictObject({
  name,
  orgId: uuid,
  publicDown: z.boolean().default(true),
  enabled: z.boolean().default(true),
  subProcesses,
});
export type ProcessCreate = z.infer<typeof processCreate>;

export const processPatch = z.strictObject({
  name: name.optional(),
  orgId: uuid.optional(),
  publicDown: z.boolean().optional(),
  enabled: z.boolean().optional(),
  subProcesses: subProcesses.optional(),
});
export type ProcessPatch = z.infer<typeof processPatch>;

export const templateCreate = z.strictObject({
  name,
  description: text(2000).optional(),
  orgId: uuid,
  publicDown: z.boolean().default(true),
  processId: uuid,
});
export type TemplateCreate = z.infer<typeof templateCreate>;

export const templatePatch = z.strictObject({
  name: name.optional(),
  description: text(2000).optional(),
  orgId: uuid.optional(),
  publicDown: z.boolean().optional(),
  processId: uuid.optional(),
});
export type TemplatePatch = z.infer<typeof templatePatch>;

export const templateCopy = z.strictObject({ name, orgId: uuid.optional() });
export type TemplateCopy = z.infer<typeof templateCopy>;

const nodeSetting = z.strictObject({
  subProcessId: uuid,
  nodeKey: z.string().min(1).max(100),
  enabled: z.boolean(),
  buttons: z.array(z.string().max(50)).max(10),
});
export type NodeSettingInput = z.infer<typeof nodeSetting>;

/** 模块配置字段（各模块类型只认其中一部分，服务层按类型校验）。 */
const moduleSettings = {
  description: text(2000).optional(),
  displayOrder: z.number().int().min(0).max(10_000).optional(),
  allowCustomGoal: z.boolean().optional(),
  allowLibraryGoal: z.boolean().optional(),
  competencySource: z.enum(COMPETENCY_SOURCES).nullable().optional(),
  goalReviewEnabled: z.boolean().optional(),
  taskEnabled: z.boolean().optional(),
  checkNoneGoal: z.boolean().optional(),
  keyInfoSources: z.array(z.enum(KEY_INFO_SOURCES)).max(KEY_INFO_SOURCES.length).optional(),
  reviewTimeBasis: z.enum(REVIEW_TIME_BASES).nullable().optional(),
  planTimeBasis: z.enum(PLAN_TIME_BASES).nullable().optional(),
  reviewCategoryIds: z.array(uuid).max(50).nullable().optional(),
  nodeSettings: z.array(nodeSetting).max(200).optional(),
};

export const moduleCreate = z.strictObject({ moduleType: z.enum(MODULE_TYPES), name, ...moduleSettings });
export type ModuleCreate = z.infer<typeof moduleCreate>;

export const modulePatch = z.strictObject({ name: name.optional(), ...moduleSettings });
export type ModulePatch = z.infer<typeof modulePatch>;

export const commonGoalCreate = z.strictObject({
  moduleId: uuid,
  name: z.string().trim().min(1).max(200),
  measure: text(2000).optional(),
  suggestion: text(2000).optional(),
  displayOrder: z.number().int().min(0).max(10_000).optional(),
});
export type CommonGoalCreate = z.infer<typeof commonGoalCreate>;

export const commonGoalPatch = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  measure: text(2000).optional(),
  suggestion: text(2000).optional(),
  displayOrder: z.number().int().min(0).max(10_000).optional(),
});
export type CommonGoalPatch = z.infer<typeof commonGoalPatch>;
