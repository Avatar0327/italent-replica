/**
 * “被引用拒删”的钩子位（拆分方案 B1a）：配置对象被别的对象引用时不能删除，引用方在各自的子 PR 里登记，本 PR 只留位置：
 * - B4（评价表）登记通用评分项被评价表评分项引用；
 * - B5（评定活动）登记活动类型 / 周期被活动引用、评价表被环节引用、评审组被环节引用等。
 * 登记的是“引用查询”（命中任意一行即在用），删除命令在同一事务里依次执行，命中即 409 CONFLICT 并带引用方给出的 reason。
 */
import { sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import { rowsOf, type EvaluationObject } from './access.js';

export interface UsageRule {
  /** 返回命中行即表示在用的查询（`SELECT 1 …`）；须带租户条件。 */
  readonly sql: (ctx: { readonly tenantId: string }, id: string) => SQL;
  readonly message: string;
  readonly reason: string;
}

const RULES = new Map<EvaluationObject, UsageRule[]>();

export function registerInUse(object: EvaluationObject, rule: UsageRule): void {
  RULES.set(object, [...(RULES.get(object) ?? []), rule]);
}

/** 删除前的“还在使用”检查：有引用即 409，数据不变。 */
export async function rejectInUse(tx: Tx, ctx: { readonly tenantId: string }, object: EvaluationObject, id: string) {
  for (const rule of RULES.get(object) ?? []) {
    const result = await tx.execute(sql`SELECT EXISTS (${rule.sql(ctx, id)}) AS used`);
    if (rowsOf<{ used: boolean }>(result)[0]?.used) {
      throw new AppError('CONFLICT', rule.message, { reason: rule.reason });
    }
  }
}
