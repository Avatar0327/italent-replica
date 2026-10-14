/**
 * 九宫格及其比例规则组的请求结构（只做结构校验，不读库）。严格对象：未登记的键一律 400；编码建后不可改，修改结构不收它。
 * 轴分段与格子必须整组同时提交（格子引用分段序号）；位置字段整组提交，行数与角色由保存命令校验
 * （缺角色 → 400 MATRIX_POSITION_FIELDS_INCOMPLETE），所以结构里只限最多两行。
 */
import {
  MATRIX_AXES,
  MATRIX_MAX_LEVELS,
  MATRIX_PLACEMENT_SOURCES,
  MATRIX_POSITION_ROLES,
  RATIO_CONTROL_MODES,
  RATIO_CONTROL_SCOPES,
  RATIO_OPERATORS,
} from '@italent/domain';
import { z } from 'zod';

/** 标识统一小写规范化（DEC-194）。 */
const uuid = z.uuid().transform((value) => value.toLowerCase());
const name = z.string().trim().min(1).max(50);
const sortNo = z.int().min(0).max(1_000_000);
const levelNo = z.int().min(1).max(MATRIX_MAX_LEVELS);
const twoDecimals = (value: number) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9;
const percent = z.number().min(0).max(100).refine(twoDecimals, '百分比最多两位小数');

const positionField = z.strictObject({ role: z.enum(MATRIX_POSITION_ROLES), fieldId: uuid });
const axisLevel = z.strictObject({
  axis: z.enum(MATRIX_AXES),
  levelNo,
  name,
  optionValues: z.array(z.string().min(1).max(50)).max(200).default([]),
});
const cell = z.strictObject({
  cellNo: z.int().min(1).max(99),
  xLevelNo: levelNo,
  yLevelNo: levelNo,
  name,
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, '颜色须为 #RRGGBB'),
  textColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, '颜色须为 #RRGGBB')
    .default('#000000'),
  // 导出顺序：整组给出或整组缺省，由领域层 checkCells 判定（MATRIX_EXPORT_ORDER_INVALID）
  exportOrder: z
    .int()
    .min(1)
    .max(MATRIX_MAX_LEVELS * MATRIX_MAX_LEVELS)
    .nullable()
    .default(null),
  countsGreen: z.boolean().default(false),
});

export const matrixCreate = z.strictObject({
  code: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,49}$/, '编码须以字母开头，仅含字母、数字、下划线'),
  name,
  xFieldId: uuid,
  yFieldId: uuid,
  zFieldId: uuid.nullable().optional(),
  xDraggable: z.boolean().optional(),
  yDraggable: z.boolean().optional(),
  placementSource: z.enum(MATRIX_PLACEMENT_SOURCES).optional(),
  greenRateReference: z.boolean().optional(),
  sortNo: sortNo.optional(),
  enabled: z.boolean().optional(),
  positionFields: z.array(positionField).max(2),
  axisLevels: z.array(axisLevel).max(2 * MATRIX_MAX_LEVELS),
  cells: z.array(cell).max(MATRIX_MAX_LEVELS * MATRIX_MAX_LEVELS),
});
export const matrixPatch = matrixCreate
  .omit({ code: true })
  .partial()
  .refine((value) => (value.axisLevels === undefined) === (value.cells === undefined), {
    message: '轴分段与格子必须同时提交',
  });

const rule = z.strictObject({
  operator: z.enum(RATIO_OPERATORS),
  pctLow: percent,
  pctHigh: percent.optional(),
  cellNos: z
    .array(z.int().min(1).max(99))
    .min(1)
    .max(MATRIX_MAX_LEVELS * MATRIX_MAX_LEVELS),
});
export const ratioGroupCreate = z.strictObject({
  name,
  isDefault: z.boolean().optional(),
  controlScope: z.enum(RATIO_CONTROL_SCOPES),
  controlMode: z.enum(RATIO_CONTROL_MODES),
  minPopulation: z.int().min(0).max(1_000_000).optional(),
  rules: z.array(rule).min(1).max(20),
});
export const ratioGroupPatch = ratioGroupCreate.partial();

export type MatrixCreate = z.output<typeof matrixCreate>;
export type MatrixPatch = z.output<typeof matrixPatch>;
export type RatioGroupCreate = z.output<typeof ratioGroupCreate>;
export type RatioGroupPatch = z.output<typeof ratioGroupPatch>;
export type AxisLevelBody = z.output<typeof axisLevel>;
export type CellBody = z.output<typeof cell>;
export type PositionFieldBody = z.output<typeof positionField>;
