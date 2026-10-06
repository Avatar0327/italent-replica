import { randomUUID } from 'node:crypto';
import { tenantLocalDate } from '@italent/domain';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { validIsoDate } from '../org/read-model.js';
import type { JobKind } from './metadata.js';
import type { JobFields, JobInput, JobWriteContext } from './types.js';

export const businessDate = z.string().refine(validIsoDate, '日期必须为合法 YYYY-MM-DD');
const integer = z.number().int().min(-2_147_483_648).max(2_147_483_647);
const order = integer.nullable().optional();
const reference = z.uuid().nullable().optional();
const text = z.string().max(4000).nullable().optional();
const number = z.number().finite().nullable().optional();
const parent = z.strictObject({ parentId: z.uuid().nullable(), sequence: order });
const common = {
  name: z.string().trim().min(1).max(200),
  code: z.string().trim().min(1).max(64).optional(),
  startDate: businessDate.optional(),
  stopDate: businessDate.optional(),
  enabled: z.boolean().optional(),
  establishedOn: businessDate.nullable().optional(),
  displayOrder: order,
  qualificationId: reference,
};
const ranges = {
  levelTypeId: reference,
  minLevelId: reference,
  maxLevelId: reference,
  minGradeId: reference,
  maxGradeId: reference,
};
const associations = {
  // PostgreSQL UUID 按大小写等价比较；触发同步前也必须先归一，不能把同一引用当成非空变更。
  sequenceId: z
    .uuid()
    .transform((id) => id.toLowerCase())
    .nullable()
    .optional(),
  professionalLineId: reference,
};
const characteristics = {
  isKey: z.boolean().optional(),
  isConfidential: z.boolean().optional(),
  syncSequenceToAssignments: z.boolean().optional(),
};
const specific = {
  layers: { layerLevel: order },
  grades: { grade: order, layerId: reference, scoreLow: number, scoreHigh: number },
  'level-types': {},
  levels: { level: order, levelTypeId: reference, minGradeId: reference, maxGradeId: reference },
  sequences: { parentId: reference, levelTypeId: reference, source: text, externalId: text },
  'professional-lines': { parentId: reference },
  posts: {
    ...ranges,
    ...associations,
    ...characteristics,
    competencyModelId: reference,
    responsibilities: text,
    requirements: text,
    evaluationScore: number,
  },
  positions: {
    ...ranges,
    ...associations,
    ...characteristics,
    orgId: z.uuid(),
    postId: z.uuid(),
    parents: z.strictObject({ admin: parent.optional(), dotted: parent.optional() }).optional(),
    workLocation: text,
    standardPositionId: reference,
  },
} satisfies Record<JobKind, z.ZodRawShape>;

export function jobCreationSchema(kind: JobKind) {
  return z.strictObject({ ...common, ...specific[kind] });
}

export function jobPatchSchema(kind: JobKind) {
  const patch = jobCreationSchema(kind).omit({ startDate: true }).partial().extend({ effectiveDate: businessDate });
  return kind === 'positions' ? patch.extend({ adjustEmployeeDirectManager: z.boolean().optional() }) : patch;
}

export function normalizeFields(ctx: JobWriteContext, kind: JobKind, input: JobInput): JobFields {
  const parsed = jobCreationSchema(kind).safeParse(input);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '职务体系字段不合法', parsed.error.issues);
  const data: Record<string, unknown> = parsed.data;
  const startDate = (data.startDate as string | undefined) ?? tenantLocalDate(ctx.now, ctx.timezone);
  const stopDate = (data.stopDate as string | undefined) ?? '9999-12-31';
  if (stopDate < startDate) throw new AppError('VALIDATION_FAILED', '失效日期不得早于生效日期');
  rejectUnsupported(data);
  return {
    ...data,
    code: (data.code as string | undefined) ?? `J${randomUUID().replaceAll('-', '')}`,
    name: data.name as string,
    startDate,
    stopDate,
    enabled: (data.enabled as boolean | undefined) ?? true,
    establishedOn: (data.establishedOn as string | null | undefined) ?? null,
    displayOrder: (data.displayOrder as number | null | undefined) ?? null,
    qualificationId: null,
  };
}

function rejectUnsupported(data: Record<string, unknown>): void {
  // TODO(需取证 Q-M0-17): 接入真实任职资格与胜任力模型后验证引用对象、租户与可用状态。
  if (data.qualificationId || data.competencyModelId) {
    throw new AppError('SERVICE_UNAVAILABLE', '任职资格或胜任力模型的租户引用验证尚未接入');
  }
}
