/**
 * 盘点计算规则的请求结构（只做结构校验，不读库）。严格对象：未登记的键一律 400。计算项目按目标字段对应（规则内唯一、
 * 保存后只读）：修改时提交 items 即整组替换，目标字段相同的项目更新，缺的删除，新的新增。
 */
import { CALC_RULE_WINDOWS } from '@italent/domain';
import { z } from 'zod';

/** 标识统一小写规范化（DEC-194）。 */
const uuid = z.uuid().transform((value) => value.toLowerCase());
const name = z.string().trim().min(1).max(50);

const calcItem = z.strictObject({
  targetFieldId: uuid,
  priority: z.int().min(0).max(1_000_000),
  formula: z.string().trim().min(1).max(4000),
  description: z.string().trim().max(500).nullable().optional(),
});

export const calcRuleCreate = z.strictObject({
  name,
  enabled: z.boolean().optional(),
  assessmentLatestWindow: z.enum(CALC_RULE_WINDOWS).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  sortNo: z.int().min(0).max(1_000_000).optional(),
  items: z.array(calcItem).max(100),
});
export const calcRulePatch = calcRuleCreate.partial();

export type CalcRuleCreate = z.output<typeof calcRuleCreate>;
export type CalcRulePatch = z.output<typeof calcRulePatch>;
export type CalcItemBody = z.output<typeof calcItem>;

// ---- F-082（开关打开）：公式按名称输入，附逐处绑定证明与字段目录版本（契约 §1.5） ----------------------------------------------

/** 逐处引用的绑定证明：字段 ID（小写）/ "context"（项目上下文）/ null（新输入）。 */
const binding = z.union([uuid, z.literal('context'), z.null()]);

/**
 * 请求结构层对 formula 只设宽松上限 8000 字（原样保留的回显会比 4000 字长，契约 §1.6 长度例外）；
 * 4000 字 / 800 词的业务上限在处理顺序第 2 步执行（checkInputLimits）。
 */
const boundCalcItem = z.strictObject({
  targetFieldId: uuid,
  priority: z.int().min(0).max(1_000_000),
  formula: z.string().trim().min(1).max(8000),
  formulaBindings: z.array(binding).max(800).optional(),
  description: z.string().trim().max(500).nullable().optional(),
});

export const boundCalcRuleCreate = z.strictObject({
  name,
  enabled: z.boolean().optional(),
  assessmentLatestWindow: z.enum(CALC_RULE_WINDOWS).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  sortNo: z.int().min(0).max(1_000_000).optional(),
  items: z.array(boundCalcItem).max(100),
  /** 提交方看到的字段目录版本；有新输入的引用时必须等于当前版本（契约 §1.5）。 */
  fieldCatalogVersion: z.int().min(0).optional(),
});
export const boundCalcRulePatch = boundCalcRuleCreate.partial();

export type BoundCalcItemBody = z.output<typeof boundCalcItem>;
export type BoundCalcRuleCreate = z.output<typeof boundCalcRuleCreate>;
export type BoundCalcRulePatch = z.output<typeof boundCalcRulePatch>;
