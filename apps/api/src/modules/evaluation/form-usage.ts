/**
 * 通用评分项被评价表评分项引用时拒删、拒停用（B4 填 B1a / B1b 的钩子位，usage.ts；原站 Q-M0-171）：
 * - 停用：点击后由服务端拒绝并列出引用它的评价表，原文“此评分项被评价表【甲】【乙】引用，无法停用”（DEC-380 的格式，只列操作人
 *   看得到的评价表，其余计入“其他 N 个”，DEC-374⑥）；
 * - 删除：同样拒绝（评价表评分项对通用评分项有外键，restrict 兜底并发）。
 * 评价表的可见范围由路由层在命令事务内解析进写命令上下文（form-refs.resolveFormVisibility）。
 */
import { sql } from 'drizzle-orm';
import { scopePredicate } from './access.js';
import { registerInUse, type UsageContext } from './usage.js';

const REASON = 'GENERAL_SCORE_ITEM_IN_USE';
const used = (ctx: UsageContext, id: string) => sql`SELECT 1 FROM ev_form_items i
  WHERE i.tenant_id = ${ctx.tenantId}::uuid AND i.general_item_id = ${id}::uuid`;

let registered = false;
export function registerFormUsage(): void {
  if (registered) return;
  registered = true;
  registerInUse('generalScoreItem', { sql: used, message: '此评分项被评价表引用，无法删除', reason: REASON }, 'delete');
  registerInUse(
    'generalScoreItem',
    {
      sql: used,
      message: '此评分项被评价表引用，无法停用',
      reason: REASON,
      subject: '此评分项',
      referrerKind: '评价表',
      references: (ctx, id) => {
        const visible =
          ctx.formVisibility?.canView === true
            ? scopePredicate(ctx.formVisibility.scope, 'evaluationForm', 'f')
            : sql`false`;
        return sql`SELECT f.id, f.name, (${visible}) AS visible FROM ev_forms f
          WHERE f.tenant_id = ${ctx.tenantId}::uuid
            AND f.id IN (SELECT i.form_id FROM ev_form_items i
              WHERE i.tenant_id = f.tenant_id AND i.general_item_id = ${id}::uuid)
          ORDER BY f.name, f.id`;
      },
    },
    'disable',
  );
}
