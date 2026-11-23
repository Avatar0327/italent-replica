import {
  INTEGRATION_POOL_ASSESSMENT_TYPES,
  INTEGRATION_POOL_CATEGORIES,
  INTEGRATION_POOL_DEFERRED_CATEGORIES,
  INTEGRATION_POOL_FORM_KINDS,
  type IntegrationPoolCategory,
} from '@italent/db';
import { ASSESSMENT_NAME_MAX, ASSESSMENT_TYPES } from '@italent/domain';
import { z } from 'zod';
import { AppError } from '../../errors.js';

const names: Record<IntegrationPoolCategory, string> = {
  administrative: '行政事项',
  team_integration: '团队融入',
  work_integration: '工作融入',
  new_employee_introduction: '新员工介绍',
  probation_assessment: '试用期考核',
  learning_plan: '学习计划',
  probation_goal_plan: '试用期目标计划',
  survey: '问卷调查',
  other: '其他',
};

function categoryEnabled(code: IntegrationPoolCategory): boolean {
  return !INTEGRATION_POOL_DEFERRED_CATEGORIES.some((deferred) => deferred === code);
}

export function integrationPoolOptions() {
  return {
    items: INTEGRATION_POOL_CATEGORIES.map((code) => ({ code, name: names[code], enabled: categoryEnabled(code) })),
    assessmentTypes: INTEGRATION_POOL_ASSESSMENT_TYPES.map((code) => ({ code, name: ASSESSMENT_TYPES[code] })),
  };
}

const fieldCode = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const formField = z.strictObject({
  code: fieldCode,
  label: z.string().trim().min(1).max(100),
  kind: z.enum(INTEGRATION_POOL_FORM_KINDS),
  required: z.boolean(),
});
const actionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('form'),
    fields: z
      .array(formField)
      .max(50)
      .refine((fields) => new Set(fields.map(({ code }) => code)).size === fields.length, '办理表单字段编码不能重复'),
  }),
  z.strictObject({
    type: z.literal('assessment'),
    assessmentType: z.enum(INTEGRATION_POOL_ASSESSMENT_TYPES),
    name: z.string().trim().min(1).max(ASSESSMENT_NAME_MAX),
  }),
]);
export type IntegrationPoolAction = z.output<typeof actionSchema>;

export const poolCategory = z.enum(INTEGRATION_POOL_CATEGORIES);
export const poolCreateBody = z.strictObject({
  code: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000).nullable().optional(),
  category: poolCategory,
  enabled: z.boolean().optional(),
  action: z.unknown(),
});
export const poolPatchBody = poolCreateBody
  .omit({ code: true })
  .partial()
  .refine((input) => Object.keys(input).length > 0, '至少指定一项修改');

export type PoolCreateInput = z.output<typeof poolCreateBody>;
export type PoolPatchInput = z.output<typeof poolPatchBody>;

/** R2-T01 §7.1：创建、编辑、挂接与后续执行共用同一个解码口径。 */
export function checkIntegrationPoolAction(category: IntegrationPoolCategory, value: unknown): IntegrationPoolAction {
  const { type, assessmentType } = (value ?? {}) as Partial<Record<'type' | 'assessmentType', unknown>>;
  if (type === 'performance_activity' || assessmentType === 'performance_activity') {
    throw new AppError('VALIDATION_FAILED', '绩效活动暂未开放，请选择试用中考核或转正考核', {
      reason: 'INTEGRATION_PERFORMANCE_ACTIVITY_UNAVAILABLE',
    });
  }
  if (type === 'process') {
    throw new AppError('VALIDATION_FAILED', '融入办理流程暂未开放', { reason: 'INTEGRATION_PROCESS_UNAVAILABLE' });
  }
  if (!categoryEnabled(category)) {
    throw new AppError('VALIDATION_FAILED', '该融入任务类别暂未开放', { reason: 'INTEGRATION_CATEGORY_UNAVAILABLE' });
  }
  const parsed = actionSchema.safeParse(value);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '融入办理动作不合法', parsed.error.issues);
  const action = parsed.data;
  if ((category === 'probation_assessment') !== (action.type === 'assessment')) {
    throw new AppError('VALIDATION_FAILED', '融入任务类别与办理动作不匹配', {
      reason: 'INTEGRATION_CATEGORY_ACTION_MISMATCH',
    });
  }
  return action;
}
