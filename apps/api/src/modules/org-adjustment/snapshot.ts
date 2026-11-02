/**
 * 组织调整的审批快照（R2-T08 §4.5，BE-10c）：头（含调整范围）+ 组织分区；调动 / 职位 / 编制 / 兼职分区不在本片。
 * - 头字段按编码直接取值；组织分区每个编码一份 `[{ itemId, value }]`，只列本单相对基线实际有变化的行（编码按
 *   itemId，与行序无关），另带 `orgItems.count`（明细行数，不是表单字段，不进变化字段）；
 * - 原值：改组织行按建行基线版本（base_version_id）取组织字段的原值，`originals` 同形 `[{ itemId, value: 基线值 }]`；
 *   头不存基线，不给头原值（偏离 §4.5，见 PR 偏离清单）；
 * - 变化字段：头里有值的字段 + 明细里相对基线实际变化的编码（新增行 = 全部非空字段；行身份 adjustType /
 *   targetOrgId 总算）——审批人看不到其中任一即盲审（DEC-058）；
 * - 路由部门 = 审批主体组织（resolver 的 approval_subject_org_hrbp / head 取 recordDepartmentId）；无流程主体员工。
 * `discloseValues` 是披露裁剪的唯一实现：审批中心按节点勾选 ∩ 审批人查看权裁剪，10d 的读路径（路由 12～15）复用同一函数。
 */
import { sql, type Tx } from '@italent/db';
import {
  APPROVAL_TYPES,
  ORG_ADJUSTMENT_HEADER_FIELDS,
  ORG_ADJUSTMENT_OBJECT_CODE,
  ORG_ADJUSTMENT_PROCESS_CODE,
  ORG_ADJUSTMENT_SECTION_FIELDS,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import type { BusinessSnapshot } from '../approval/adapters.js';
import { rowsOf } from '../org/read-model.js';
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

/** 建行基线版本上可比较的组织字段（行政上级取 admin 维度）；不在这里的明细列没有原值。 */
type Baseline = Readonly<Record<string, unknown>>;
const IDENTITY_KEYS = new Set(['adjustType', 'targetOrgId']);

/** 某行某列相对基线是否有变化：行身份总算；暂存只在 true 时算；有基线的列与基线不同才算；其它列非空即算。 */
function changed(item: OrgItem, key: string, value: unknown, base: Baseline | undefined): boolean {
  if (IDENTITY_KEYS.has(key)) return value !== null;
  if (value === null) return false;
  if (key === 'isStaged') return value === true;
  if (!base || !(key in base)) return true;
  if (key === 'parentOrgId' && item.parentItemId) return true;
  return value !== base[key];
}

/** 组织分区：编码 → 有变化的行 + 对应基线原值。 */
function orgSection(items: readonly OrgItem[], baselines: ReadonlyMap<string, Baseline>) {
  const values: Record<string, ItemValue[]> = {};
  const originals: Record<string, ItemValue[]> = {};
  for (const code of ORG_ADJUSTMENT_SECTION_FIELDS.orgItems) {
    const key = code.slice(ITEM_PREFIX.length);
    for (const item of items) {
      const value = itemValue(item, key);
      const base = item.baseVersionId ? baselines.get(item.baseVersionId) : undefined;
      if (!changed(item, key, value, base)) continue;
      (values[code] ??= []).push({ itemId: item.id, value });
      if (base && key in base) (originals[code] ??= []).push({ itemId: item.id, value: base[key] ?? null });
    }
  }
  return { values, originals };
}

const headValues = (view: AdjustmentView): Values =>
  Object.fromEntries(ORG_ADJUSTMENT_HEADER_FIELDS.map((field) => [field, view[field] ?? null]));

const filled = (value: unknown) => value !== null && !(Array.isArray(value) && value.length === 0);

export function buildSnapshot(
  view: AdjustmentView,
  items: readonly OrgItem[],
  baselines: ReadonlyMap<string, Baseline>,
): BusinessSnapshot {
  const head = headValues(view);
  const section = orgSection(items, baselines);
  return {
    approvalType: 'org_adjustment',
    businessType: 'org_adjustment',
    businessId: view.id,
    fieldObjectCode: ORG_ADJUSTMENT_OBJECT_CODE,
    profileFields: [],
    subjectEmployeeId: null,
    // 标题不含组织名等业务数据（DEC-057），单号足以区分
    title: `${APPROVAL_TYPES.org_adjustment.name}申请 ${view.code}`,
    values: { ...head, ...section.values, 'orgItems.count': items.length },
    originals: Object.keys(section.originals).length ? section.originals : null,
    changedFields: [...Object.keys(head).filter((field) => filled(head[field])), ...Object.keys(section.values)],
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

interface BaselineRow {
  id: string;
  name: string;
  code: string;
  short_name: string | null;
  parent_org_id: string | null;
  display_order: number | null;
  level: number;
  person_in_charge_id: string | null;
  hrbp_id: string | null;
}

/** 各行建行时的基线版本（base_version_id）上的组织字段。 */
async function loadBaselines(tx: Tx, tenantId: string, items: readonly OrgItem[]) {
  const ids = [...new Set(items.flatMap((item) => (item.baseVersionId ? [item.baseVersionId] : [])))];
  if (!ids.length) return new Map<string, Baseline>();
  const rows = rowsOf<BaselineRow>(
    await tx.execute(sql`SELECT v.id, v.name, v.code, v.short_name, l.parent_org_id, v.display_order, v.level,
        v.person_in_charge_id, v.hrbp_id
      FROM org_versions v LEFT JOIN org_hierarchy_links l
        ON l.tenant_id = v.tenant_id AND l.version_id = v.id AND l.dimension = 'admin'
      WHERE v.tenant_id = ${tenantId} AND v.id = ANY(${`{${ids.join(',')}}`}::uuid[])`),
  );
  return new Map(
    rows.map((row): [string, Baseline] => [
      row.id,
      {
        name: row.name,
        code: row.code,
        shortName: row.short_name,
        parentOrgId: row.parent_org_id,
        displayOrder: row.display_order,
        level: row.level,
        personInChargeId: row.person_in_charge_id,
        hrbpId: row.hrbp_id,
      },
    ]),
  );
}

export async function orgAdjustmentSnapshot(tx: Tx, tenantId: string, id: string): Promise<BusinessSnapshot> {
  const view = await loadAdjustment(tx, tenantId, id);
  if (!view) throw new AppError('NOT_FOUND', '组织调整申请不存在');
  const items = await loadItems(tx, tenantId, id);
  return buildSnapshot(view, items, await loadBaselines(tx, tenantId, items));
}

/**
 * 披露裁剪：只留 `disclosed`（节点勾选 ∩ 查看权，调用方求交）里的编码。`undefined` 表示不受限（全部披露）。
 * 供 10d 的审批视角读路径复用，不另写一份。
 */
export function discloseValues(values: Readonly<Values>, disclosed: ReadonlySet<string> | undefined): Values {
  if (!disclosed) return { ...values };
  return Object.fromEntries(Object.entries(values).filter(([code]) => disclosed.has(code)));
}
