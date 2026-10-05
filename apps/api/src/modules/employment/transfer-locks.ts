/** F-008：一次生效涉及的员工先按 UUID 取锁，再锁业务头，最后由审批入口锁实例。
 * 锁内重读参与者；等待期间载荷新增了参与者时返回 409，由调用方刷新后显式重提。
 * 事务本地设置跟随保存点回滚，不能用进程缓存替代数据库持锁事实。
 */
import { isUuid, sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

const SETTING = 'italent.transfer_employee_locks';
const array = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

async function participants(tx: Tx, ctx: EmploymentContext, employeeId: string, extra: readonly string[]) {
  const ids = new Set([employeeId, ...extra].map((id) => id.toLowerCase()));
  for (;;) {
    const rows = rowsOf<{ ids: string[] | null }>(
      await tx.execute(sql`
      SELECT p.added_subordinate_ids AS ids FROM employment_business_objects b
      JOIN LATERAL (SELECT kind, added_subordinate_ids FROM employment_payload_versions p
        WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id ORDER BY version_no DESC LIMIT 1) p ON true
      JOIN LATERAL (SELECT state FROM employment_state_events s
        WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id ORDER BY event_no DESC LIMIT 1) s ON true
      WHERE b.tenant_id=${ctx.tenantId} AND b.employee_id=ANY(${array([...ids])})
        AND p.kind='transfer' AND s.state NOT IN ('deleted','disapproved','voided')
        AND NOT EXISTS (SELECT 1 FROM employment_outbox o WHERE o.tenant_id=b.tenant_id
          AND o.business_id=b.id AND o.event_type='employment.transfer.linked')
    `),
    );
    const size = ids.size;
    rows.forEach((row) => row.ids?.forEach((id) => ids.add(id)));
    if (ids.size > 1000) throw new AppError('PAYLOAD_TOO_LARGE', '调动联动参与人员超过处理上限');
    if (ids.size === size) return [...ids].sort();
  }
}

export async function lockTransferParticipants(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  extra: readonly string[] = [],
  options: { skipLocked?: boolean } = {},
): Promise<boolean> {
  if (![employeeId, ...extra].every(isUuid)) throw new AppError('VALIDATION_FAILED', '员工标识必须是 UUID');
  employeeId = employeeId.toLowerCase();
  extra = [...new Set(extra.map((id) => id.toLowerCase()))];
  const planned = await participants(tx, ctx, employeeId, extra);
  const [setting] = rowsOf<{ value: string | null }>(
    await tx.execute(sql`SELECT current_setting(${SETTING}, true) AS value`),
  );
  const held: string[] = setting?.value ? (JSON.parse(setting.value) as string[]) : [];
  const needed = planned.filter((id) => !held.includes(id));
  if (!needed.length) return true;
  if (held.length && needed[0]! < held.at(-1)!)
    throw new AppError('CONFLICT', '联动参与人员已变化，请刷新后重试', { reason: 'TRANSFER_LOCK_PLAN_CHANGED' });
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`
    SELECT id FROM employment_employees WHERE tenant_id=${ctx.tenantId} AND id=ANY(${array(needed)})
    ORDER BY id FOR NO KEY UPDATE ${options.skipLocked ? sql`SKIP LOCKED` : sql``}
  `),
  );
  if (rows.length !== needed.length) {
    if (options.skipLocked) return false;
    if (!held.includes(employeeId) && !rows.some((row) => row.id === employeeId))
      throw new AppError('NOT_FOUND', '员工不存在');
    throw new AppError('VALIDATION_FAILED', '联动人员不可用', { reason: 'TRANSFER_PERSON_NOT_ELIGIBLE' });
  }
  const all = [...held, ...needed];
  {
    const actual = await participants(tx, ctx, employeeId, extra);
    if (actual.some((id) => !all.includes(id)))
      throw new AppError('CONFLICT', '联动参与人员已变化，请刷新后重试', { reason: 'TRANSFER_LOCK_PLAN_CHANGED' });
  }
  await tx.execute(sql`SELECT set_config(${SETTING},${JSON.stringify(all)},true)`);
  // 各参与者的业务头在审批实例之前取锁；员工锁保证业务集合不会再被其他事务改写。
  if (planned.length > 1)
    await tx.execute(sql`
    SELECT id FROM employment_business_objects WHERE tenant_id=${ctx.tenantId} AND employee_id=ANY(${array(planned)})
    ORDER BY employee_id,id FOR UPDATE
  `);
  return true;
}

/** 审批适配器须在实例锁之前调用；批量交接会签合席可推进业务，批次须先锁整个参与员工闭包。 */
export async function lockTransferBusiness(tx: Tx, ctx: EmploymentContext, businessId: string) {
  if (!isUuid(businessId)) throw new AppError('VALIDATION_FAILED', '业务标识必须是 UUID');
  const [row] = rowsOf<{ employeeId: string; kind: string }>(
    await tx.execute(sql`
    SELECT b.employee_id AS "employeeId", p.kind FROM employment_business_objects b
    JOIN LATERAL (SELECT kind FROM employment_payload_versions p
      WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id ORDER BY version_no DESC LIMIT 1) p ON true
    WHERE b.tenant_id=${ctx.tenantId} AND b.id=${businessId}::uuid
  `),
  );
  if (row?.kind === 'transfer') await lockTransferParticipants(tx, ctx, row.employeeId);
}
