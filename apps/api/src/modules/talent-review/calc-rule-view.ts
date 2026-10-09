/** 盘点计算规则聚合的视图装配（设计 §2.2）：规则行 + 计算项目（按序号）。列表与详情共用 withItems。 */
import {
  and,
  asc,
  eq,
  inArray,
  talentReviewCalcRuleItems as I,
  talentReviewCalcRules as K,
  type Tx,
} from '@italent/db';
import type { ConfigSpec, ConfigTable } from './config-kit.js';

const row = {
  id: K.id,
  name: K.name,
  enabled: K.enabled,
  assessmentLatestWindow: K.assessmentLatestWindow,
  description: K.description,
  sortNo: K.sortNo,
  revision: K.revision,
  createdBy: K.createdBy,
  createdAt: K.createdAt,
  updatedBy: K.updatedBy,
  updatedAt: K.updatedAt,
};
export type CalcRuleRow = Omit<typeof K.$inferSelect, 'tenantId'>;
export interface CalcItemView {
  readonly targetFieldId: string;
  readonly priority: number;
  readonly formula: string;
  readonly description: string | null;
  readonly sortNo: number;
  readonly usesRanking: boolean;
}
export type CalcRuleView = CalcRuleRow & { items: CalcItemView[] };

const selectRows = (tx: Tx, tenantId: string, ids: string[]) =>
  tx
    .select(row)
    .from(K)
    .where(and(eq(K.tenantId, tenantId), inArray(K.id, ids))) as unknown as Promise<CalcRuleRow[]>;

export const CALC_RULE: ConfigSpec<CalcRuleView> = {
  object: 'calcRule',
  label: '计算规则',
  table: K as unknown as ConfigTable,
  view: row,
  orderBy: [K.sortNo, K.name],
  duplicate: 'CALC_RULE_DUPLICATE',
  inUse: 'CALC_RULE_IN_USE',
  load: async (tx, tenantId, id) => (await withItems(tx, tenantId, await selectRows(tx, tenantId, [id])))[0],
};

export async function withItems(tx: Tx, tenantId: string, rows: CalcRuleRow[]): Promise<CalcRuleView[]> {
  if (rows.length === 0) return [];
  const items = await tx
    .select()
    .from(I)
    .where(
      and(
        eq(I.tenantId, tenantId),
        inArray(
          I.ruleId,
          rows.map((r) => r.id),
        ),
      ),
    )
    .orderBy(asc(I.sortNo), asc(I.id));
  return rows.map((r) => ({
    ...r,
    items: items
      .filter((item) => item.ruleId === r.id)
      .map(({ targetFieldId, priority, formula, description, sortNo, usesRanking }) => ({
        targetFieldId,
        priority,
        formula,
        description,
        sortNo,
        usesRanking,
      })),
  }));
}

export const loadCalcRuleView = (tx: Tx, tenantId: string, id: string) => CALC_RULE.load!(tx, tenantId, id);
