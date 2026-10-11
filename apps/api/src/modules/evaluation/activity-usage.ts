/**
 * 被评定活动引用时拒删 / 拒停用（B5 填 B1a / B4 的钩子位，usage.ts）：
 * - 活动类型 / 活动周期：被活动引用后删除、停用都拒绝（原站“停用”置灰，Q-M0-152，提示由服务端给出，不列引用方）；
 * - 评价表：被活动环节引用后拒删（停用不拦，新引用会被拒、已有引用照常显示，DEC-281⑧）；外键 restrict 兜底并发。
 * 评审组不拦（照原站被引用也能停用，没有删除入口，DEC-393）；EV-R5 评价表锁的真实判定在 B6。
 */
import { sql } from 'drizzle-orm';
import { registerInUse, type UsageContext } from './usage.js';

const activityUses = (column: 'type_id' | 'cycle_id') => (ctx: UsageContext, id: string) =>
  sql`SELECT 1 FROM ev_activities a
    WHERE a.tenant_id = ${ctx.tenantId}::uuid AND a.${sql.identifier(column)} = ${id}::uuid`;
const chainUsesForm = (ctx: UsageContext, id: string) =>
  sql`SELECT 1 FROM ev_chains c WHERE c.tenant_id = ${ctx.tenantId}::uuid AND c.form_id = ${id}::uuid`;

let registered = false;
export function registerActivityUsage(): void {
  if (registered) return;
  registered = true;
  for (const [object, column, label, reason] of [
    ['activityType', 'type_id', '活动类型', 'ACTIVITY_TYPE_IN_USE'],
    ['activityCycle', 'cycle_id', '活动周期', 'ACTIVITY_CYCLE_IN_USE'],
  ] as const) {
    const rule = (verb: string) => ({
      sql: activityUses(column),
      message: `此${label}已被评定活动引用，无法${verb}`,
      reason,
    });
    registerInUse(object, rule('删除'), 'delete');
    registerInUse(object, rule('停用'), 'disable');
  }
  registerInUse(
    'evaluationForm',
    { sql: chainUsesForm, message: '此评价表已被评定活动引用，无法删除', reason: 'EVALUATION_FORM_IN_USE' },
    'delete',
  );
}
