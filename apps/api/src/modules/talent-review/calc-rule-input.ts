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
