import { slotKey } from '../foundation/forms/slot.js';
import { canButton, fieldAccess, type FieldAccess, type ObjectPermission } from '../foundation/permission-model.js';
import { detailText, listText, pageText as m } from './messages.js';
export interface OrgRow {
  id: string;
  revision: number;
  name?: string;
  code?: string;
  enabled?: boolean;
  parents?: Partial<Record<Dimension, { parentId: string | null; sequence?: number | null }>>;
  [field: string]: unknown;
}
export type Dimension = 'admin' | 'business' | 'product';
export const orgObject = 'TenantBase.Organization';
/** F-123 / F-142：新建用集合路径作恢复槽（slotKey），不随入口、上级或日期变化；未确认的新建命令锁住所有新建入口。 */
export const orgCreateResource = slotKey('/api/tenant/org/organizations');
/** 新建表单只用一个业务时点：有日期编辑权取所选日期，否则取服务端默认的租户当天，不提交无权字段（DEC-130）。 */
export function orgCreateDate(selected: string, today: string, access: FieldAccess) {
  return access.visible && access.editable ? selected : today;
}
export interface OrgNode {
  key: string;
  value: string;
  title: string;
  children: OrgNode[];
}
export function organizationTree(rows: OrgRow[], dimension: Dimension): OrgNode[] {
  const nodes = new Map(
    rows.map((row) => [
      row.id,
      {
        key: row.id,
        value: row.id,
        title: row.name ?? m.unavailable,
        children: [] as OrgNode[],
      },
    ]),
  );
  const parents = new Map(rows.map((row) => [row.id, row.parents?.[dimension]?.parentId]));
  const roots: OrgNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id)!;
    const parent = parents.get(row.id);
    const seen = new Set([row.id]);
    let cursor = parent;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = parents.get(cursor);
    }
    if (parent && nodes.has(parent) && !cursor) nodes.get(parent)!.children.push(node);
    else roots.push(node);
  }
  return roots;
}
export function orgChangeBody(original: OrgRow, values: Record<string, unknown>, effectiveDate: string) {
  const { addEmployment, adminParent, businessParent, productParent, ...fields } = values;
  const body: Record<string, unknown> = { effectiveDate };
  for (const [key, raw] of Object.entries(fields)) {
    const value = key === 'name' && typeof raw === 'string' ? raw.trim() : raw;
    if (value !== undefined && value !== original[key]) body[key] = value;
  }
  const parents: OrgRow['parents'] = {};
  for (const [dimension, value] of Object.entries({
    admin: adminParent,
    business: businessParent,
    product: productParent,
  })) {
    const key = dimension as Dimension;
    if (typeof value === 'string' && value.toLowerCase() !== original.parents?.[key]?.parentId) {
      parents[key] = { parentId: value.toLowerCase(), sequence: original.parents?.[key]?.sequence ?? null };
    }
  }
  if (Object.keys(parents).length) body.parents = parents;
  if (body.name !== undefined || parents.admin) {
    if (typeof addEmployment !== 'boolean') throw new Error(m.choiceRequired);
    body.addEmployment = addEmployment;
  }
  return body;
}

export function pageAccess(permission: ObjectPermission | undefined) {
  return {
    readable: !!permission,
    field: (name: string) => fieldAccess(permission, name),
    can: (button: string, level = 'detail') =>
      canButton(permission, button, level) &&
      (!['create', 'update', 'delete'].includes(button) || permission?.dataOperations[button] === true),
  };
}

type FieldGate = Pick<ReturnType<typeof pageAccess>, 'field'>;
// 原站「启用的组织」默认列序；状态由视图与筛选体现，默认不成列（可在设置显示字段里加）。
export const listFields = [
  'code',
  'name',
  'fullName',
  'location',
  'broadType',
  'establishedOn',
  'startDate',
  'stopDate',
];
// 原站组织单元详情：组织全称排在基本信息最后。
const detailFields = [
  'code',
  'name',
  'location',
  'broadType',
  'establishedOn',
  'startDate',
  'stopDate',
  'enabled',
  'personInChargeId',
  'fullName',
  'remarks',
];
export function orgListFields(access: FieldGate) {
  return listFields.filter((field) => access.field(field).visible);
}
export function orgDetailFields(access: FieldGate) {
  return detailFields.filter((field) => access.field(field).visible);
}
/** 原站同一字段在列表与详情上叫法不同（如建立日期 / 设立日期）。 */
export function orgLabel(field: string, place: 'list' | 'detail') {
  const own: Record<string, string> = place === 'list' ? listText : detailText;
  return own[field] ?? m[field as keyof typeof m] ?? field;
}
/** 新建与新建下级共用：须有新建数据权、列表「新建」按钮，且名称与上级可编辑（接口要求行政维度上级）。 */
export function orgCreatable(access: ReturnType<typeof pageAccess>) {
  return access.can('create', 'list') && access.field('name').editable && access.field('parents').editable;
}
/**
 * 导入入口：服务端先查 import@list 按钮，再逐行按新建 / 更新校验字段写权（apps/api 组织导入）；
 * 前端按同一口径收紧，必填列（编码、名称、上级）不可写时不出入口（DEC-502①c）。
 */
export function orgImportable(access: ReturnType<typeof pageAccess>) {
  return access.can('import', 'list') && ['code', 'name', 'parents'].every((name) => access.field(name).editable);
}
/** 新建请求体：只发有值的字段，ID 统一小写，上级放进 parents.admin（apps/api 新建组织契约）。 */
export function orgCreateBody(values: Record<string, unknown>) {
  const { adminParent, ...fields } = values;
  const body: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(fields)) {
    const value = typeof raw === 'string' ? raw.trim() : raw;
    if (value === undefined || value === null || value === '') continue;
    body[key] = key.endsWith('Id') && typeof value === 'string' ? value.toLowerCase() : value;
  }
  if (typeof adminParent === 'string' && adminParent) body.parents = { admin: { parentId: adminParent.toLowerCase() } };
  return body;
}
export interface OrgCatalogFilters {
  asOf: string;
  dimension: string;
  page: number;
  pageSize: number;
  includeDisabled: boolean;
  name: string;
}
/** 无名称查看权时不按名称筛选，避免借筛选结果探测被裁剪的名称。 */
export function orgCatalogQuery(filters: OrgCatalogFilters, nameVisible: boolean) {
  return new URLSearchParams({
    asOf: filters.asOf,
    dimension: filters.dimension,
    page: String(filters.page),
    pageSize: String(filters.pageSize),
    includeDisabled: String(filters.includeDisabled),
    ...(nameVisible && filters.name ? { name: filters.name } : {}),
  }).toString();
}
export type OrgAction = 'edit' | 'change' | 'disable';
/** 行操作与详情按钮共用：编辑只更正设立日期（DEC-147），变更 / 停用须能填生效日期。 */
export function orgActions(access: ReturnType<typeof pageAccess>, row: OrgRow): OrgAction[] {
  if (!access.can('update')) return [];
  const actions: OrgAction[] = [];
  if (access.field('establishedOn').editable) actions.push('edit');
  if (access.field('effectiveDate').editable) {
    actions.push('change');
    if (access.field('enabled').editable && row.enabled === true) actions.push('disable');
  }
  return actions;
}
