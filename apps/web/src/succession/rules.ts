/**
 * 继任页面的纯规则：只做校验与请求体组装，权威判定仍在服务端（docs/02_业务建模/27 §1.1、§5.5、§5.6）。
 * 本文件被页面登记（pages.ts）在 Node 侧引用，不能依赖 React 或浏览器 API。
 */
import type { MenuNode, ServerSnapshot } from '../foundation/permission-snapshot.js';
import { s } from './messages.js';
import type { LevelRules, MapItem, MapResult, Preferences, RuleRow, SuccessionType } from './types.js';

export const BASE = '/api/tenant/succession';
export const READINESS_PATH = '/api/tenant/talent-review/readiness-levels';
export const END_LIMIT = 200;

type DateField = 'startDate' | 'endDate';
/** SC-R2：开始、结束都不得晚于租户今天；结束不得早于开始。今天未知时不放行。 */
export function recordDateErrors(
  values: { startDate?: string | null; endDate?: string | null },
  today: string | undefined,
): Partial<Record<DateField, string>> {
  if (!today) return { startDate: 'todayUnknown' };
  const errors: Partial<Record<DateField, string>> = {};
  if (values.startDate && values.startDate > today) errors.startDate = 'startFuture';
  if (values.endDate && values.endDate > today) errors.endDate = 'endFuture';
  else if (values.endDate && values.startDate && values.endDate < values.startDate) errors.endDate = 'endBeforeStart';
  return errors;
}

const filled = (value: unknown) => value !== undefined && value !== null && value !== '';
const choiceValue = (value: unknown) =>
  value && typeof value === 'object' && 'value' in value ? (value as { value: unknown }).value : value;

/** 新增继任：目标按类型二选一；继任者来自人员选择（带标签）或直接 ID；空值不发送，交给服务端默认。 */
export function createRecordBody(type: SuccessionType, values: Record<string, unknown>) {
  const reason = typeof values.endReason === 'string' ? values.endReason.trim() : undefined;
  const body: Record<string, unknown> = {
    successionType: type,
    [type === 'position' ? 'targetPositionId' : 'targetOrgId']: values.targetId,
    successorEmployeeId: choiceValue(values.successor),
    readinessId: values.readinessId,
    backupType: values.backupType,
    startDate: values.startDate,
    endDate: values.endDate,
    endReason: reason,
  };
  return Object.fromEntries(Object.entries(body).filter(([, value]) => filled(value)));
}

/** SC-R3 批量结束：只收在用记录，逐条带期望版本；上限与服务端一致（≤ 200）。 */
export function endCommand(
  rows: readonly { id: string; revision: number; status?: string }[],
  endDate: string,
  reason: string | undefined,
) {
  const items = rows
    .filter((row) => row.status !== 'ended')
    .map((row) => ({ id: row.id, expectedRevision: row.revision }));
  if (items.length === 0) throw new Error('endNone');
  if (items.length > END_LIMIT) throw new Error('endTooMany');
  const endReason = reason?.trim();
  return { items, endDate, ...(endReason ? { endReason } : {}) };
}

/** Q-M0-178：按规则计算 = levelId null（服务端按规则重算）；手动赋值必须指定等级。 */
export function assignBody(mode: 'rule' | 'manual', levelId: string | undefined) {
  if (mode === 'rule') return { levelId: null };
  if (!levelId) throw new Error('levelRequired');
  return { levelId };
}

/**
 * 表单内核要求回执带业务 ID；下面两类接口的真实回执没有顶层 id，按各自形状核对后给出固定键。
 * 形状不符一律抛错，由内核判为结果未知（DEC-067 幂等：先回查再决定是否重提）。
 */
export const END_RECEIPT = 'records/end';
export function endReceipt(response: unknown, submitted: readonly { id: string }[]) {
  const items = (response as { items?: unknown } | null)?.items;
  const ids = new Set(submitted.map((item) => item.id));
  const ended = Array.isArray(items) ? (items as { id?: unknown }[]) : undefined;
  if (!ended || ended.length !== ids.size || !ended.every((item) => typeof item?.id === 'string' && ids.has(item.id)))
    throw new Error('endReceipt');
  return { id: END_RECEIPT };
}
export const PREFS_RECEIPT = 'preferences';
const preferenceKeys = ['depth', 'showPositionsWithoutSuccessor', 'rootOrgId'] as const;
export function preferenceReceipt(response: unknown) {
  const view = response as Partial<Preferences> | null;
  if (!Number.isSafeInteger(view?.revision) || !Number.isSafeInteger(view?.depth)) throw new Error('preferenceReceipt');
  return { id: PREFS_RECEIPT };
}
/** 偏好重读：只比较抽屉里能改的三项；未选组织根（null）与表单空值同为 undefined，避免误报差异。 */
export function preferenceLatest(view: Preferences) {
  preferenceReceipt(view);
  return {
    id: PREFS_RECEIPT,
    revision: view.revision,
    values: Object.fromEntries(preferenceKeys.map((key) => [key, view[key] ?? undefined])),
  };
}
/** 赋值没有单条读取接口：重读整张地图，按节点 ID 取结果行；未评定时版本为 0。 */
export function assignLatest(map: MapResult, id: string, kind: 'position' | 'org') {
  const items = map.items.flatMap((item) => [item, ...(item.keyPositions ?? [])]);
  const item = items.find((entry) => entry.id === id);
  if (!item) throw new Error('assignMissing');
  const level = kind === 'position' ? item.risk : item.health;
  return { id, revision: level?.revision ?? 0, values: assignValues(level?.levelId) };
}
export const assignValues = (levelId?: string | null) => ({
  mode: levelId ? 'manual' : 'rule',
  levelId: levelId ?? undefined,
});

/** 组织地图：关键职位挂在所属组织下，作为子卡片（接口 keyPositions[]，字段受地图对象权限控制）。 */
export function orgMapItems(items: readonly MapItem[]): MapItem[] {
  return items.flatMap((item) => [
    item,
    ...(item.keyPositions ?? []).map((position) => ({ ...position, parentId: item.id, keyPosition: true })),
  ]);
}

/** 规则只读展示：表达式原样，条件行拼成一句话（docs/02_业务建模/27 §5.9）。 */
export function ruleLines(rules: LevelRules | null | undefined): { expression: string; rows: string[] } | undefined {
  if (!rules?.rows?.length) return undefined;
  const labels = s.rules;
  const text = (map: Record<string, string> | undefined, key?: string | null) => (key ? (map?.[key] ?? key) : '');
  const value = (row: RuleRow) => {
    const unit = row.isPercent ? '%' : '';
    const low = row.threshold ?? row.values?.join('、') ?? '';
    return row.thresholdHigh !== undefined && row.thresholdHigh !== null
      ? `${low}${unit} ~ ${row.thresholdHigh}${unit}`
      : `${low}${unit}`;
  };
  const rows = rules.rows.map((row) =>
    [
      `${row.rowNo}.`,
      text(labels.population, row.population),
      text(labels.subject, row.subject),
      row.field?.label ?? row.field?.code ?? row.fieldCode ?? '',
      text(labels.measure, row.measure),
      text(labels.comparator, row.comparator ?? row.operator),
      value(row),
    ]
      .filter(Boolean)
      .join(' '),
  );
  return { expression: rules.expression ?? '', rows };
}

export interface MapNode<T> {
  item: T;
  children: MapNode<T>[];
}
/** SC-R8：父节点不在结果里（被裁剪或本身就是根）的都作为根；成环数据按首次出现截断。 */
export function mapForest<T extends { id: string; parentId: string | null }>(items: readonly T[]): MapNode<T>[] {
  const ids = new Set(items.map((item) => item.id));
  const children = new Map<string, T[]>();
  for (const item of items)
    if (item.parentId && ids.has(item.parentId))
      children.set(item.parentId, [...(children.get(item.parentId) ?? []), item]);
  const placed = new Set<string>();
  const build = (item: T): MapNode<T> => {
    placed.add(item.id);
    const nodes: MapNode<T>[] = [];
    for (const child of children.get(item.id) ?? []) if (!placed.has(child.id)) nodes.push(build(child));
    return { item, children: nodes };
  };
  const roots = items.filter((item) => !item.parentId || !ids.has(item.parentId)).map(build);
  // 成环的节点没有根可挂，从环上第一个未放置的节点断开。
  for (const item of items) if (!placed.has(item.id)) roots.push(build(item));
  return roots;
}

/** 列表查询：筛选字段对当前人隐藏时不发送，否则服务端返回 403 FILTER_FIELD_HIDDEN。 */
export function recordQuery(
  query: {
    type: SuccessionType;
    page: number;
    pageSize: number;
    status?: string;
    targetId?: string;
    successorEmployeeId?: string;
  },
  visible: (field: string) => boolean,
) {
  const params = new URLSearchParams({ page: String(query.page), pageSize: String(query.pageSize) });
  // 类型字段被隐藏时两张表读到的是混合列表，由服务端按权限裁剪（未决 / 假设）。
  if (visible('successionType')) params.set('successionType', query.type);
  if (visible('status')) params.set('status', query.status ?? 'active');
  const target = query.type === 'position' ? 'targetPositionId' : 'targetOrgId';
  if (query.targetId && visible(target)) params.set(target, query.targetId);
  if (query.successorEmployeeId && visible('successorEmployeeId'))
    params.set('successorEmployeeId', query.successorEmployeeId);
  return params.toString();
}

/**
 * 菜单下一层（原站「继任与发展 > 继任管理」与「设置 > …」）：只列快照入口对象里有的设置页，可见性仍由服务端给出。
 * 准备度字典归人才盘点应用（DEC-301①），看人才盘点的入口对象。
 */
export function settingsMenu(snapshot: ServerSnapshot): MenuNode[] {
  const objects = (app: string) => snapshot.apps.find((item) => item.app === app)?.entryObjects ?? [];
  const succession = objects('succession');
  const node = (key: keyof typeof s.menu, path: string) => ({ key: path, label: s.menu[key], path, group: 'talent' });
  return [
    node('manage', '/succession/manage'),
    ...(succession.includes('Succession.RiskLevel') ? [node('mapSettings', '/succession/settings/map')] : []),
    // 原站“健康度规则设置”是独立页：人员范围 + 继任地图健康度（UI2 对照）。
    ...(['Succession.HealthLevel', 'Succession.Population'].some((code) => succession.includes(code))
      ? [node('healthSettings', '/succession/settings/health')]
      : []),
    node('keyPositions', '/succession/settings/key-positions'),
    ...(objects('talent-review').includes('TalentReview.Readiness')
      ? [node('readiness', '/succession/settings/readiness')]
      : []),
  ];
}
