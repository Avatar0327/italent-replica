/**
 * “被引用拒删 / 拒停用”的钩子位（拆分方案 B1a；原站 W-755～756：被活动引用的类型“停用”置灰，Q-M0-152）：配置对象被别的
 * 对象引用时不能删除、也不能停用，引用方在各自的子 PR 里登记，本 PR 只留位置：
 * - B4（评价表）登记通用评分项被评价表评分项引用；
 * - B5（评定活动）登记活动类型 / 周期被活动引用、评价表被环节引用、评审组被环节引用等；
 * - C2 有评定数据表后按需补充。
 * 登记的是“引用查询”（命中任意一行即在用），删除 / 停用命令在同一事务里依次执行，命中即 409 CONFLICT 并带引用方给出的
 * reason。删除与停用分开登记（`phase`），互不串用。
 * TODO(B5): 登记 activityType 被 ev_activities.type_id 引用的 delete 与 disable 两条规则（B1a 还没有活动表）。
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

export type UsagePhase = 'delete' | 'disable';

const RULES = new Map<string, UsageRule[]>();
const keyOf = (object: EvaluationObject, phase: UsagePhase) => `${object}:${phase}`;

export function registerInUse(object: EvaluationObject, rule: UsageRule, phase: UsagePhase = 'delete'): void {
  RULES.set(keyOf(object, phase), [...(RULES.get(keyOf(object, phase)) ?? []), rule]);
}

/** 删除 / 停用前的“还在使用”检查：有引用即 409，数据不变。 */
export async function rejectInUse(
  tx: Tx,
  ctx: { readonly tenantId: string },
  object: EvaluationObject,
  id: string,
  phase: UsagePhase = 'delete',
) {
  for (const rule of RULES.get(keyOf(object, phase)) ?? []) {
    const result = await tx.execute(sql`SELECT EXISTS (${rule.sql(ctx, id)}) AS used`);
    if (rowsOf<{ used: boolean }>(result)[0]?.used) {
      throw new AppError('CONFLICT', rule.message, { reason: rule.reason });
    }
  }
}
