/**
 * 盘点配置对象的请求结构（只做结构校验，不读库）。严格对象：未登记的键一律 400；编码、字段类型建后不可改，
 * 修改结构不收它们。字段目录的跨行规则（选项、成对）在 field-service.ts。
 */
import {
  FIELD_MAX_PRECISION,
  TALENT_REVIEW_FIELD_GROUPS,
  TALENT_REVIEW_FIELD_KINDS,
  TALENT_REVIEW_PAIR_ROLES,
  TALENT_REVIEW_ROLE_RESOLVERS,
} from '@italent/domain';
import { z } from 'zod';

/** 标识统一小写规范化（DEC-194）。 */
const uuid = z.uuid().transform((value) => value.toLowerCase());
const name = z.string().trim().min(1).max(50);
const sortNo = z.int().min(0).max(1_000_000);

export const categoryCreate = z.strictObject({ name, sortNo: sortNo.optional(), enabled: z.boolean().optional() });
export const categoryPatch = categoryCreate.partial();

export const roleCreate = z.strictObject({
  code: z.string().trim().min(1).max(50),
  name,
  resolver: z.enum(TALENT_REVIEW_ROLE_RESOLVERS),
  sortNo: sortNo.optional(),
  enabled: z.boolean().optional(),
});
export const rolePatch = roleCreate.omit({ code: true }).partial();

export const fieldOption = z.strictObject({
  value: z.string().trim().min(1).max(50),
  label: z.string().trim().min(1).max(50),
  sortNo: sortNo.optional(),
  enabled: z.boolean().optional(),
});
export const fieldCreate = z.strictObject({
  code: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,49}$/, '编码须以字母开头，仅含字母、数字、下划线'),
  name,
  kind: z.enum(TALENT_REVIEW_FIELD_KINDS),
  group: z.enum(TALENT_REVIEW_FIELD_GROUPS),
  precision: z.int().min(0).max(FIELD_MAX_PRECISION).optional(),
  pairRole: z.enum(TALENT_REVIEW_PAIR_ROLES).optional(),
  pairFieldId: uuid.optional(),
  options: z.array(fieldOption).max(200).optional(),
  sortNo: sortNo.optional(),
  enabled: z.boolean().optional(),
});
export const fieldPatch = z.strictObject({
  name: name.optional(),
  group: fieldCreate.shape.group.optional(),
  precision: fieldCreate.shape.precision,
  options: fieldCreate.shape.options,
  sortNo: sortNo.optional(),
  enabled: z.boolean().optional(),
});

export const settingsPatch = z.strictObject({
  allowSecondaryKeyPositionNomination: z.boolean().optional(),
  selfResultVisible: z.boolean().optional(),
  doneHideSuccession: z.boolean().optional(),
  systemPrincipalUserId: uuid.nullable().optional(),
});

export type CategoryCreate = z.output<typeof categoryCreate>;
export type CategoryPatch = z.output<typeof categoryPatch>;
export type RoleCreate = z.output<typeof roleCreate>;
export type RolePatch = z.output<typeof rolePatch>;
export type FieldCreate = z.output<typeof fieldCreate>;
export type FieldPatch = z.output<typeof fieldPatch>;
export type FieldOptionInput = z.output<typeof fieldOption>;
export type SettingsPatch = z.output<typeof settingsPatch>;
