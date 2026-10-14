/** 发展计划执行接口的请求体（结构校验；业务规则在服务层）。UUID 一律规范为小写（DEC-194）。 */
import { START_NEXT_MODES, TUTOR_ROLES } from '@italent/domain';
import { z } from 'zod';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const text = (max: number) => z.string().trim().max(max).nullable();
const isoDate = z.iso.date();
const ordered = <T extends { startDate?: string | null; endDate?: string | null }>(value: T) =>
  !value.startDate || !value.endDate || value.endDate >= value.startDate;
const DATE_ORDER = { message: '结束时间不能早于开始时间', path: ['endDate'] };

/** 批量干预 / 统一下发的上限（AGENTS §10 批量）。 */
export const MAX_BATCH = 100;

export const planCreate = z
  .strictObject({
    name: z.string().trim().min(1).max(200),
    employeeId: uuid,
    templateId: uuid,
    startDate: isoDate,
    endDate: isoDate,
    tutorRole: z.enum(TUTOR_ROLES),
    tutorEmployeeId: uuid.nullable().optional(),
  })
  .refine(ordered, DATE_ORDER)
  .refine((v) => v.tutorRole !== 'other' || !!v.tutorEmployeeId, {
    message: '指导人角色为“其他人”时须指定指导人',
    path: ['tutorEmployeeId'],
  });
export type PlanCreate = z.infer<typeof planCreate>;

export const planPatch = z
  .strictObject({
    name: z.string().trim().min(1).max(200).optional(),
    startDate: isoDate.optional(),
    endDate: isoDate.optional(),
    tutorRole: z.enum(TUTOR_ROLES).optional(),
    tutorEmployeeId: uuid.nullable().optional(),
  })
  .refine(ordered, DATE_ORDER);
export type PlanPatch = z.infer<typeof planPatch>;

const goalFields = {
  name: z.string().trim().min(1).max(200).optional(),
  measure: text(2000).optional(),
  suggestion: text(2000).optional(),
  startDate: isoDate.nullable().optional(),
  endDate: isoDate.nullable().optional(),
  displayOrder: z.number().int().min(0).max(10_000).optional(),
};

/** 新建目标：自定义（须填名称）或胜任力库指标（indicatorId，名称缺省取指标名称，DEC-307）。 */
export const goalCreate = z
  .strictObject({ moduleId: uuid, indicatorId: uuid.optional(), ...goalFields })
  .refine(ordered, DATE_ORDER)
  .refine((v) => !!v.indicatorId || !!v.name, { message: '自定义目标须填写名称', path: ['name'] });
export type GoalCreate = z.infer<typeof goalCreate>;

export const goalPatch = z.strictObject(goalFields).refine(ordered, DATE_ORDER);
export type GoalPatch = z.infer<typeof goalPatch>;

const taskFields = {
  name: z.string().trim().min(1).max(200),
  description: text(2000).optional(),
  ownerEmployeeId: uuid.nullable().optional(),
  startDate: isoDate.nullable().optional(),
  endDate: isoDate.nullable().optional(),
};

export const taskCreate = z.strictObject(taskFields).refine(ordered, DATE_ORDER);
export type TaskCreate = z.infer<typeof taskCreate>;

export const taskPatch = z
  .strictObject({ ...taskFields, name: taskFields.name.optional() })
  .refine(ordered, DATE_ORDER);
export type TaskPatch = z.infer<typeof taskPatch>;

export const goalReview = z.strictObject({
  progress: z.number().int().min(0).max(100).nullable().optional(),
  outcome: text(4000).optional(),
});
export type GoalReviewInput = z.infer<typeof goalReview>;

/** 综述（现状分析、待发展项）或回顾 / 总结（总结、改进方法），按模块类型取用。 */
export const moduleContent = z.strictObject({
  currentAnalysis: text(4000).optional(),
  developmentItems: text(4000).optional(),
  summary: text(4000).optional(),
  improvement: text(4000).optional(),
});
export type ModuleContentInput = z.infer<typeof moduleContent>;

const items = z
  .array(z.strictObject({ id: uuid, revision: z.number().int().min(1) }))
  .min(1)
  .max(MAX_BATCH);

export const batchItems = z.strictObject({ items, reason: text(500).optional() });
export type BatchItems = z.infer<typeof batchItems>;

export const startNext = z.strictObject({ items, runningMode: z.enum(START_NEXT_MODES) });
export type StartNextInput = z.infer<typeof startNext>;

export const jump = z.strictObject({
  toNodeKey: z.string().min(1).max(100),
  stageId: uuid.optional(),
  reason: z.string().trim().min(1).max(500),
});
export type JumpInput = z.infer<typeof jump>;

/** 转交（F-066）：转给 toUserId；taskId 缺省取当前阶段唯一的待办；原因可选（转给自己时由审批侧要求必填）。 */
export const transfer = z.strictObject({
  toUserId: uuid,
  taskId: uuid.optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});
export type TransferInput = z.infer<typeof transfer>;

export const taskIssue = z.strictObject({
  commonGoalId: uuid,
  plans: items,
  task: z.strictObject(taskFields).refine(ordered, DATE_ORDER),
});
export type TaskIssue = z.infer<typeof taskIssue>;

// ---- 关键信息（IDP-R19～R21） ----

const span = { startDate: isoDate, endDate: isoDate.nullable().optional() };

export const tutorshipCreate = z
  .strictObject({ tutorEmployeeId: uuid, tuteeEmployeeId: uuid, remark: text(2000).optional(), ...span })
  .refine(ordered, DATE_ORDER)
  .refine((v) => v.tutorEmployeeId !== v.tuteeEmployeeId, {
    message: '带教人与被带教人不能是同一人',
    path: ['tuteeEmployeeId'],
  });

export const careerCreate = z
  .strictObject({
    employeeId: uuid,
    targetPositionId: uuid.nullable().optional(),
    strengths: text(2000).optional(),
    developmentItems: text(2000).optional(),
    intendedCity: text(200).optional(),
    ...span,
  })
  .refine(ordered, DATE_ORDER);

export const workShiftCreate = z
  .strictObject({
    employeeId: uuid,
    orgId: uuid,
    positionId: uuid.nullable().optional(),
    postId: uuid.nullable().optional(),
    mentorEmployeeId: uuid.nullable().optional(),
    ...span,
  })
  .refine(ordered, DATE_ORDER);

// 修改：只带要改的字段；起止先后与人员关系在服务层按合并后的值校验
export const tutorshipPatch = z.strictObject({
  tutorEmployeeId: uuid.optional(),
  tuteeEmployeeId: uuid.optional(),
  remark: text(2000).optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.nullable().optional(),
});

export const careerPatch = z.strictObject({
  employeeId: uuid.optional(),
  targetPositionId: uuid.nullable().optional(),
  strengths: text(2000).optional(),
  developmentItems: text(2000).optional(),
  intendedCity: text(200).optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.nullable().optional(),
});

export const workShiftPatch = z.strictObject({
  employeeId: uuid.optional(),
  orgId: uuid.optional(),
  positionId: uuid.nullable().optional(),
  postId: uuid.nullable().optional(),
  mentorEmployeeId: uuid.nullable().optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.nullable().optional(),
});
