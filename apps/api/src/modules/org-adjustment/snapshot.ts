/**
 * 组织调整的审批快照（R2-T08 §4.5，BE-10c）：头（含调整范围）+ 组织分区；调动 / 职位 / 编制 / 兼职分区不在本片。
 * - 头字段按编码直接取值；组织分区每个编码一份 `[{ itemId, value }]`，只列该行有值的（编码按 itemId，与行序无关）；
 * - 变化字段：新单据没有原值，头里有值的字段 + 明细里实际填了值的编码都算本单内容（审批人看不到即盲审，DEC-058）；
 * - 路由部门 = 审批主体组织（resolver 的 approval_subject_org_hrbp / head 取 recordDepartmentId）；无流程主体员工。
 * `discloseValues` 是披露裁剪的唯一实现：审批中心按节点勾选 ∩ 审批人查看权裁剪，10d 的读路径（路由 12～15）复用同一函数。
 */
import type { Tx } from '@italent/db';
import {
  APPROVAL_TYPES,
  ORG_ADJUSTMENT_HEADER_FIELDS,
  ORG_ADJUSTMENT_OBJECT_CODE,
  ORG_ADJUSTMENT_PROCESS_CODE,
  ORG_ADJUSTMENT_SECTION_FIELDS,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import type { BusinessSnapshot } from '../approval/adapters.js';
import { loadItems, type OrgItem } from './items-store.js';
import { loadAdjustment, type AdjustmentView } from './service.js';

type Values = Record<string, unknown>;
type ItemValue = { readonly itemId: string; readonly value: unknown };

const ITEM_PREFIX = 'orgItems.';
/** 引用本单新增行的列随对应的组织列披露：值写成 `{ itemRef }`，与已有组织 ID 区分。 */
const ITEM_REFS: Readonly<Record<string, keyof OrgItem>> = {
  parentOrgId: 'parentItemId',
  transferToOrgId: 'transferToItemId',
};

function itemValue(item: OrgItem, key: string): unknown {
  const own = item[key as keyof OrgItem];
  if (own !== null && own !== undefined) return own;
  const ref = ITEM_REFS[key];
  return ref && item[ref] ? { itemRef: item[ref] } : null;
}

/** 组织分区：编码 → 有值的行。暂存标记只在为 true 时算“有值”（未暂存是默认）。 */
export function orgSectionValues(items: readonly OrgItem[]): Record<string, ItemValue[]> {
  const section: Record<string, ItemValue[]> = {};
  for (const code of ORG_ADJUSTMENT_SECTION_FIELDS.orgItems) {
    const key = code.slice(ITEM_PREFIX.length);
    const rows = items
      .map((item) => ({ itemId: item.id, value: itemValue(item, key) }))
      .filter(({ value }) => value !== null && (key !== 'isStaged' || value === true));
    if (rows.length) section[code] = rows;
  }
  return section;
}

const headValues = (view: AdjustmentView): Values =>
  Object.fromEntries(ORG_ADJUSTMENT_HEADER_FIELDS.map((field) => [field, view[field] ?? null]));

const filled = (value: unknown) => value !== null && !(Array.isArray(value) && value.length === 0);

export function buildSnapshot(view: AdjustmentView, items: readonly OrgItem[]): BusinessSnapshot {
  const head = headValues(view);
  const section = orgSectionValues(items);
  return {
    approvalType: 'org_adjustment',
    businessType: 'org_adjustment',
    businessId: view.id,
    fieldObjectCode: ORG_ADJUSTMENT_OBJECT_CODE,
    profileFields: [],
    subjectEmployeeId: null,
    // 标题不含组织名等业务数据（DEC-057），单号足以区分
    title: `${APPROVAL_TYPES.org_adjustment.name}申请 ${view.code}`,
    values: { ...head, ...section },
    originals: null,
    changedFields: [...Object.keys(head).filter((field) => filled(head[field])), ...Object.keys(section)],
    conditionValues: {
      processCode: ORG_ADJUSTMENT_PROCESS_CODE,
      'adjustment.approvalSubjectOrgId': view.approvalSubjectOrgId,
    },
    latestDepartmentId: view.approvalSubjectOrgId,
    recordDepartmentId: view.approvalSubjectOrgId,
    version: `revision:${view.revision}`,
    processCode: ORG_ADJUSTMENT_PROCESS_CODE,
  };
}

export async function orgAdjustmentSnapshot(tx: Tx, tenantId: string, id: string): Promise<BusinessSnapshot> {
  const view = await loadAdjustment(tx, tenantId, id);
  if (!view) throw new AppError('NOT_FOUND', '组织调整申请不存在');
  return buildSnapshot(view, await loadItems(tx, tenantId, id));
}

/**
 * 披露裁剪：只留 `disclosed`（节点勾选 ∩ 查看权，调用方求交）里的编码。`undefined` 表示不受限（全部披露）。
 * 供 10d 的审批视角读路径复用，不另写一份。
 */
export function discloseValues(values: Readonly<Values>, disclosed: ReadonlySet<string> | undefined): Values {
  if (!disclosed) return { ...values };
  return Object.fromEntries(Object.entries(values).filter(([code]) => disclosed.has(code)));
}
