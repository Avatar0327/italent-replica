/**
 * 九宫格聚合的视图装配（设计 §2.2）：九宫格行 + 位置字段占用、轴分段、格子、比例规则组（含规则与格子集合）。
 * 列表与详情共用 withChildren：一次查出这批九宫格的全部子数据，按九宫格归位；比例规则组带稳定 id（项目按它引用）。
 */
import {
  and,
  asc,
  eq,
  inArray,
  talentReviewMatrices as M,
  talentReviewMatrixAxisLevels as L,
  talentReviewMatrixCells as C,
  talentReviewMatrixPositionFields as P,
  talentReviewRatioRuleCells as RC,
  talentReviewRatioRuleGroups as G,
  talentReviewRatioRules as R,
  type Tx,
} from '@italent/db';
import type { ConfigSpec, ConfigTable } from './config-kit.js';

const row = {
  id: M.id,
  code: M.code,
  name: M.name,
  xFieldId: M.xFieldId,
  yFieldId: M.yFieldId,
  zFieldId: M.zFieldId,
  xDraggable: M.xDraggable,
  yDraggable: M.yDraggable,
  placementSource: M.placementSource,
  greenRateReference: M.greenRateReference,
  preset: M.preset,
  sortNo: M.sortNo,
  enabled: M.enabled,
  revision: M.revision,
  createdBy: M.createdBy,
  createdAt: M.createdAt,
  updatedBy: M.updatedBy,
  updatedAt: M.updatedAt,
};
export type MatrixRow = Omit<typeof M.$inferSelect, 'tenantId'>;
export interface RatioRuleView {
  readonly operator: string;
  readonly pctLow: number;
  readonly pctHigh: number | null;
  readonly cellNos: number[];
}
export interface RatioGroupView {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly controlScope: string;
  readonly controlMode: string;
  readonly minPopulation: number;
  readonly sortNo: number;
  readonly rules: RatioRuleView[];
}
export type MatrixView = MatrixRow & {
  id: string;
  name: string;
  positionFields: { role: string; fieldId: string }[];
  axisLevels: { axis: string; levelNo: number; name: string; optionValues: string[]; lowerBound: number | null }[];
  cells: { cellNo: number; xLevelNo: number; yLevelNo: number; name: string; color: string; countsGreen: boolean }[];
  ratioGroups: RatioGroupView[];
};

export const MATRIX: ConfigSpec<MatrixView> = {
  object: 'matrix',
  label: '九宫格',
  table: M as unknown as ConfigTable,
  view: row,
  orderBy: [M.sortNo, M.code],
  duplicate: 'MATRIX_DUPLICATE',
  inUse: 'MATRIX_IN_USE',
  load: async (tx, tenantId, id) => (await withChildren(tx, tenantId, await selectRows(tx, tenantId, [id])))[0],
};

const selectRows = (tx: Tx, tenantId: string, ids: string[]) =>
  tx
    .select(row)
    .from(M)
    .where(and(eq(M.tenantId, tenantId), inArray(M.id, ids))) as unknown as Promise<MatrixRow[]>;

const number = (value: string | null) => (value === null ? null : Number(value));

/** 位置字段按 before、after 的顺序给出。 */
const roleRank = (role: string) => (role === 'before' ? 0 : 1);
const byMatrix = <T extends { matrixId: string }>(rows: T[], id: string) => rows.filter((r) => r.matrixId === id);

/** 规则组 → 规则 → 规则的格子集合，一次三查。 */
async function loadGroups(tx: Tx, tenantId: string, ids: string[]) {
  const groups = await tx
    .select()
    .from(G)
    .where(and(eq(G.tenantId, tenantId), inArray(G.matrixId, ids)))
    .orderBy(asc(G.sortNo), asc(G.id));
  const groupIds = groups.map((g) => g.id);
  const rules = groupIds.length
    ? await tx
        .select()
        .from(R)
        .where(and(eq(R.tenantId, tenantId), inArray(R.groupId, groupIds)))
        .orderBy(asc(R.sortNo), asc(R.id))
    : [];
  const ruleIds = rules.map((r) => r.id);
  const ruleCells = ruleIds.length
    ? await tx
        .select()
        .from(RC)
        .where(and(eq(RC.tenantId, tenantId), inArray(RC.ruleId, ruleIds)))
        .orderBy(asc(RC.cellNo))
    : [];
  const ruleView = (rule: (typeof rules)[number]): RatioRuleView => ({
    operator: rule.operator,
    pctLow: Number(rule.pctLow),
    pctHigh: number(rule.pctHigh),
    cellNos: ruleCells.filter((c) => c.ruleId === rule.id).map((c) => c.cellNo),
  });
  return groups.map((g) => ({
    matrixId: g.matrixId,
    view: {
      id: g.id,
      name: g.name,
      isDefault: g.isDefault,
      controlScope: g.controlScope,
      controlMode: g.controlMode,
      minPopulation: g.minPopulation,
      sortNo: g.sortNo,
      rules: rules.filter((rule) => rule.groupId === g.id).map(ruleView),
    } satisfies RatioGroupView,
  }));
}

/** 列表与详情共用：一次查出这批九宫格的全部子数据，按九宫格归位。 */
export async function withChildren(tx: Tx, tenantId: string, rows: MatrixRow[]): Promise<MatrixView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id as string);
  const positions = await tx
    .select()
    .from(P)
    .where(and(eq(P.tenantId, tenantId), inArray(P.matrixId, ids)));
  const levels = await tx
    .select()
    .from(L)
    .where(and(eq(L.tenantId, tenantId), inArray(L.matrixId, ids)))
    .orderBy(asc(L.axis), asc(L.levelNo));
  const cells = await tx
    .select()
    .from(C)
    .where(and(eq(C.tenantId, tenantId), inArray(C.matrixId, ids)))
    .orderBy(asc(C.cellNo));
  const groups = await loadGroups(tx, tenantId, ids);
  return rows.map((r) => ({
    ...r,
    id: r.id as string,
    name: r.name as string,
    positionFields: byMatrix(positions, r.id as string)
      .map((p) => ({ role: p.role, fieldId: p.fieldId }))
      .sort((a, b) => roleRank(a.role) - roleRank(b.role)),
    axisLevels: byMatrix(levels, r.id as string).map((l) => ({
      axis: l.axis,
      levelNo: l.levelNo,
      name: l.name,
      optionValues: l.optionValues,
      lowerBound: number(l.lowerBound),
    })),
    cells: byMatrix(cells, r.id as string).map(({ cellNo, xLevelNo, yLevelNo, name, color, countsGreen }) => ({
      cellNo,
      xLevelNo,
      yLevelNo,
      name,
      color,
      countsGreen,
    })),
    ratioGroups: byMatrix(groups, r.id as string).map((g) => g.view),
  })) as MatrixView[];
}

/**
 * 列表排序键：规格的默认排序是 sortNo、code，但看不到的字段不能影响顺序与分页（管理员改隐藏值就会改变第一页），
 * 所以只取查看人可见的那些；两者都不可见时只剩稳定标识 id（config-kit 的 listConfig 总是追加）。
 */
export const visibleOrder = (viewable: ReadonlySet<string> | undefined) =>
  (
    [
      ['sortNo', M.sortNo],
      ['code', M.code],
    ] as const
  )
    .filter(([field]) => viewable === undefined || viewable.has(field))
    .map(([, column]) => column);

export const loadMatrixView = (tx: Tx, tenantId: string, id: string) => MATRIX.load!(tx, tenantId, id);
