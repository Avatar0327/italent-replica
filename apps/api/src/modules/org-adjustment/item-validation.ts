/**
 * 组织明细载荷校验（R2-T08 §2.2 / §5，BE-10b2）。结构用 strict zod（未知字段 400）；按调整类型与入口限定可填字段，
 * 11d / 11e 前未开放的能力（转移组织、编制同步、负责人联动）一律关口拒绝。上级与转移组织二选一引用已有组织或本单新增行。
 */
import { ORG_ITEM_ENTRY_BUTTONS, type OrgItemEntry } from '@italent/domain';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { invalid } from '../org/validation.js';
import type { OrgItemContent } from './items-store.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const opt = <T extends z.ZodType>(type: T) => type.nullable().optional();
const orgRef = z.union([z.strictObject({ orgId: uuid }), z.strictObject({ itemId: uuid })]);
const INT32 = 2147483647;

const fields = {
  name: opt(z.string().trim().min(1).max(200)),
  code: opt(z.string().trim().min(1).max(64)),
  shortName: opt(z.string().trim().max(100)),
  parent: opt(orgRef),
  displayOrder: opt(
    z
      .number()
      .int()
      .min(-INT32 - 1)
      .max(INT32),
  ),
  level: opt(z.number().int().min(1).max(10)),
  halfLevel: opt(z.union([z.literal(1), z.literal(2)])),
  updateDescendantLevels: opt(z.boolean()),
  personInChargeId: opt(uuid),
  hrbpId: opt(uuid),
  addEmployment: opt(z.boolean()),
  transferOldHeadSubordinates: opt(z.boolean()),
  adjustNewHeadManager: opt(z.boolean()),
  newHeadManagerId: opt(uuid),
  syncEstablishment: opt(z.boolean()),
  deactivationEstablishmentMode: opt(z.union([z.literal(1), z.literal(2)])),
  establishmentTransferAmount: opt(z.number().int().min(0).max(INT32)),
  batchTransfer: opt(z.boolean()),
  transferTo: opt(orgRef),
};

const ENTRIES = Object.keys(ORG_ITEM_ENTRY_BUTTONS) as [OrgItemEntry, ...OrgItemEntry[]];
export const addItemSchema = z.strictObject({
  ...fields,
  entry: z.enum(ENTRIES),
  adjustType: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  targetOrgId: opt(uuid),
  isStaged: z.boolean().optional(),
});
export const patchItemSchema = z
  .strictObject(fields)
  .refine((value) => Object.keys(value).length > 0, '至少修改一个字段');

export type AddItemInput = z.infer<typeof addItemSchema>;
export type ItemPatch = z.infer<typeof patchItemSchema>;
export type ItemFieldKey = keyof typeof fields;

const SHARED: readonly ItemFieldKey[] = [
  'name',
  'code',
  'shortName',
  'parent',
  'displayOrder',
  'level',
  'halfLevel',
  'personInChargeId',
  'hrbpId',
  'transferOldHeadSubordinates',
  'adjustNewHeadManager',
  'newHeadManagerId',
  'syncEstablishment',
];
/** 各类型可填字段；拖拽只改上级并必填是否新增任职（DEC-659②）。 */
export const ALLOWED: Record<1 | 2 | 3 | 'drag', readonly ItemFieldKey[]> = {
  1: SHARED,
  2: [...SHARED, 'updateDescendantLevels', 'addEmployment'],
  3: [
    'transferTo',
    'syncEstablishment',
    'deactivationEstablishmentMode',
    'establishmentTransferAmount',
    'batchTransfer',
  ],
  drag: ['parent', 'addEmployment'],
};
/** 改组织时至少改其中一项。 */
export const CHANGE_FIELDS = [
  'name',
  'code',
  'shortName',
  'parentOrgId',
  'parentItemId',
  'displayOrder',
  'level',
  'halfLevel',
  'personInChargeId',
  'hrbpId',
] as const satisfies readonly (keyof OrgItemContent)[];

/** 字段编辑权按 OrganizationApproval 的 `orgItems.*` 判（上级 / 转移组织按字段名，不分引用方式）。 */
export function itemFieldCodes(keys: readonly string[]): Record<string, true> {
  const name = (key: string) => (key === 'parent' ? 'parentOrgId' : key === 'transferTo' ? 'transferToOrgId' : key);
  return Object.fromEntries(keys.filter((key) => key !== 'entry').map((key) => [`orgItems.${name(key)}`, true]));
}

/** 入口与调整类型一致；入口按钮表见 `ORG_ITEM_ENTRY_BUTTONS`。 */
export function assertEntryType(input: AddItemInput) {
  if (ORG_ITEM_ENTRY_BUTTONS[input.entry].adjustType !== input.adjustType) {
    throw invalid('adjustType', '明细入口与调整类型不一致');
  }
  if ((input.adjustType === 1) !== (input.targetOrgId == null)) {
    throw invalid('targetOrgId', input.adjustType === 1 ? '新增组织不能指定目标组织' : '必须选择目标组织');
  }
}

/** 只许本类型（入口）的字段；11d / 11e 前未开放的能力按关口拒绝。 */
export function assertItemFields(kind: 1 | 2 | 3 | 'drag', input: Partial<Record<ItemFieldKey, unknown>>) {
  const allowed = new Set(ALLOWED[kind]);
  const extra = (Object.keys(fields) as ItemFieldKey[]).find((key) => input[key] !== undefined && !allowed.has(key));
  if (extra) throw invalid(extra, kind === 'drag' ? '拖拽只能修改上级组织' : '该调整类型不能填写此字段');
  const establishment = ['syncEstablishment', 'deactivationEstablishmentMode', 'establishmentTransferAmount'] as const;
  if (input.syncEstablishment === true || establishment.slice(1).some((key) => input[key] != null)) {
    throw new AppError('VALIDATION_FAILED', '编制同步随编制模块上线后开放', {
      reason: 'ORG_ADJUSTMENT_ESTABLISHMENT_SYNC_NOT_AVAILABLE',
    });
  }
  if (input.transferOldHeadSubordinates === true || input.adjustNewHeadManager === true || input.newHeadManagerId) {
    throw new AppError('VALIDATION_FAILED', '负责人联动随任职调整上线后开放', {
      reason: 'ORG_ADJUSTMENT_HEAD_LINKAGE_NOT_AVAILABLE',
    });
  }
  if (input.transferTo != null) {
    throw new AppError('CONFLICT', '停用转移组织随人员与职位明细上线后开放', {
      reason: 'ORG_ADJUSTMENT_TRANSFER_NOT_AVAILABLE',
    });
  }
}

/** 把载荷里的上级 / 转移组织引用拆成存储列；未给的键保持 undefined（PATCH 不改）。 */
export function toContent(input: Partial<Record<ItemFieldKey, unknown>>): Partial<OrgItemContent> {
  const { parent, transferTo, ...rest } = input as Record<string, unknown> & {
    parent?: { orgId?: string; itemId?: string } | null;
    transferTo?: { orgId?: string; itemId?: string } | null;
  };
  const out: Record<string, unknown> = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  if (parent !== undefined)
    Object.assign(out, { parentOrgId: parent?.orgId ?? null, parentItemId: parent?.itemId ?? null });
  if (transferTo !== undefined) {
    Object.assign(out, { transferToOrgId: transferTo?.orgId ?? null, transferToItemId: transferTo?.itemId ?? null });
  }
  return out as Partial<OrgItemContent>;
}
