/**
 * 人员流动分析看板 6.25～6.32、3.1.36 的计算（docs/02_业务建模/35“补充：BE-13…”B50）。
 * 输入是 loadMovement 的同一份行集（已叠加数据范围与部门筛选）；每个组件只定义“计入谁”和“分到哪组”，
 * 数字、分组计数与明细都从这一份定义得出，按员工去重，数字 = 明细条数。流动情况报表（B54）共用期末、入职等工具；
 * 离职在看板按离职生效日（最后工作日 + 1）判断是否在职、归月（DEC-729），报表另按最后工作日归期。
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

/** 部门筛选含下级：按记录归属部门（时点取当天部门、离职取离职前部门、调动取调动后部门）在行政上级链里查找。 */
export function filterMovement(data: MovementData, tree: OrgTree, departmentId?: string): MovementData {
  if (!departmentId) return data;
  const inside = (m: { departmentId: string | null }) => tree.chain(m.departmentId).includes(departmentId);
  return {
    ...data,
    snapshots: new Map([...data.snapshots].map(([day, people]) => [day, people.filter(inside)])),
    exits: data.exits.filter(inside),
    hires: data.hires.filter(inside),
    transfers: data.transfers.filter(inside),
  };
}

/** 离职类型键：退休没有离职类型，归入“退休”；离职没填类型归入空值。 */
export const exitType = (e: MovementExit) =>
  e.kind === 'retirement'
    ? { key: MOVEMENT_RETIREMENT_TYPE.code, label: MOVEMENT_RETIREMENT_TYPE.name }
    : { key: e.typeCode ?? SEGMENT_NONE, label: e.typeName ?? e.typeCode ?? NONE_LABEL };
export const exitReason = (e: MovementExit) =>
  e.kind === 'retirement' || !e.reasonCode
    ? { key: SEGMENT_NONE, label: NONE_LABEL }
    : { key: e.reasonCode, label: e.reasonName ?? e.reasonCode };
const exitWhereabouts = (e: MovementExit) =>
  e.kind === 'retirement' || !e.whereaboutsCode
    ? { key: SEGMENT_NONE, label: NONE_LABEL }
    : { key: e.whereaboutsCode, label: e.whereaboutsName ?? e.whereaboutsCode };

export interface MovementLookup {
  readonly months: readonly MovementMonth[];
  readonly tree: OrgTree;
  readonly data: MovementData;
  /** asOf 时点的组织编制（已按部门筛选裁到所选组织及下级）。 */
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

/** 按出现的键分组：人数降序，空值段排最后。 */
function grouped<T extends Member>(items: readonly T[], keyOf: (item: T) => { key: string; label: string }) {
  const groups = new Map<string, { key: string; label: string; members: T[] }>();
  for (const item of items) {
    const { key, label } = keyOf(item);
    const group = groups.get(key) ?? { key, label, members: [] };
    group.members.push(item);
    groups.set(key, group);
  }
  const size = (g: { members: T[] }) => unique(g.members).length;
  return [...groups.values()].sort(
    (a, b) =>
      (a.key === SEGMENT_NONE ? 1 : 0) - (b.key === SEGMENT_NONE ? 1 : 0) ||
      size(b) - size(a) ||
      a.key.localeCompare(b.key),
  );
}

/** 两层分组（6.29 / 6.30）：先离职类型（parent = null），再“类型|原因（去向）”（parent = 类型）。 */
function twoLevel(exits: readonly MovementExit[], second: (e: MovementExit) => { key: string; label: string }) {
  return grouped(exits, exitType).flatMap((type) => [
    { ...type, parent: null },
    ...grouped(type.members, (e) => {
      const sub = second(e);
      return { key: `${type.key}|${sub.key}`, label: sub.label };
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
    members: x.data.transfers,
    groups: grouped(x.data.transfers, (t) =>
      t.typeCode
        ? { key: t.typeCode, label: x.data.transferTypes.get(t.typeCode) ?? t.typeCode }
        : { key: SEGMENT_NONE, label: NONE_LABEL },
    ),
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
  '6.29': (x) => ({ members: x.data.exits, groups: twoLevel(x.data.exits, exitReason) }),
  '6.30': (x) => ({ members: x.data.exits, groups: twoLevel(x.data.exits, exitWhereabouts) }),
  // 司龄算到最后工作日（离职时的累计司龄），固定 6 段 + 空值
  '6.31': (x) => ({
    members: x.data.exits,
    groups: [...TENURE_SEGMENTS, { key: SEGMENT_NONE, label: NONE_LABEL }].map(({ key, label }) => ({
      key,
      label,
      members: x.data.exits.filter((e) => tenureSegment(e.entryDate, e.lastWorkDate) === key),
    })),
  }),
  // 窗口 = 近 12 个自然月（含 asOf 所在月），司龄 ≤ 0.083 年（F-431②）；
  // ratio = 该部门人数 ÷ 近 12 个月“入职一个月内离职”的总人数（不是部门在职人数）
  '6.32': (x) => {
    const early = x.data.exits.filter((e) => withinOneMonth(e.entryDate, e.lastWorkDate));
    return {
      members: early,
      groups: grouped(early, (e) =>
        e.departmentId
          ? { key: e.departmentId, label: x.tree.name(e.departmentId) }
          : { key: SEGMENT_NONE, label: NONE_LABEL },
      ),
    };
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
