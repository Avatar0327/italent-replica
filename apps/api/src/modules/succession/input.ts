/**
 * 继任记录写入口的请求结构（设计 §2.2 #3～#6；只做结构校验，不读库）。严格对象：未登记的键（来源、结束来源、状态等系统值）
 * 一律 400；目标与继任者建后不可改（编辑时带这些键 400 FIELD_IMMUTABLE，在解析前先判）。
 */
import { SUCCESSION_BACKUP_TYPES } from '@italent/db';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { validIsoDate } from '../org/read-model.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const date = z.string().refine(validIsoDate, '日期必须为合法的 YYYY-MM-DD');
const reason = z.string().trim().min(1).max(200);
const backupType = z.enum(SUCCESSION_BACKUP_TYPES);

export const recordCreate = z
  .strictObject({
    successionType: z.enum(['org', 'position']),
    targetOrgId: uuid.optional(),
    targetPositionId: uuid.optional(),
    successorEmployeeId: uuid,
    readinessId: uuid.nullable().optional(),
    backupType: backupType.optional(),
    startDate: date,
    endDate: date.nullable().optional(),
    endReason: reason.nullable().optional(),
  })
  .refine(
    (v) =>
      v.successionType === 'org'
        ? v.targetOrgId !== undefined && v.targetPositionId === undefined
        : v.targetPositionId !== undefined && v.targetOrgId === undefined,
    '继任类型与目标不匹配',
  );
export type RecordCreate = z.infer<typeof recordCreate>;

export const recordPatch = z
  .strictObject({
    readinessId: uuid.nullable().optional(),
    backupType: backupType.optional(),
    startDate: date.optional(),
    endDate: date.nullable().optional(),
    endReason: reason.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, '至少修改一个字段');
export type RecordPatch = z.infer<typeof recordPatch>;

/** 建后不可改的键：先于结构校验判，给出专用 reason。 */
const IMMUTABLE = ['successionType', 'targetOrgId', 'targetPositionId', 'successorEmployeeId'] as const;
export function rejectImmutable(body: unknown): void {
  if (body === null || typeof body !== 'object') return;
  const found = IMMUTABLE.filter((key) => key in (body as object));
  if (found.length) {
    throw new AppError('VALIDATION_FAILED', '目标与继任者创建后不可修改', { reason: 'FIELD_IMMUTABLE', fields: found });
  }
}

export const MAX_END_ITEMS = 200;
export const recordEnd = z
  .strictObject({
    items: z
      .array(z.strictObject({ id: uuid, expectedRevision: z.int().min(1) }))
      .min(1)
      .max(MAX_END_ITEMS),
    endDate: date,
    endReason: reason.nullable().optional(),
  })
  .refine((v) => new Set(v.items.map((item) => item.id)).size === v.items.length, '记录不能重复');
export type RecordEnd = z.infer<typeof recordEnd>;
