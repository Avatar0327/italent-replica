/**
 * 调动表单上的联动选项（`08` §4 “调动申请中可同时完成的业务”，`13` §7 表单结构）。只做结构校验，不读库。
 * 合同字段沿用合同模块的字段结构（R2-T06），生效日固定为调动生效日，不接受另填。
 */
import { z } from 'zod';
import { AppError } from '../../../errors.js';
import { fieldsSchema as contractFieldsSchema, type ContractFields } from '../../contracts/input.js';

// TODO(F-017)：F-017 合并后改用其统一的 UUID 规范化。
const uuid = z.uuid().transform((value) => value.toLowerCase());
const day = z.iso.date();

export const ORG_ROLES = ['person_in_charge', 'shop_owner', 'hrbp'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];
export type DutyRelation = 'direct' | 'dotted';

const linkageSchema = z.strictObject({
  contract: z
    .strictObject({ targetId: uuid, fields: contractFieldsSchema.default({}) })
    .nullable()
    .optional(),
  adjustSalary: z.boolean().optional(),
  onTrial: z
    .strictObject({ startDate: day.optional(), months: z.int().min(1).max(60) })
    .nullable()
    .optional(),
  handover: z
    .strictObject({ handoverPersonId: uuid.nullable().default(null) })
    .nullable()
    .optional(),
  partTimes: z
    .array(z.strictObject({ recordId: uuid }))
    .max(50)
    .optional(),
  dutyTransfer: z
    .strictObject({
      subordinates: z
        .array(z.strictObject({ employeeId: uuid, receiverId: uuid, relation: z.enum(['direct', 'dotted']) }))
        .max(200)
        .default([]),
      orgRoles: z
        .array(z.strictObject({ orgId: uuid, role: z.enum(ORG_ROLES), receiverId: uuid }))
        .max(50)
        .default([]),
    })
    .nullable()
    .optional(),
});

export interface DutySubordinate {
  readonly employeeId: string;
  readonly receiverId: string;
  readonly relation: DutyRelation;
}
export interface DutyOrgRole {
  readonly orgId: string;
  readonly role: OrgRole;
  readonly receiverId: string;
}

/** 规范化后的联动选项；“是否变更合同 / 调整薪资 / 设置试岗 …”以对应项是否存在表示。 */
export interface LinkageOptions {
  readonly contract: { readonly targetId: string; readonly fields: ContractFields } | null;
  readonly adjustSalary: boolean;
  readonly onTrial: { readonly startDate: string | null; readonly months: number } | null;
  readonly handover: { readonly handoverPersonId: string | null } | null;
  readonly partTimes: readonly { readonly recordId: string }[];
  readonly dutyTransfer: {
    readonly subordinates: readonly DutySubordinate[];
    readonly orgRoles: readonly DutyOrgRole[];
  } | null;
}

export function normalizeLinkage(raw: unknown): LinkageOptions {
  const parsed = linkageSchema.safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '调动联动字段不合法', parsed.error.issues);
  const input = parsed.data;
  if (input.contract && Object.hasOwn(input.contract.fields, 'effectiveDate'))
    throw new AppError('VALIDATION_FAILED', '变更合同的生效日期即调动生效日期，不能另填', {
      reason: 'TRANSFER_CONTRACT_DATE_FIXED',
    });
  const duty = input.dutyTransfer;
  const subordinates = duty?.subordinates ?? [];
  const orgRoles = duty?.orgRoles ?? [];
  assertUnique(
    subordinates.map((item) => `${item.employeeId}:${item.relation}`),
    '下属转交重复',
  );
  assertUnique(
    orgRoles.map((item) => `${item.orgId}:${item.role}`),
    '组织角色转交重复',
  );
  assertUnique(
    (input.partTimes ?? []).map((item) => item.recordId),
    '兼职记录重复',
  );
  return {
    contract: input.contract ?? null,
    adjustSalary: input.adjustSalary ?? false,
    onTrial: input.onTrial ? { startDate: input.onTrial.startDate ?? null, months: input.onTrial.months } : null,
    handover: input.handover ?? null,
    partTimes: input.partTimes ?? [],
    dutyTransfer: subordinates.length || orgRoles.length ? { subordinates, orgRoles } : null,
  };
}

function assertUnique(keys: readonly string[], message: string) {
  if (new Set(keys).size !== keys.length) throw new AppError('VALIDATION_FAILED', message);
}

/** 职责转交涉及的下属：其任职将被原地改写，按 F-008 计入调动参与人一起取员工锁。 */
export function dutySubordinateIds(options: LinkageOptions | null): string[] {
  return [...new Set(options?.dutyTransfer?.subordinates.map((item) => item.employeeId) ?? [])];
}
