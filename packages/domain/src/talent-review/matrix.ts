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
/** 轴字段的类型：单选按选项值分段，数值按下界分段。 */
export const MATRIX_AXIS_FIELD_KINDS = ['option', 'number'] as const;
/** 位置字段：校准前 / 后的格子号，只能是“位置”分组的数值字段（设计 §2.7）。 */
export const MATRIX_POSITION_FIELD_GROUP = 'position';
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
  readonly lowerBound: number | null;
}
export interface CellInput {
  readonly cellNo: number;
  readonly xLevelNo: number;
  readonly yLevelNo: number;
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

/**
 * 一条轴的分段：序号 1..n 连续（2～9 段）；单选轴每段至少一个选项值、值属于字段选项且各段不重复；
 * 数值轴第一段没有下界，其余各段下界严格递增（本段上界 = 下一段下界）。
 */
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
  if (field.kind === 'option') return checkOptionLevels(label, field.optionValues, own);
  return checkNumericLevels(label, own);
}

function checkOptionLevels(label: string, known: ReadonlySet<string>, levels: readonly AxisLevelInput[]) {
  const used = new Set<string>();
  for (const level of levels) {
    if (level.lowerBound !== null) return violation('MATRIX_LEVELS_INVALID', `${label} 轴是单选字段，分段不能设下界`);
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

function checkNumericLevels(label: string, levels: readonly AxisLevelInput[]) {
  let previous: number | null = null;
  for (const [index, level] of levels.entries()) {
    if (level.optionValues.length > 0)
      return violation('MATRIX_LEVELS_INVALID', `${label} 轴是数值字段，分段不能选选项`);
    if (index === 0) {
      if (level.lowerBound !== null) return violation('MATRIX_LEVELS_INVALID', `${label} 轴第一段不设下界`);
      continue;
    }
    if (level.lowerBound === null || (previous !== null && level.lowerBound <= previous)) {
      return violation('MATRIX_LEVELS_INVALID', `${label} 轴各段下界须依次递增`);
    }
    previous = level.lowerBound;
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

// ---- 预置（设计 §2.7）：两个九宫格；X 轴 = 业绩 / 绩效，Y 轴 = 能力 / 潜力，各 3 段（低 / 中 / 高，选项值 1 / 2 / 3） ----

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
    code: 'appraisal_potential',
    name: '绩效-潜力',
    xLabel: '绩效',
    yLabel: '潜力',
    xFieldCode: 'appraisal_before',
    yFieldCode: 'potential_before',
    positionFieldCodes: { before: 'appraisal_potential_cell_before', after: 'appraisal_potential_cell_after' },
  },
];

const PRESET_LEVEL_NAMES = ['低', '中', '高'] as const;
/** 格子颜色按两轴分段之和由红到绿；原站格子名称与颜色未取到（🟡，取证后只改这里）。 */
const PRESET_COLORS = ['#F5222D', '#FA8C16', '#FADB14', '#A0D911', '#52C41A'] as const;

export function presetAxisLevels(): AxisLevelInput[] {
  return MATRIX_AXES.flatMap((axis) =>
    PRESET_LEVEL_NAMES.map((name, index) => ({
      axis,
      levelNo: index + 1,
      name,
      optionValues: [String(index + 1)],
      lowerBound: null,
    })),
  );
}

/** 格子号 = (Y 段 − 1) × 3 + X 段，从左下（低 - 低）到右上（高 - 高）为 1～9。 */
export function presetCells(matrix: PresetMatrix) {
  return [1, 2, 3].flatMap((y) =>
    [1, 2, 3].map((x) => ({
      cellNo: (y - 1) * 3 + x,
      xLevelNo: x,
      yLevelNo: y,
      name: `${matrix.xLabel}${PRESET_LEVEL_NAMES[x - 1]}·${matrix.yLabel}${PRESET_LEVEL_NAMES[y - 1]}`,
      color: PRESET_COLORS[x + y - 2]!,
      countsGreen: false,
    })),
  );
}
