import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { auditActor } from '../../system-actor.js';
import { employeeJoins } from './employee-read.js';
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
/** DEC-148 / 15 §12：按启用规则依次比较，用 rank() 保留并列；没有编码分段或数值拼接。 */
export async function recomputeOrderCodes(tx: Tx, ctx: PersonnelContext, checkRevision = true) {
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
    WITH RECURSIVE cur_org AS (
      SELECT DISTINCT ON (org_id) id,org_id,enabled,stop_date FROM org_versions
      WHERE tenant_id=${ctx.tenantId} AND start_date<=${asOf}::date
      ORDER BY org_id,start_date DESC,version_no DESC
    ), paths(org_id,path,visited) AS (
      SELECT org_id,ARRAY[]::int[],ARRAY[org_id] FROM cur_org
      WHERE org_id=${ctx.tenantId}::uuid AND enabled AND stop_date>=${asOf}::date
      UNION ALL
      SELECT c.org_id,p.path || h.sequence,p.visited || c.org_id FROM cur_org c
      JOIN org_hierarchy_links h ON h.tenant_id=${ctx.tenantId} AND h.version_id=c.id AND h.dimension='admin'
      JOIN paths p ON p.org_id=h.parent_org_id
      WHERE c.enabled AND c.stop_date>=${asOf}::date AND NOT c.org_id=ANY(p.visited)
    ), candidates AS (
      SELECT e.id,e.code,paths.path AS department_path,jpost.code COLLATE "C" AS post_code,
        jp.display_order AS position_order,jl.level AS level_number,jg.grade AS grade_number
      FROM employment_employees e ${employeeJoins(ctx)}
      LEFT JOIN paths ON paths.org_id=(r.current_fields->>'department_id')::uuid
      WHERE e.tenant_id=${ctx.tenantId} AND r.id IS NOT NULL
    ), ranked AS (
      SELECT id,${enabled ? sql`rank() OVER (ORDER BY ${sql.join(order, sql`,`)})::int` : sql`NULL::int`} AS n
      FROM candidates
    ), previous AS MATERIALIZED (
      SELECT employee_id,order_code FROM personnel_employee_order_codes WHERE tenant_id=${ctx.tenantId}
    ), changed AS (
      INSERT INTO personnel_employee_order_codes AS target(tenant_id,employee_id,order_code)
      SELECT e.tenant_id,e.id,r.n FROM employment_employees e LEFT JOIN ranked r ON r.id=e.id
      WHERE e.tenant_id=${ctx.tenantId} ORDER BY e.id
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
  await tx.execute(sql`INSERT INTO personnel_order_runs(tenant_id,command_id,state,attempts,ran_at)
    VALUES (${ctx.tenantId},${ctx.commandId},'succeeded',1,${ctx.now.toISOString()}::timestamptz)
    ON CONFLICT (tenant_id,command_id) DO UPDATE SET state='succeeded',attempts=personnel_order_runs.attempts+1,
      error=NULL,ran_at=EXCLUDED.ran_at`);
  return { revision: config.revision, changed: result!.changed, businessDate: asOf };
}
