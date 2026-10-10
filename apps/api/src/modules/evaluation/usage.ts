/**
 * “被引用拒删 / 拒停用”的钩子位（拆分方案 B1a；原站 W-755～756：被活动引用的类型“停用”置灰，Q-M0-152）：配置对象被别的
 * 对象引用时不能删除、也不能停用，引用方在各自的子 PR 里登记，本 PR 只留位置：
 * - B4（评价表）登记通用评分项被评价表评分项引用；
 * - B5（评定活动）登记活动类型 / 周期被活动引用、评价表被环节引用、评审组被环节引用等；
 * - C2 有评定数据表后按需补充。
 * 登记的是“引用查询”（命中任意一行即在用），删除 / 停用命令在同一事务里依次执行，命中即 409 CONFLICT 并带引用方给出的
 * reason。删除与停用分开登记（`phase`），互不串用。
 * 两类“被引用”各自照原站（DEC-380③）：活动类型 / 活动周期事先置灰（服务端拒绝停用，提示由引用方给出）；通用评分项点击后拒绝并
 * 列出引用它的评价表——规则带 `references`（返回引用方的 id / name / visible），只列操作人看得到的，看不到的计为“其他 N 个”
 * （DEC-374⑥），响应 details.referrers / details.otherCount。
 * TODO(B5): 登记 activityType / activityCycle 被 ev_activities 引用的 delete 与 disable 规则（还没有活动表）。
 * TODO(B4): 登记 generalScoreItem 被评价表评分项引用的 delete 与 disable 规则（disable 带 `references`，visible 取评价表的
 * 范围谓词 scopePredicate(scope, 'evaluationForm')，范围由 B4 的路由层解析进写命令上下文）。
 */
import { sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import { rowsOf, type EvaluationObject } from './access.js';

export interface UsageRule {
  /** 返回命中行即表示在用的查询（`SELECT 1 …`）；须带租户条件。 */
  readonly sql: (ctx: { readonly tenantId: string }, id: string) => SQL;
  /** 没有 `references` 时的提示；有则由引擎按下面的格式生成。 */
  readonly message: string;
  readonly reason: string;
  /** 列出引用方：返回行 { id, name, visible }，visible = 操作人看得到该引用方（其余计入“其他 N 个”）。 */
  readonly references?: (ctx: { readonly tenantId: string }, id: string) => SQL;
  /** 提示里的被引用对象与引用方称呼：“此评分项” “评价表”。 */
  readonly subject?: string;
  readonly referrerKind?: string;
}

export interface Referrer {
  readonly id: string;
  readonly name: string;
}

/** 此评分项被评价表【甲、乙】及其他 N 个引用，无法停用（原站格式 + 只列看得到的）。 */
export function referrersMessage(subject: string, kind: string, names: readonly string[], other: number): string {
  const listed = names.length ? `${kind}【${names.join('、')}】` : '';
  const rest = other ? (names.length ? `及其他 ${other} 个` : `其他 ${other} 个${kind}`) : '';
  return `${subject}被${listed}${rest}引用，无法停用`;
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
      if (!rule.references) throw new AppError('CONFLICT', rule.message, { reason: rule.reason });
      const rows = rowsOf<{ id: string; name: string; visible: boolean }>(await tx.execute(rule.references(ctx, id)));
      const referrers: Referrer[] = rows.filter((row) => row.visible).map(({ id: rid, name }) => ({ id: rid, name }));
      const otherCount = rows.length - referrers.length;
      const message = referrersMessage(
        rule.subject ?? '此对象',
        rule.referrerKind ?? '对象',
        referrers.map((referrer) => referrer.name),
        otherCount,
      );
      throw new AppError('CONFLICT', message, { reason: rule.reason, referrers, otherCount });
    }
  }
}
