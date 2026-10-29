/** F-008：一次生效涉及的员工（含新增下属与 R1-T10 职责转交的下属；离职的转交下属同理，R2-T03 §5.2 ①）先按 UUID 取锁，再锁业务头，最后由审批入口锁实例。
 * 锁内重读参与者；等待期间载荷新增了参与者时返回 409，由调用方刷新后显式重提。
 * 事务本地设置跟随保存点回滚，不能用进程缓存替代数据库持锁事实。
 */
import { isUuid, sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { partTimeLinkageParticipants } from './part-time/linkage-participants.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

const SETTING = 'italent.transfer_employee_locks';
const array = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

async function participants(tx: Tx, ctx: EmploymentContext, employeeId: string, extra: readonly string[]) {
  const ids = new Set([employeeId, ...extra].map((id) => id.toLowerCase()));
  for (;;) {
    const rows = rowsOf<{ ids: string[] | null }>(
      await tx.execute(sql`
      SELECT p.added_subordinate_ids || COALESCE(duty.ids, '{}'::uuid[]) AS ids FROM employment_business_objects b
      JOIN LATERAL (SELECT kind, added_subordinate_ids FROM employment_payload_versions p
        WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id ORDER BY version_no DESC LIMIT 1) p ON true
      LEFT JOIN LATERAL (SELECT array_agg(d.subordinate_id) AS ids FROM transfer_linkage_duties d
        WHERE d.tenant_id=b.tenant_id AND d.subordinate_id IS NOT NULL AND d.version_id=(
          SELECT v.id FROM transfer_linkage_versions v WHERE v.tenant_id=b.tenant_id AND v.business_id=b.id
          ORDER BY v.version_no DESC LIMIT 1)) duty ON true
      JOIN LATERAL (SELECT state FROM employment_state_events s
        WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id ORDER BY event_no DESC LIMIT 1) s ON true
      WHERE b.tenant_id=${ctx.tenantId} AND b.employee_id=ANY(${array([...ids])})
        AND p.kind IN ('transfer','leave','retirement') AND s.state NOT IN ('deleted','disapproved','voided')
        AND NOT EXISTS (SELECT 1 FROM employment_outbox o WHERE o.tenant_id=b.tenant_id
          AND o.business_id=b.id AND o.event_type='employment.transfer.linked')
        AND NOT EXISTS (SELECT 1 FROM transfer_linkage_runs r WHERE r.tenant_id=b.tenant_id
          AND r.business_id=b.id AND p.kind IN ('leave','retirement'))
    `),
    );
    // PT-7：兼职联动（待执行 + 审批中的新增申请）的下属也在闭包里，所有入口按同一 UUID 升序取锁（兼职设计 §4.8 / §7.1）
    const linkage = (await partTimeLinkageParticipants(tx, ctx.tenantId, [...ids])).map((list) => ({ ids: list }));
    const size = ids.size;
    [...rows, ...linkage].forEach((row) => row.ids?.forEach((id) => ids.add(id)));
    if (ids.size > 1000) throw new AppError('PAYLOAD_TOO_LARGE', '调动联动参与人员超过处理上限');
    if (ids.size === size) return [...ids].sort();
  }
}

/** 取锁结果：busy = 有参与者行被他人持锁（SKIP LOCKED 跳过）；missing = 员工主档本身不存在（F-238，两者不能混为一谈）。 */
export type SweepLockOutcome = 'acquired' | 'busy' | 'missing';

async function acquire(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  extra: readonly string[],
  skipLocked: boolean,
): Promise<SweepLockOutcome> {
  if (![employeeId, ...extra].every(isUuid)) throw new AppError('VALIDATION_FAILED', '员工标识必须是 UUID');
  employeeId = employeeId.toLowerCase();
  extra = [...new Set(extra.map((id) => id.toLowerCase()))];
  const planned = await participants(tx, ctx, employeeId, extra);
  const [setting] = rowsOf<{ value: string | null }>(
    await tx.execute(sql`SELECT current_setting(${SETTING}, true) AS value`),
  );
  const held: string[] = setting?.value ? (JSON.parse(setting.value) as string[]) : [];
  const needed = planned.filter((id) => !held.includes(id));
  if (!needed.length) return 'acquired';
  if (held.length && needed[0]! < held.at(-1)!)
    throw new AppError('CONFLICT', '联动参与人员已变化，请刷新后重试', { reason: 'TRANSFER_LOCK_PLAN_CHANGED' });
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`
    SELECT id FROM employment_employees WHERE tenant_id=${ctx.tenantId} AND id=ANY(${array(needed)})
    ORDER BY id FOR NO KEY UPDATE ${skipLocked ? sql`SKIP LOCKED` : sql``}
  `),
  );
  if (rows.length !== needed.length) {
    if (skipLocked) return (await employeeExists(tx, ctx, employeeId, rows)) ? 'busy' : 'missing';
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
  return 'acquired';
}

/** SKIP LOCKED 跳过了行时区分原因：本人已取到（在 rows 里）或主档仍在 → 被锁；主档查不到 → 不存在。普通读不被行锁阻塞。 */
async function employeeExists(tx: Tx, ctx: EmploymentContext, employeeId: string, locked: readonly { id: string }[]) {
  if (locked.some((row) => row.id === employeeId)) return true;
  return (
    rowsOf(
      await tx.execute(
        sql`SELECT 1 FROM employment_employees WHERE tenant_id=${ctx.tenantId} AND id=${employeeId}::uuid`,
      ),
    ).length > 0
  );
}

/**
 * 取员工锁（含联动闭包）。默认阻塞等锁，员工不存在或联动人员不可用时抛错，返回值恒为 'acquired'（既有调用方都不看返回值）。
 * 定时批次传 skipLocked（非阻塞，只用于单名员工）：被他人持锁 → 'busy'（下一次调度重试）；员工主档不存在 → 'missing'
 * （没有可重试的对象，调用方收口，不当作被锁，F-238）。
 */
export const lockTransferParticipants = (
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  extra: readonly string[] = [],
  options: { skipLocked?: boolean } = {},
): Promise<SweepLockOutcome> => acquire(tx, ctx, employeeId, extra, options.skipLocked === true);

/**
 * 断言这些员工的锁已在本事务的预锁集合内（落地 / 执行只能重入、复核，不得再新取员工锁：新取会在持组织锁之后逆序，与先锁下属再取
 * 组织锁的事务成环）。不在集合内说明某条入口没经 lockTransferParticipants 规划完整参与者——抛内部错误，开发期即暴露，不静默补锁。
 */
export async function assertEmployeeLocksHeld(tx: Tx, ids: readonly string[]): Promise<void> {
  const [setting] = rowsOf<{ value: string | null }>(
    await tx.execute(sql`SELECT current_setting(${SETTING}, true) AS value`),
  );
  const held = new Set<string>(setting?.value ? (JSON.parse(setting.value) as string[]) : []);
  const missing = ids.map((id) => id.toLowerCase()).filter((id) => !held.has(id));
  if (missing.length)
    throw new Error(`联动参与者未在预锁集合内（入口须先经 lockLinkageParticipants 规划）：${missing.join(',')}`);
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
  if (row?.kind === 'transfer' || row?.kind === 'leave' || row?.kind === 'retirement')
    await lockTransferParticipants(tx, ctx, row.employeeId);
}
