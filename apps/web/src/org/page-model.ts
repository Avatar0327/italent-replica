import { slotKey } from '../foundation/forms/slot.js';
import { canButton, fieldAccess, type FieldAccess, type ObjectPermission } from '../foundation/permission-model.js';
import { orgImportRequired } from './import-model.js';
import { chartText, detailText, listText, pageText as m } from './messages.js';
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
/** 服务端按查看人范围组装的树节点（GET organizations/tree、chart）；字段按字段权限裁剪，缺省即无权查看。 */
export interface ServerOrgNode {
  id: string;
  name?: string;
  code?: string;
  enabled?: boolean;
  headcount?: number;
  establishment?: number | null;
  /** 仅 chart：有「负责人」查看权才有此键；范围外负责人也只给姓名，无姓名为 null。 */
  personInChargeName?: string | null;
  children: ServerOrgNode[];
}
export interface ServerOrgTree {
  roots: ServerOrgNode[];
  total: number;
  hasDataPermission: boolean;
}
/** 服务端树 → 左侧树控件数据；层级由服务端决定，前端不再自行拼接（范围外上级不伪造）。 */
export function serverTreeData(roots: readonly ServerOrgNode[]): OrgNode[] {
  return roots.map((node) => ({
    key: node.id,
    value: node.id,
    title: node.name ?? m.unavailable,
    children: serverTreeData(node.children),
  }));
}
/** 树 / 架构图的查询串：与列表同一组筛选，不带分页（完整树）；无名称查看权不带名称（同 orgCatalogQuery）。 */
export function orgTreeQuery(filters: Omit<OrgCatalogFilters, 'page' | 'pageSize'>, nameVisible: boolean) {
  return new URLSearchParams({
    asOf: filters.asOf,
    dimension: filters.dimension,
    includeDisabled: String(filters.includeDisabled),
    ...(nameVisible && filters.name ? { name: filters.name } : {}),
  }).toString();
}
/** 卡片上的在岗 / 编制：与原站卡片同写法「在岗2/编制4」；无查看权的项不出，编制未设置显示占位（R1a §2.3）。 */
export function chartFigures(node: Pick<ServerOrgNode, 'headcount' | 'establishment'>) {
  const parts = [
    node.headcount === undefined ? null : `${chartText.onDuty}${node.headcount}`,
    node.establishment === undefined ? null : `${chartText.establishment}${node.establishment ?? chartText.none}`,
  ];
  return parts.filter((part) => part !== null).join('/');
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
    /** 只看数据操作权、不看按钮：组织导入逐行只按新建 / 更新数据权与字段写权校验（apps/api 组织导入 writeFields）。 */
    writes: (operation: 'create' | 'update') => permission?.dataOperations[operation] === true,
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
  // 原站在岗人数排在人员列之后（未在本表出现的列之间），本表没有负责人等列，故排在末尾（位置按原站相对顺序，未验证绝对位置）。
  'headcount',
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
 * 导入入口：服务端先查 import@list 按钮，再逐行按新建 / 更新数据权与该行字段写权校验（apps/api 组织导入 writeFields，
 * 字段即行内去掉控制项的列）。前端按同一口径收紧：两种数据权都没有、或每行都要写的列不可写时不出入口（DEC-502①c）；
 * 逐行判断见 import-model.ts importRowsDenied。
 */
export function orgImportable(access: ReturnType<typeof pageAccess>) {
  return (
    access.can('import', 'list') &&
    (access.writes('create') || access.writes('update')) &&
    orgImportRequired.every((name) => access.field(name).editable)
  );
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
