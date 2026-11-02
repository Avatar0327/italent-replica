/**
 * 人员流动分析看板 6.25～6.32、3.1.36 的计算（docs/02_业务建模/35“补充：BE-13…”B50）。
 * 输入是 loadMovement 的同一份行集（已叠加数据范围与部门筛选）；每个组件只定义“计入谁”和“分到哪组”，
 * 数字、分组计数与明细都从这一份定义得出，按员工去重，数字 = 明细条数。流动情况报表（B54）共用期末、入职等工具；
 * 离职在看板按离职生效日（最后工作日 + 1）判断是否在职、归月（DEC-729），报表另按最后工作日归期。
 * 按近 12 个月窗口计人数的组件（6.27、6.29～6.32）读 data.window（每人最后一条，见 hr-movement.ts attributeWindow），
 * 按月的组件（6.25 / 6.26 / 6.28）读原始行、每月内按员工去重。
 * 分组键：离职类型 / 原因 / 去向、调动类型这类“字典编码 + 空值”的分组，键是 JSON 元组（空值为 null），不用字符串哨兵，
 * 字典里真实存在的编码 none 不会与空值撞键（第 3 轮审查）；司龄段、部门、序列的空值仍用 SEGMENT_NONE（取值不可能是它）。
 */
import {
  HR_MOVEMENT_COMPONENTS,
  leaveRate,
  MOVEMENT_RETIREMENT_TYPE,
  SEGMENT_NONE,
  TENURE_SEGMENTS,
  tenureSegment,
  withinOneMonth,
  type HrMovementCode,
  type MovementMonth,
} from '@italent/domain';
import type { MovementData, MovementEstablishment, MovementExit } from './hr-movement.js';
import { ratio } from './hr-structure-board.js';
import type { OrgTree } from './hr-structure.js';

export interface Member {
  readonly employeeId: string;
  readonly departmentId: string | null;
}
export const NONE_LABEL = '空';

/** 同一员工在一个统计格里只算一次（与人事看板“本年入职 / 离职”按员工去重同口径），保留最早一条。 */
export function unique<T extends Member>(members: readonly T[]): T[] {
  const seen = new Set<string>();
  return members.filter((m) => !seen.has(m.employeeId) && !!seen.add(m.employeeId));
}
const within = (date: string, month: MovementMonth) => date >= month.start && date <= month.end;

/** 期初 = 当天时点在职 + 当天离职生效的人（最后工作日是前一天，期初仍在册，见规格“流动情况各报表的算法”）。 */
export function opening(data: MovementData, day: string): Member[] {
  return unique([...(data.snapshots.get(day) ?? []), ...data.exits.filter((e) => e.effectiveDate === day)]);
}
/** 期末 = 期间最后一天（本月为 asOf 当天）的时点在职人数。 */
export const closing = (data: MovementData, month: MovementMonth): Member[] =>
  unique(data.snapshots.get(month.end) ?? []);
export const hiresIn = (data: MovementData, month: MovementMonth) =>
  unique(data.hires.filter((h) => within(h.startDate, month)));
/** 看板的“当月离职”：离职生效日落在当月（报表按最后工作日，见 hr-movement-report.ts）。 */
export const exitsIn = (data: MovementData, month: MovementMonth) =>
  unique(data.exits.filter((e) => within(e.effectiveDate, month)));

/**
 * 部门筛选含下级：按记录归属部门（时点取当天部门、离职取离职前部门、调动取调动后部门）在行政上级链里查找。
 * 窗口归属在筛选之前已定（重聘跨部门时人只归最后一次离职的部门），筛选只裁剪不重算。
 */
export function filterMovement(data: MovementData, tree: OrgTree, departmentId?: string): MovementData {
  if (!departmentId) return data;
  const inside = (m: { departmentId: string | null }) => tree.chain(m.departmentId).includes(departmentId);
  return {
    ...data,
    snapshots: new Map([...data.snapshots].map(([day, people]) => [day, people.filter(inside)])),
    exits: data.exits.filter(inside),
    hires: data.hires.filter(inside),
    transfers: data.transfers.filter(inside),
    window: {
      exits: data.window.exits.filter(inside),
      hires: data.window.hires.filter(inside),
      transfers: data.window.transfers.filter(inside),
    },
  };
}

/** 字典编码类分组的一段：parts 组成 JSON 元组键，code 为 null 即空值（排最后）。 */
export interface CodeSegment {
  readonly parts: readonly (string | null)[];
  readonly label: string;
}
const segmentKey = (parts: readonly (string | null)[]) => JSON.stringify(parts);
const isEmpty = (parts: readonly (string | null)[]) => parts.at(-1) === null;
/** 字典编码：空串与 null 同为空值。 */
const codeOf = (value: string | null) => (value ? value : null);

/** 离职类型段：退休没有离职类型，单独一段 ["retirement"]；离职为 ["leave", 类型编码 | null]。 */
export const exitType = (e: MovementExit): CodeSegment =>
  e.kind === 'retirement'
    ? { parts: [MOVEMENT_RETIREMENT_TYPE.code], label: MOVEMENT_RETIREMENT_TYPE.name }
    : { parts: ['leave', codeOf(e.typeCode)], label: codeOf(e.typeCode) ? (e.typeName ?? e.typeCode!) : NONE_LABEL };
/** 离职原因 / 去向：退休没有，按空值；编码原样（不按字典改写大小写）。 */
export const exitReason = (e: MovementExit) => {
  const code = e.kind === 'retirement' ? null : codeOf(e.reasonCode);
  return { code, label: code ? (e.reasonName ?? code) : NONE_LABEL };
};
const exitWhereabouts = (e: MovementExit) => {
  const code = e.kind === 'retirement' ? null : codeOf(e.whereaboutsCode);
  return { code, label: code ? (e.whereaboutsName ?? code) : NONE_LABEL };
};

export interface MovementLookup {
  readonly months: readonly MovementMonth[];
  readonly tree: OrgTree;
  readonly data: MovementData;
  /** asOf 时点的组织编制（已按部门筛选裁到所选组织及下级）；只有看板与 3.1.36 明细加载，其余明细为空。 */
  readonly establishment: readonly MovementEstablishment[];
}
/** 编制表一行除人数以外的列；预增员 / 预减员 / 缺编数 / 执行率的取数接口尚未抽出（F-418），整列 null。 */
export interface EstablishmentColumns {
  readonly orgId: string;
  readonly localCapacity: number | null;
  readonly inclusiveCapacity: number | null;
  readonly pendingIn: null;
  readonly pendingOut: null;
  readonly vacancy: null;
  readonly executionRate: null;
}
interface Group {
  readonly key: string;
  readonly label: string;
  readonly members: readonly Member[];
  readonly parent?: string | null;
  readonly opening?: number;
  readonly closing?: number;
  readonly columns?: EstablishmentColumns;
}
/** members = null 表示组件只有按月分组、没有单一数值（series）。 */
interface Computed {
  readonly members: readonly Member[] | null;
  readonly groups: readonly Group[];
}

interface Keyed {
  readonly key: string;
  readonly label: string;
  /** 空值段，排最后。 */
  readonly empty: boolean;
}
/** 按出现的键分组：人数降序，空值段排最后。 */
function grouped<T extends Member>(items: readonly T[], keyOf: (item: T) => Keyed) {
  const groups = new Map<string, Keyed & { members: T[] }>();
  for (const item of items) {
    const keyed = keyOf(item);
    const group = groups.get(keyed.key) ?? { ...keyed, members: [] };
    group.members.push(item);
    groups.set(keyed.key, group);
  }
  const size = (g: { members: T[] }) => unique(g.members).length;
  return [...groups.values()]
    .sort((a, b) => Number(a.empty) - Number(b.empty) || size(b) - size(a) || a.key.localeCompare(b.key))
    .map(({ empty: _empty, ...group }) => group);
}
const bySegment = (segment: CodeSegment): Keyed => ({
  key: segmentKey(segment.parts),
  label: segment.label,
  empty: isEmpty(segment.parts),
});
const byId = (id: string | null, label: (id: string) => string): Keyed =>
  id ? { key: id, label: label(id), empty: false } : { key: SEGMENT_NONE, label: NONE_LABEL, empty: true };

/** 两层分组（6.29 / 6.30）：先离职类型（parent = null），再 [...类型, 原因（去向）| null]（parent = 类型键）。 */
function twoLevel(exits: readonly MovementExit[], second: (e: MovementExit) => { code: string | null; label: string }) {
  return grouped(exits, (e) => bySegment(exitType(e))).flatMap((type) => [
    { ...type, parent: null },
    ...grouped(type.members, (e) => {
      const sub = second(e);
      return bySegment({ parts: [...exitType(e).parts, sub.code], label: sub.label });
    }).map((group) => ({ ...group, parent: type.key })),
  ]);
}

const RULES: Readonly<Record<HrMovementCode, (x: MovementLookup) => Computed>> = {
  '6.25': (x) => ({
    members: null,
    groups: x.months.map((m) => ({ key: m.key, label: m.key, members: closing(x.data, m) })),
  }),
  '6.26': (x) => ({
    members: null,
    groups: x.months.flatMap((m) => [
      { key: `hire:${m.key}`, label: `${m.key} 入职`, members: hiresIn(x.data, m) },
      { key: `exit:${m.key}`, label: `${m.key} 离职`, members: exitsIn(x.data, m) },
    ]),
  }),
  '6.27': (x) => ({
    members: x.data.window.transfers,
    groups: grouped(x.data.window.transfers, (t) => {
      const code = codeOf(t.typeCode);
      return bySegment({ parts: [code], label: code ? (x.data.transferTypes.get(code) ?? code) : NONE_LABEL });
    }),
  }),
  '6.28': (x) => ({
    members: null,
    groups: x.months.map((m) => ({
      key: m.key,
      label: m.key,
      members: exitsIn(x.data, m),
      opening: opening(x.data, m.start).length,
      closing: closing(x.data, m).length,
    })),
  }),
  '6.29': (x) => ({ members: x.data.window.exits, groups: twoLevel(x.data.window.exits, exitReason) }),
  '6.30': (x) => ({ members: x.data.window.exits, groups: twoLevel(x.data.window.exits, exitWhereabouts) }),
  // 司龄算到最后工作日（离职时的累计司龄），固定 6 段 + 空值
  '6.31': (x) => ({
    members: x.data.window.exits,
    groups: [...TENURE_SEGMENTS, { key: SEGMENT_NONE, label: NONE_LABEL }].map(({ key, label }) => ({
      key,
      label,
      members: x.data.window.exits.filter((e) => tenureSegment(e.entryDate, e.lastWorkDate) === key),
    })),
  }),
  // 窗口 = 近 12 个自然月（含 asOf 所在月），司龄 ≤ 0.083 年（F-431②）；
  // ratio = 该部门人数 ÷ 近 12 个月“入职一个月内离职”的总人数（不是部门在职人数）；先取每人最后一次离职，再看它是否
  // 入职一个月内离职（司龄按那次离职所在任职周期的入职日期算）
  '6.32': (x) => {
    const early = x.data.window.exits.filter((e) => withinOneMonth(e.entryDate, e.lastWorkDate));
    return { members: early, groups: grouped(early, (e) => byId(e.departmentId, (id) => x.tree.name(id))) };
  },
  // 每个编制对象一组：实有人员 = asOf 时点在职（含下级），与 6.25 当月期末同一谓词
  '3.1.36': (x) => ({
    members: null,
    groups: x.establishment.map((e) => ({
      key: e.id,
      label: x.tree.name(e.orgId),
      members: actualStaff(x.data, x.months.at(-1)!.end, x.tree, e.orgId),
      columns: establishmentColumns(e),
    })),
  }),
};

/** 某组织（含下级）在 day 的时点在职人员。 */
export const actualStaff = (data: MovementData, day: string, tree: OrgTree, orgId: string) =>
  unique((data.snapshots.get(day) ?? []).filter((m) => tree.chain(m.departmentId).includes(orgId)));
export const establishmentColumns = (e: MovementEstablishment): EstablishmentColumns => ({
  orgId: e.orgId,
  localCapacity: e.localCapacity,
  inclusiveCapacity: e.inclusiveCapacity,
  pendingIn: null,
  pendingOut: null,
  vacancy: null,
  executionRate: null,
});

/** 部门筛选（含下级）下只列所选组织及其下级的编制对象。 */
export function filterEstablishment(
  rows: readonly MovementEstablishment[],
  tree: OrgTree,
  departmentId?: string,
): MovementEstablishment[] {
  return departmentId ? rows.filter((e) => tree.chain(e.orgId).includes(departmentId)) : [...rows];
}

/** 组件明细（group 给出时只取该组）；series / table 组件必须指定分组，返回 undefined 由路由报 400。 */
export function movementMembers(code: HrMovementCode, x: MovementLookup, group?: string): Member[] | undefined {
  const computed = RULES[code](x);
  if (group === undefined) return computed.members ? unique(computed.members) : undefined;
  return unique(computed.groups.find((g) => g.key === group)?.members ?? []);
}

/** 看板 9 个组件（与图形无关的数据）：value = 去重人数（series 为 null），groups 带各自的计数。 */
export function movementComponents(x: MovementLookup) {
  return HR_MOVEMENT_COMPONENTS.map((component) => {
    const computed = RULES[component.code](x);
    const value = computed.members ? unique(computed.members).length : null;
    const groups = computed.groups.map(({ members, columns, ...group }) => {
      const count = unique(members).length;
      if (columns) return { ...group, ...columns, count };
      if (component.code === '6.28')
        return { ...group, count, rate: leaveRate(count, group.opening ?? 0, group.closing ?? 0) };
      if (component.kind === 'ratio') return { ...group, count, ratio: ratio(count, value ?? 0) };
      return { ...group, count };
    });
    return { ...component, value, groups };
  });
}
