import { auditEvents, sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { auditActor } from '../../system-actor.js';
import { orderCodeProjection } from './order-code-query.js';
import { assertRevision, rows, type PersonnelContext } from './store.js';
import { lockOrderSettings } from './order-code-settings.js';

const columns: Record<string, SQL> = {
  department: sql`department_path`,
  post: sql`post_code`,
  position: sql`position_order`,
  level: sql`level_number`,
  grade: sql`grade_number`,
  code: sql`code COLLATE "C"`,
};
/** DEC-148 / DEC-170 / 15 §12：按启用规则依次比较，用 rank() 保留并列；没有编码分段或数值拼接。 */
export async function recomputeOrderCodes(tx: Tx, ctx: PersonnelContext, checkRevision = true) {
  // 限制与业务事务争用配置 / 员工外键锁的等待时间；只影响本次事务。
  await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
  const config = await lockOrderSettings(tx, ctx.tenantId);
  if (checkRevision) assertRevision(ctx.expectedRevision, config.revision);
  const items = config.items.filter((i) => i.enabled);
  const enabled = config.enabled && items.length > 0;
  const order = items.map((i) => sql`${columns[i.field]!} ${i.direction === 'asc' ? sql`ASC` : sql`DESC`} NULLS LAST`);
  const asOf = tenantLocalDate(ctx.now, ctx.timezone);
  // 全租户窗口在数据库内计算；一个 SQL 快照读取主职与组织 / 职务版本，原子发布，避免分批产生局部名次。
  // NULL 仅按 SQL 比较顺序放末尾，不转为占位数字；没有当前主职的人员不参与名次。
  const [result] = rows<{ changed: number }>(
    await tx.execute(sql`
    WITH projected AS (
      ${
        enabled
          ? orderCodeProjection(ctx, order)
          : sql`
        SELECT employee_id AS id,NULL::int AS n FROM personnel_employee_order_codes
        WHERE tenant_id=${ctx.tenantId}`
      }
    ), previous AS MATERIALIZED (
      SELECT employee_id,order_code FROM personnel_employee_order_codes WHERE tenant_id=${ctx.tenantId}
    ), changed AS (
      INSERT INTO personnel_employee_order_codes AS target(tenant_id,employee_id,order_code)
      SELECT ${ctx.tenantId},id,n FROM projected ORDER BY id
      ON CONFLICT (tenant_id,employee_id) DO UPDATE SET order_code=EXCLUDED.order_code,revision=target.revision+1
        WHERE target.order_code IS DISTINCT FROM EXCLUDED.order_code
      RETURNING employee_id,order_code,revision
    ), audited AS (
      INSERT INTO audit_events(tenant_id,actor_user_id,action,object_type,object_id,
        "before","after",command_id,occurred_at)
      SELECT ${ctx.tenantId},${auditActor(ctx.userId)}::uuid,'personnel.order.recompute','personnel-order-code',
        c.employee_id::text,
        CASE WHEN p.employee_id IS NULL THEN NULL ELSE jsonb_build_object('orderCode',p.order_code) END,
        jsonb_build_object('orderCode',c.order_code),${ctx.commandId},${ctx.now.toISOString()}::timestamptz
      FROM changed c LEFT JOIN previous p USING (employee_id)
    ), emitted AS (
      INSERT INTO personnel_outbox(tenant_id,employee_id,object_type,object_id,event_type,revision,command_id)
      SELECT ${ctx.tenantId},employee_id,'personnel-order-code',employee_id,'personnel.order.changed',revision,
        ${ctx.commandId} FROM changed ORDER BY employee_id
    ) SELECT count(*)::int AS changed FROM changed
  `),
  );
  const outcome =
    config.revision === 0
      ? 'not_configured'
      : !config.enabled
        ? 'disabled'
        : items.length === 0
          ? 'no_enabled_rules'
          : 'computed';
  const resultBody = { revision: config.revision, changed: result!.changed, businessDate: asOf, outcome };
  await recordRun(tx, ctx, resultBody, checkRevision);
  return resultBody;
}
async function recordRun(tx: Tx, ctx: PersonnelContext, result: object, manual: boolean) {
  await tx.execute(sql`INSERT INTO personnel_order_runs(tenant_id,command_id,state,attempts,ran_at)
    VALUES (${ctx.tenantId},${ctx.commandId},'succeeded',1,${ctx.now.toISOString()}::timestamptz)
    ON CONFLICT (tenant_id,command_id) DO UPDATE SET state='succeeded',attempts=personnel_order_runs.attempts+1,
      error=NULL,ran_at=EXCLUDED.ran_at`);
  // 即使没有名次变化也记录手动触发人；命令台账保证重放不会再执行这一写入。
  if (manual)
    await tx.insert(auditEvents).values({
      tenantId: ctx.tenantId,
      actorUserId: auditActor(ctx.userId),
      action: 'personnel.order.run',
      objectType: 'personnel-order-run',
      objectId: ctx.commandId,
      commandId: ctx.commandId,
      before: null,
      after: result,
      occurredAt: ctx.now,
    });
}
