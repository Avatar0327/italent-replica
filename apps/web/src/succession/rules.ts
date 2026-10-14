/**
 * 继任页面的纯规则：只做校验与请求体组装，权威判定仍在服务端（docs/02_业务建模/27 §1.1、§5.5、§5.6）。
 * 本文件被页面登记（pages.ts）在 Node 侧引用，不能依赖 React 或浏览器 API。
 */
import type { MenuNode, ServerSnapshot } from '../foundation/permission-snapshot.js';
import { s } from './messages.js';
import type { LevelRules, MapItem, MapResult, Preferences, RecordView, RuleRow, SuccessionType } from './types.js';

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
  const ended = Array.isArray(items) ? (items as { id?: unknown }[]).map((item) => item?.id) : undefined;
  // 逐条核对且去重：重复的 id 不能顶替漏掉的记录。
  const covered = new Set(ended?.filter((id): id is string => typeof id === 'string' && ids.has(id)));
  if (!ended || ended.length !== ids.size || covered.size !== ids.size) throw new Error('endReceipt');
  return { id: END_RECEIPT };
}
/** 删除的真实回执是 {id, deleted: true}，按形状核对，不符判为结果未知。 */
export function deleteReceipt(response: unknown) {
  const view = response as { id?: unknown; deleted?: unknown } | null;
  if (typeof view?.id !== 'string' || view.deleted !== true) throw new Error('deleteReceipt');
  return { id: view.id };
}
export const PREFS_RECEIPT = 'preferences';
const isStrings = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === 'string');
/** 偏好回执按真实 DTO 逐项核对（map-routes.ts PUT /maps/:kind/preferences）；层级只有二到四级。 */
export function preferenceReceipt(response: unknown) {
  const view = response as Partial<Record<keyof Preferences, unknown>> | null;
  const valid =
    !!view &&
    (view.rootOrgId === null || typeof view.rootOrgId === 'string') &&
    Number.isInteger(view.depth) &&
    (view.depth as number) >= 2 &&
    (view.depth as number) <= 4 &&
    isStrings(view.hiddenOrgIds) &&
    typeof view.showKeyPositions === 'boolean' &&
    typeof view.showPositionsWithoutSuccessor === 'boolean' &&
    Number.isSafeInteger(view.revision) &&
    (view.revision as number) >= 0;
  if (!valid) throw new Error('preferenceReceipt');
  return { id: PREFS_RECEIPT };
}
/**
 * 偏好重读带回全量：抽屉外的隐藏组织、只看关键岗位也在里面，提交时未改项取这份最新值（preferenceBody）。
 * 差异只比较抽屉里能改的项（表单内核按 editableFields 比较）；未选组织根（null）与表单空值同为 undefined。
 */
export function preferenceLatest(view: Preferences) {
  preferenceReceipt(view);
  const { revision, rootOrgId, ...rest } = view;
  return { id: PREFS_RECEIPT, revision, values: { rootOrgId: rootOrgId ?? undefined, ...rest } };
}
/** 接口要整份偏好：用户改过的项取表单值，其余取最新读回的全量，不替用户改。 */
export function preferenceBody(full: Record<string, unknown>, edited: Record<string, unknown>) {
  const merged = { ...full, ...edited };
  return {
    rootOrgId: (merged.rootOrgId as string | undefined) ?? null,
    hiddenOrgIds: merged.hiddenOrgIds,
    showKeyPositions: merged.showKeyPositions,
    depth: Number(merged.depth),
    showPositionsWithoutSuccessor: !!merged.showPositionsWithoutSuccessor,
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

/**
 * 规则只读展示：表达式原样，条件行拼成一句话（docs/02_业务建模/27 §5.9）。
 * 有限定条件时显示“字段 运算 值 的 指标”，健康度规则另显示字段来源与自定义人员范围（B2_12 / B2_17）。
 */
export function ruleLines(
  rules: LevelRules | null | undefined,
  populations: Record<string, string> = {},
): { expression: string; rows: string[] } | undefined {
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
  const scope = (row: RuleRow) => {
    if (row.population !== 'custom' || !row.populationId) return text(labels.population, row.population);
    const name = populations[row.populationId];
    return name
      ? labels.text!.namedPopulation!.replace('{name}', name)
      : labels.text!.unnamedPopulation!.replace('{id}', row.populationId);
  };
  const rows = rules.rows.map((row) =>
    [
      `${row.rowNo}.`,
      scope(row),
      text(labels.subject, row.subject),
      text(labels.fieldSource, row.fieldSource),
      row.field?.label ?? row.field?.code ?? row.fieldCode ?? '',
      text(labels.comparator, row.filterOperator),
      row.filterValues?.join('、') ?? '',
      row.filterOperator ? labels.text!.of! : '',
      text(labels.measure, row.measure),
      text(labels.comparator, row.comparator ?? row.operator),
      value(row),
    ]
      .filter(Boolean)
      .join(' '),
  );
  return { expression: rules.expression ?? '', rows };
}

/**
 * 继任类型字段隐藏时列表是两类混合（recordQuery 不带类型参数）：按目标字段的值推断记录自身的类型。
 * 真实投影两个目标 ID 都回、另一类为 null，所以只认非空值；两类证据都缺或都有时返回 undefined，
 * 页面标“无法区分”，不猜（后端缺口清单）。
 */
export function recordKind(row: RecordView): SuccessionType | undefined {
  if (row.successionType) return row.successionType;
  const has = (...values: unknown[]) => values.some((value) => value !== undefined && value !== null);
  const position = has(row.targetPositionId, row.targetPosition, row.incumbents);
  const org = has(row.targetOrgId, row.targetOrg, row.personInCharge);
  if (position === org) return undefined;
  return position ? 'position' : 'org';
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
