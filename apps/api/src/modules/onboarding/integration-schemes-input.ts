import { addDays, addMonths } from '@italent/domain';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { normalizedUuid } from '../employment/fields.js';
import { CHANGE_TYPES } from '../employment/types.js';
import { checkIntegrationPoolAction } from './integration-pool-input.js';

const title = z.string().trim().min(1).max(100);
const dayCount = z.int().positive().max(9999);
const offset = z.strictObject({ unit: z.enum(['day', 'week', 'month']), ordinal: z.int().min(1).max(999) });
const off = z.strictObject({ mode: z.literal('off') });
const on = z.strictObject({ mode: z.literal('on'), days: dayCount });
const inherit = z.strictObject({ mode: z.literal('inherit') });
const reminder = z.discriminatedUnion('mode', [off, on]);
const taskReminder = z.discriminatedUnion('mode', [inherit, off, on]);

const assignee = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('employee') }),
  z.strictObject({ type: z.literal('member'), id: normalizedUuid }),
  z.strictObject({ type: z.literal('position'), id: normalizedUuid }),
  z.strictObject({ type: z.literal('post'), id: normalizedUuid }),
  z.strictObject({ type: z.literal('identity'), id: normalizedUuid }),
  z.strictObject({ type: z.literal('role'), role: z.enum(['department_head', 'direct_manager', 'mentor', 'hrbp']) }),
]);

const optionSet = (option: z.ZodType<string>) =>
  z
    .array(option)
    .max(50)
    .transform((values) => [...new Set(values)].sort());

const conditions = z.strictObject({
  employType: optionSet(z.enum(['internal', 'intern', 'external'])).optional(),
  employmentForm: optionSet(title).optional(),
  employmentType: optionSet(normalizedUuid).optional(),
  postId: optionSet(normalizedUuid).optional(),
  sequenceId: optionSet(normalizedUuid).optional(),
  contractCompanyId: optionSet(normalizedUuid).optional(),
  place: optionSet(z.string().trim().min(1).max(2000)).optional(),
  changeType: optionSet(z.enum(CHANGE_TYPES)).optional(),
});
export type IntegrationMatchFacts = { orgId: string } & { [K in keyof z.output<typeof conditions>]: string | null };

const dates = { start: offset, due: offset };
const task = z.strictObject({
  id: normalizedUuid.optional(),
  poolTaskId: normalizedUuid,
  ...dates,
  assignee,
  employeeVisible: z.boolean(),
  reminder: taskReminder.default({ mode: 'inherit' }),
  action: z.unknown().optional(),
});
const stage = z.strictObject({
  id: normalizedUuid.optional(),
  name: title,
  ...dates,
  tasks: z.array(task).max(50),
});

const schemeShape = z.strictObject({
  name: z
    .record(z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/), title)
    .refine((names) => !!names['zh-CN'] && Object.keys(names).length <= 16, '请填写简体中文方案名称'),
  priority: z.int().min(0).max(2147483647),
  description: z.string().trim().max(500).nullable(),
  failureRecipientId: normalizedUuid.nullable(),
  orgIds: optionSet(normalizedUuid).refine((ids) => ids.length > 0, '适用组织必填'),
  conditions,
  reminder,
  stages: z.array(stage).max(50),
});
export const schemeCreate = schemeShape.extend({
  priority: schemeShape.shape.priority.default(2001),
  description: schemeShape.shape.description.default(null),
  failureRecipientId: schemeShape.shape.failureRecipientId.default(null),
  conditions: conditions.default({}),
  reminder: reminder.default({ mode: 'off' }),
  stages: schemeShape.shape.stages.default([]),
});
export const schemePatch = schemeShape.partial().refine((patch) => Object.keys(patch).length > 0, '至少指定一项修改');
export const schemeDelete = z.strictObject({});

export type SchemeInput = z.output<typeof schemeCreate>;
export type StageTaskInput = z.output<typeof task>;
type Offset = z.output<typeof offset>;

const linearDays = ({ unit, ordinal }: Offset) => (ordinal - 1) * (unit === 'week' ? 7 : 1);

export function integrationDate(entryOn: string, value: Offset): string {
  return value.unit === 'month' ? addMonths(entryOn, value.ordinal - 1) : addDays(entryOn, linearDays(value));
}

const DAY_MS = 86_400_000;

// 公历按 400 年重复。月末截断前，日差在月初达到最大值，月末达到最小值。
function monthDayBounds(months: number) {
  let min = Infinity;
  let max = -Infinity;
  for (let month = 0; month < 4800; month++) {
    const start = Date.UTC(2000, month, 1);
    const end = Date.UTC(2000, month + months, 1);
    const days = (end - start) / DAY_MS;
    const clamp =
      new Date(Date.UTC(2000, month + 1, 0)).getUTCDate() -
      new Date(Date.UTC(2000, month + months + 1, 0)).getUTCDate();
    min = Math.min(min, days - Math.max(clamp, 0));
    max = Math.max(max, days);
  }
  return { min, max };
}

function ordered(left: Offset, right: Offset, bounds: Map<number, ReturnType<typeof monthDayBounds>>): boolean {
  if (left.unit !== 'month' && right.unit !== 'month') return linearDays(left) <= linearDays(right);
  if (left.unit === 'month' && right.unit === 'month') return left.ordinal <= right.ordinal;
  const months = (left.unit === 'month' ? left.ordinal : right.ordinal) - 1;
  if (!bounds.has(months)) bounds.set(months, monthDayBounds(months));
  const { min, max } = bounds.get(months)!;
  return left.unit === 'month' ? max <= linearDays(right) : linearDays(left) <= min;
}

export function validateSchemeStages(stages: SchemeInput['stages']) {
  const bounds = new Map<number, ReturnType<typeof monthDayBounds>>();
  const fits = (left: Offset, right: Offset) => ordered(left, right, bounds);
  for (const stage of stages) {
    if (!fits(stage.start, stage.due)) throw new AppError('VALIDATION_FAILED', '融入阶段起止日期不合法');
    for (const task of stage.tasks) {
      if (task.action !== undefined) {
        // 识别前序约定的拒绝原因，但动作的唯一来源始终是锁内任务池定义。
        checkIntegrationPoolAction('probation_assessment', task.action);
        throw new AppError('VALIDATION_FAILED', '方案任务动作由任务池定义');
      }
      if (!fits(stage.start, task.start) || !fits(task.start, task.due) || !fits(task.due, stage.due))
        throw new AppError('VALIDATION_FAILED', '融入任务起止日期须在所属阶段内');
      if (task.assignee.type === 'employee' && !task.employeeVisible)
        throw new AppError('VALIDATION_FAILED', '员工本人办理的融入任务须对员工可见');
    }
  }
}
