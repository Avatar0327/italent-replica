/**
 * 九宫格的领域常量、保存校验（纯函数）与预置清单（R3-T04 设计 §2.2 matrices / axis_levels / cells / ratio_rule_*、§2.7；
 * TR-R31～R35；D-20）。落位与比例校验的运行时函数在 PR-D（设计 §4.7），这里只管“配置是否自洽”。
 */
export const MATRIX_PLACEMENT_SOURCES = ['before', 'after', 'after_else_before'] as const;
export type MatrixPlacementSource = (typeof MATRIX_PLACEMENT_SOURCES)[number];
export const MATRIX_POSITION_ROLES = ['before', 'after'] as const;
export type MatrixPositionRole = (typeof MATRIX_POSITION_ROLES)[number];
export const MATRIX_AXES = ['x', 'y'] as const;
export type MatrixAxis = (typeof MATRIX_AXES)[number];
/**
 * 轴字段的类型：只允许等级维度字段（单选，按选项值分段）。原站的轴下拉只有“校准后××”这类等级字段，没有得分等数值字段
 * （Q-M0-156，DEC-389①，撤回 DEC-374③ 的“单选或数值”）。系统未上线：不做数据迁移，也不保留旧数值轴的兼容读取（DEC-403）。
 */
export const MATRIX_AXIS_FIELD_KINDS = ['option'] as const;
/** 位置字段：校准前 / 后的格子号，只能是“位置”分组的数值字段（设计 §2.7）。 */
export const MATRIX_POSITION_FIELD_GROUP = 'position';
/** 每轴段数 2～9（原站有 2 × 2，Q-M0-156；配置入口未查，上限沿用设计）。 */
export const MATRIX_MIN_LEVELS = 2;
export const MATRIX_MAX_LEVELS = 9;

export const RATIO_OPERATORS = ['gt', 'lt', 'gte', 'lte', 'between'] as const;
export type RatioOperator = (typeof RATIO_OPERATORS)[number];
/** 控制范围（TR-R33）：盘点项目和校准会结束时校验 / 盘点流程提交时校验。 */
export const RATIO_CONTROL_SCOPES = ['project_meeting', 'flow'] as const;
/** 控制方式（TR-R33）：仅提示 / 提示且不允许提交（或结束）。 */
export const RATIO_CONTROL_MODES = ['warn', 'block'] as const;

export interface AxisLevelInput {
  readonly axis: MatrixAxis;
  readonly levelNo: number;
  readonly name: string;
  readonly optionValues: readonly string[];
}
export interface CellInput {
  readonly cellNo: number;
  readonly xLevelNo: number;
  readonly yLevelNo: number;
  /** 导出顺序（1..n）：整组给出或整组缺省。 */
  readonly exportOrder?: number | null | undefined;
}
export interface RatioRuleInput {
  readonly operator: RatioOperator;
  readonly pctLow: number;
  readonly pctHigh?: number | undefined;
  readonly cellNos: readonly number[];
}
/** 校验不通过：reason 是机器可读的原因码，message 是给人看的说明。 */
export interface MatrixViolation {
  readonly reason: string;
  readonly message: string;
}
const violation = (reason: string, message: string): MatrixViolation => ({ reason, message });

/** 一条轴的分段：序号 1..n 连续（2～9 段）；每段至少一个选项值、值属于字段选项且各段不重复。 */
export function checkAxisLevels(
  axis: MatrixAxis,
  field: { readonly kind: string; readonly optionValues: ReadonlySet<string> },
  levels: readonly AxisLevelInput[],
): MatrixViolation | null {
  const own = levels.filter((level) => level.axis === axis).sort((a, b) => a.levelNo - b.levelNo);
  const label = axis.toUpperCase();
  if (own.length < MATRIX_MIN_LEVELS || own.length > MATRIX_MAX_LEVELS) {
    return violation('MATRIX_LEVELS_INVALID', `${label} 轴须有 ${MATRIX_MIN_LEVELS}～${MATRIX_MAX_LEVELS} 个分段`);
  }
  if (own.some((level, index) => level.levelNo !== index + 1)) {
    return violation('MATRIX_LEVELS_INVALID', `${label} 轴分段序号须从 1 连续编号`);
  }
  return checkOptionLevels(label, field.optionValues, own);
}

function checkOptionLevels(label: string, known: ReadonlySet<string>, levels: readonly AxisLevelInput[]) {
  const used = new Set<string>();
  for (const level of levels) {
    if (level.optionValues.length === 0) return violation('MATRIX_LEVELS_INVALID', `${label} 轴每段至少选一个选项`);
    for (const value of level.optionValues) {
      if (!known.has(value) || used.has(value)) {
        return violation('MATRIX_LEVELS_INVALID', `${label} 轴的选项值不存在或被多个分段重复使用`);
      }
      used.add(value);
    }
  }
  return null;
}

/** 格子必须恰好铺满 X 分段 × Y 分段的网格：格子号唯一，每个（X 段, Y 段）恰有一个格子。 */
export function checkCells(xLevels: number, yLevels: number, cells: readonly CellInput[]): MatrixViolation | null {
  const incomplete = (message: string) => violation('MATRIX_CELLS_INCOMPLETE', message);
  if (cells.length !== xLevels * yLevels) return incomplete(`格子须铺满 ${xLevels} × ${yLevels} 的网格`);
  if (new Set(cells.map((cell) => cell.cellNo)).size !== cells.length) return incomplete('格子编号重复');
  const positions = new Set(cells.map((cell) => `${cell.xLevelNo},${cell.yLevelNo}`));
  const inside = cells.every(
    (c) => c.xLevelNo >= 1 && c.xLevelNo <= xLevels && c.yLevelNo >= 1 && c.yLevelNo <= yLevels,
  );
  if (positions.size !== cells.length || !inside) return incomplete('每个行列位置须恰有一个格子');
  return checkExportOrder(cells);
}

/** 导出顺序：整组给出（恰好是 1..格子数的一个排列）或整组缺省（按格子号导出）。 */
function checkExportOrder(cells: readonly CellInput[]): MatrixViolation | null {
  const given = cells.map((cell) => cell.exportOrder ?? null);
  if (given.every((order) => order === null)) return null;
  const sorted = given.map((order) => order ?? 0).sort((a, b) => a - b);
  if (sorted.some((order, index) => order !== index + 1)) {
    return violation('MATRIX_EXPORT_ORDER_INVALID', `导出顺序须整组给出，且恰好是 1～${cells.length} 的一个排列`);
  }
  return null;
}

/** 一条比例规则：范围运算要上限且不小于下限，其他运算不带上限；格子集合非空、无重复、都属于本九宫格。 */
export function checkRatioRule(rule: RatioRuleInput, cellNos: ReadonlySet<number>): MatrixViolation | null {
  const invalid = (message: string) => violation('RATIO_RULE_INVALID', message);
  if ((rule.operator === 'between') !== (rule.pctHigh !== undefined)) {
    return invalid('只有范围运算需要上限百分比');
  }
  if (rule.pctHigh !== undefined && rule.pctHigh < rule.pctLow) return invalid('上限百分比不能小于下限');
  if (new Set(rule.cellNos).size !== rule.cellNos.length) return invalid('规则的格子集合有重复');
  if (rule.cellNos.some((cellNo) => !cellNos.has(cellNo))) {
    return violation('RATIO_RULE_CELL_UNKNOWN', '规则引用了本九宫格没有的格子');
  }
  return null;
}

// ---- 预置（设计 §2.7；DEC-389①）：两个九宫格，各 3 段（低 / 中 / 高，选项值 1 / 2 / 3） ----

export interface PresetMatrix {
  readonly code: string;
  readonly name: string;
  readonly xLabel: string;
  readonly yLabel: string;
  /** 轴、位置字段的预置字段编码（TALENT_REVIEW_PRESET_FIELDS）。 */
  readonly xFieldCode: string;
  readonly yFieldCode: string;
  readonly positionFieldCodes: { readonly before: string; readonly after: string };
}
export const TALENT_REVIEW_PRESET_MATRICES: readonly PresetMatrix[] = [
  {
    code: 'achievement_capability',
    name: '业绩-能力',
    xLabel: '业绩',
    yLabel: '能力',
    xFieldCode: 'achievement_before',
    yFieldCode: 'capability_before',
    positionFieldCodes: { before: 'achievement_capability_cell_before', after: 'achievement_capability_cell_after' },
  },
  {
    // 原站“绩效-潜力”：X = 潜力、Y = 绩效（行 = 绩效，列 = 潜力；Q-M0-157）
    code: 'appraisal_potential',
    name: '绩效-潜力',
    xLabel: '潜力',
    yLabel: '绩效',
    xFieldCode: 'potential_before',
    yFieldCode: 'appraisal_before',
    positionFieldCodes: { before: 'appraisal_potential_cell_before', after: 'appraisal_potential_cell_after' },
  },
];

const PRESET_LEVEL_NAMES = ['低', '中', '高'] as const;
/** “业绩-能力”的格子颜色按两轴分段之和由红到绿；原站该预置的名称与颜色未取到（🟡，取证后只改这里）。 */
const PRESET_COLORS = ['#F5222D', '#FA8C16', '#FADB14', '#A0D911', '#52C41A'] as const;
const DEFAULT_TEXT_COLOR = '#000000';

export function presetAxisLevels(): AxisLevelInput[] {
  return MATRIX_AXES.flatMap((axis) =>
    PRESET_LEVEL_NAMES.map((name, index) => ({
      axis,
      levelNo: index + 1,
      name,
      optionValues: [String(index + 1)],
    })),
  );
}

/** 预置格子：与保存命令的格子结构一致（文字颜色、导出顺序、绿化率标记都是显式值）。 */
export interface PresetCell {
  readonly cellNo: number;
  readonly xLevelNo: number;
  readonly yLevelNo: number;
  readonly name: string;
  readonly color: string;
  readonly textColor: string;
  readonly exportOrder: number | null;
  readonly countsGreen: boolean;
}

/** “绩效-潜力”各格子名称，按格子号 1～9（DEC-389①，Q-M0-157 样本）。 */
const APPRAISAL_POTENTIAL_NAMES = [
  '提升绩效人才',
  '稳定人才',
  '自我提升人才',
  '关注人才',
  '可靠人才',
  '关注人才',
  '核心人才',
  '核心人才',
  '明星人才',
] as const;
/** 背景：同一色系三档蓝，按对角线分档（1～3、4～6、7～9）。 */
const APPRAISAL_POTENTIAL_COLORS = ['#C3D8F1', '#D5EBFD', '#EDF8FF'] as const;
/** 导出设置里的格子顺序（按格子号）：9 → 7 → 8 → 5 → 4 → 6 → 2 → 3 → 1。 */
const APPRAISAL_POTENTIAL_EXPORT = [9, 7, 8, 5, 4, 6, 2, 3, 1] as const;

/**
 * “绩效-潜力”：格子号从左下（低 - 低）沿对角线递增到右上（高 - 高），**不是**按行编号——先按两轴分段之和排，
 * 同一条对角线上从下往上（Y 段小的在前）：1 (1,1)；2 (2,1)、3 (1,2)；4 (3,1)、5 (2,2)、6 (1,3)；7 (3,2)、8 (2,3)；9 (3,3)。
 */
function appraisalPotentialCells(): PresetCell[] {
  const positions = [1, 2, 3].flatMap((y) => [1, 2, 3].map((x) => ({ x, y })));
  positions.sort((a, b) => a.x + a.y - (b.x + b.y) || a.y - b.y);
  return positions.map(({ x, y }, index) => {
    const cellNo = index + 1;
    return {
      cellNo,
      xLevelNo: x,
      yLevelNo: y,
      name: APPRAISAL_POTENTIAL_NAMES[index]!,
      color: APPRAISAL_POTENTIAL_COLORS[Math.floor(index / 3)]!,
      textColor: DEFAULT_TEXT_COLOR,
      exportOrder: APPRAISAL_POTENTIAL_EXPORT.indexOf(cellNo as (typeof APPRAISAL_POTENTIAL_EXPORT)[number]) + 1,
      countsGreen: false,
    };
  });
}

/** 其他预置：格子号 = (Y 段 − 1) × 3 + X 段（按行），占位名称与颜色（原站未取到）。 */
function rowNumberedCells(matrix: PresetMatrix): PresetCell[] {
  return [1, 2, 3].flatMap((y) =>
    [1, 2, 3].map((x) => ({
      cellNo: (y - 1) * 3 + x,
      xLevelNo: x,
      yLevelNo: y,
      name: `${matrix.xLabel}${PRESET_LEVEL_NAMES[x - 1]}·${matrix.yLabel}${PRESET_LEVEL_NAMES[y - 1]}`,
      color: PRESET_COLORS[x + y - 2]!,
      textColor: DEFAULT_TEXT_COLOR,
      exportOrder: null,
      countsGreen: false,
    })),
  );
}

export function presetCells(matrix: PresetMatrix): PresetCell[] {
  return matrix.code === 'appraisal_potential' ? appraisalPotentialCells() : rowNumberedCells(matrix);
}
