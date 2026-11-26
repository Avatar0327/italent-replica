/** F-008：一次生效涉及的员工（含新增下属与 R1-T10 职责转交的下属；离职的转交下属同理，R2-T03 §5.2 ①）先按 UUID 取锁，再锁业务头，最后由审批入口锁实例。
 * 锁内重读参与者；等待期间载荷新增了参与者时返回 409，由调用方刷新后显式重提。
 * 事务本地设置跟随保存点回滚，不能用进程缓存替代数据库持锁事实。
 */
import { isUuid, sql, type Tx } from '@italent/db';
import { pendingClearSubordinates } from './exit-duty-participants.js';
import { remainingExitDuties } from './exit-replacement-plan.js';
import { AppError } from '../../errors.js';
import { partTimeLinkageParticipants } from './part-time/linkage-participants.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

// DEC-142：全局账号命令会依次进入多个租户，持锁记录也必须按租户隔离。
const settingKey = (tenantId: string) => `italent.transfer_employee_locks_${tenantId.replaceAll('-', '')}`;
// DEC-993：同单写入口把所有会阻塞的取锁做完、读完授权后封口——封口后本事务再需要新锁一律 409，不再等锁。
const sealKey = (tenantId: string) => `italent.transfer_locks_sealed_${tenantId.replaceAll('-', '')}`;
const array = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

async function participants(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  extra: readonly string[],
  rescheduledExitId?: string,
) {
  const ids = new Set([employeeId, ...extra].map((id) => id.toLowerCase()));
  // F-140b2：后继会重新执行旧失败职责；普通闭包的“已有执行行”排除规则不能用于这份剩余计划。
  if (rescheduledExitId) {
    const remaining = await remainingExitDuties(tx, ctx.tenantId, rescheduledExitId);
    remaining?.dutyTransfer.subordinates.forEach((d) => ids.add(d.employeeId));
  }
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
    // R2-T09b DT-R5：落地时会被清空上级的下属也要在预锁集合里（见 exit-duty-participants.ts）
    const cleared = { ids: await pendingClearSubordinates(tx, ctx, [...ids]) };
    const size = ids.size;
    [...rows, ...linkage, cleared].forEach((row) => row.ids?.forEach((id) => ids.add(id)));
    if (ids.size > 1000) throw new AppError('PAYLOAD_TOO_LARGE', '调动联动参与人员超过处理上限');
    if (ids.size === size) return [...ids].sort();
  }
}

async function isSealed(tx: Tx, ctx: EmploymentContext) {
  const [row] = rowsOf<{ value: string | null }>(
    await tx.execute(sql`SELECT current_setting(${sealKey(ctx.tenantId)}, true) AS value`),
  );
  return row?.value === 'on';
}

async function heldIds(tx: Tx, ctx: EmploymentContext): Promise<string[]> {
  const [setting] = rowsOf<{ value: string | null }>(
    await tx.execute(sql`SELECT current_setting(${settingKey(ctx.tenantId)}, true) AS value`),
  );
  return setting?.value ? (JSON.parse(setting.value) as string[]) : [];
}

/** 现在重新规划出的参与员工是否都已在本事务的持锁集合内（只读、不取锁）：取锁之后集合又变大则为 false。 */
export async function transferLocksCover(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  extra: readonly string[] = [],
  rescheduledExitId?: string,
): Promise<boolean> {
  const held = new Set(await heldIds(tx, ctx));
  const planned = await participants(
    tx,
    ctx,
    employeeId.toLowerCase(),
    extra.map((id) => id.toLowerCase()),
    rescheduledExitId,
  );
  return planned.every((id) => held.has(id));
}

/**
 * 封口（DEC-993 单入口）：调用方已取齐全部会阻塞的锁、且 transferLocksCover 为真之后、读授权输入之前调用。
 * 事务本地设置，跟随事务 / 保存点回滚；封口后 acquire 遇到未持有的参与员工直接 409，不再等锁。
 */
export async function sealTransferLocks(tx: Tx, ctx: EmploymentContext): Promise<void> {
  await tx.execute(sql`SELECT set_config(${sealKey(ctx.tenantId)},'on',true)`);
}

/** 取锁结果：busy = 有参与者行被他人持锁（SKIP LOCKED 跳过）；missing = 员工主档本身不存在（F-238，两者不能混为一谈）。 */
export type SweepLockOutcome = 'acquired' | 'busy' | 'missing';

interface AcquireOptions {
  readonly skipLocked?: boolean;
  readonly rescheduledExitId?: string;
  /** 只取员工锁，业务头留给调用方在员工闭包取齐之后用 lockTransferHeads 统一取（同单写入口的补锁循环，DEC-996）。 */
  readonly deferHeads?: boolean;
  /** 组织调整执行器：单人闭包也提前取本人业务头，保持“员工 → 业务头 → 调整单”的锁序。 */
  readonly lockBusinessHeads?: boolean;
}

async function acquire(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  extra: readonly string[],
  options: AcquireOptions,
): Promise<SweepLockOutcome> {
  const { skipLocked = false, rescheduledExitId } = options;
  if (![employeeId, ...extra].every(isUuid)) throw new AppError('VALIDATION_FAILED', '员工标识必须是 UUID');
  employeeId = employeeId.toLowerCase();
  extra = [...new Set(extra.map((id) => id.toLowerCase()))];
  const planned = await participants(tx, ctx, employeeId, extra, rescheduledExitId);
  const held = await heldIds(tx, ctx);
  const needed = planned.filter((id) => !held.includes(id));
  if (!needed.length) return 'acquired';
  // 已封口：授权输入在封口前一次读完，之后不得再因新进参与者阻塞等锁（等锁期间收回的授权会被漏掉）；放弃本事务，
  // 由调用方按既有 TRANSFER_LOCK_PLAN_CHANGED 约定刷新后重入，重入时先取齐锁再读授权。
  if (await isSealed(tx, ctx)) {
    // 封口后才进来的不存在 / 跨租户 / 非本租户人员不是“计划变了”，而是本来就不合格：与未封口路径同为 400，
    // 不得因同单写入口先封口而改报 409（F-560）。已存在的新参与者才按计划变化放弃本事务。
    const present = new Set((await existingTransferEmployees(tx, ctx, needed)).map((id) => id.toLowerCase()));
    if (needed.some((id) => !present.has(id)))
      throw new AppError('VALIDATION_FAILED', '联动人员不可用', { reason: 'TRANSFER_PERSON_NOT_ELIGIBLE' });
    throw new AppError('CONFLICT', '联动参与人员已变化，请刷新后重试', { reason: 'TRANSFER_LOCK_PLAN_CHANGED' });
  }
  if (held.length && needed[0]! < held.at(-1)!)
    throw new AppError('CONFLICT', '联动参与人员已变化，请刷新后重试', { reason: 'TRANSFER_LOCK_PLAN_CHANGED' });
  // F-519 的双退让源于 SKIP LOCKED 整组扫描越过忙行抢后续行，两个实例各持半组。
  // 非阻塞路径按 UUID 逐行取锁，首个缺锁即停。阻塞路径整组按同一顺序取锁（兼职设计 §7.1）。
  const groups = skipLocked ? needed.map((id) => [id]) : [needed];
  const rows: { id: string }[] = [];
  for (const ids of groups) {
    const locked = rowsOf<{ id: string }>(
      await tx.execute(sql`
    SELECT id FROM employment_employees WHERE tenant_id=${ctx.tenantId} AND id=ANY(${array(ids)})
    ORDER BY id FOR NO KEY UPDATE ${skipLocked ? sql`SKIP LOCKED` : sql``}
  `),
    );
    rows.push(...locked);
    if (locked.length !== ids.length) break;
  }
  if (rows.length !== needed.length) {
    if (skipLocked) return (await employeeExists(tx, ctx, employeeId, rows)) ? 'busy' : 'missing';
    if (!held.includes(employeeId) && !rows.some((row) => row.id === employeeId))
      throw new AppError('NOT_FOUND', '员工不存在');
    throw new AppError('VALIDATION_FAILED', '联动人员不可用', { reason: 'TRANSFER_PERSON_NOT_ELIGIBLE' });
  }
  const all = [...held, ...needed];
  {
    const actual = await participants(tx, ctx, employeeId, extra, rescheduledExitId);
    if (actual.some((id) => !all.includes(id)))
      throw new AppError('CONFLICT', '联动参与人员已变化，请刷新后重试', { reason: 'TRANSFER_LOCK_PLAN_CHANGED' });
  }
  await tx.execute(sql`SELECT set_config(${settingKey(ctx.tenantId)},${JSON.stringify(all)},true)`);
  if (!options.deferHeads) await lockHeads(tx, ctx, planned, options.lockBusinessHeads === true);
  return 'acquired';
}

/** 各参与者的业务头在审批实例之前取锁；员工锁保证业务集合不会再被其他事务改写。 */
async function lockHeads(tx: Tx, ctx: EmploymentContext, ids: readonly string[], force = false) {
  // force：组织调整执行器单人闭包也要在组织调整单锁之前先取本人业务头（§9.1 锁序）。
  if (force || ids.length > 1)
    await tx.execute(sql`
    SELECT id FROM employment_business_objects WHERE tenant_id=${ctx.tenantId} AND employee_id=ANY(${array(ids)})
    ORDER BY employee_id,id FOR UPDATE
  `);
}

/**
 * 员工闭包已取齐（transferLocksCover 为真）之后统一锁持锁集合内各参与者的业务头（DEC-996 拆段）。
 * 补锁循环里只取员工锁，等丙的员工锁时手上不会已有甲、乙的业务头（锁序：参与员工 → 业务头 → 审批实例）。
 * 单人闭包（持锁集合只有发起员工）lockHeads 不取业务头，这里补锁本单业务头（第 7 轮 P2-1，DEC-999）：否则守卫封口、
 * 读完授权后，首次执行（lockEmploymentBusiness）才在本单业务头上等锁，等锁期间收回的范围会被漏掉。
 * 这把锁就是首次执行本来要取的那一把（发起员工行已持有，同一顺序），只是提前到读授权之前；执行体里再取是重入。
 */
export async function lockTransferHeads(tx: Tx, ctx: EmploymentContext, businessId?: string): Promise<void> {
  const held = await heldIds(tx, ctx);
  if (held.length > 1) return lockHeads(tx, ctx, held);
  // 还没有本单业务头的入口（发起调动）单人闭包没有头可锁；覆盖暂存的旧草稿头由 lockSameOrderTarget 另行提前锁（F-560 第 2 轮 P2-1）。
  if (!businessId) return;
  await tx.execute(sql`
    SELECT id FROM employment_business_objects WHERE tenant_id=${ctx.tenantId} AND id=${businessId}::uuid FOR UPDATE
  `);
}

/**
 * 持锁集合内全部参与者的业务头（含单人闭包的本人全部头）按 员工 → 头 序统一取锁。F-565 第 2 轮 P2-2：离职改期 / 生效重试 /
 * 直接生效作废转正等执行体会在读授权之后才 lockOtherBusinessHeads；这些入口的守卫带 allHeads，把同一批头提前到读授权之前，
 * 执行体里的再取是重入。必须在员工闭包取齐之后调用（锁序：员工 → 业务头）。
 */
export async function lockAllParticipantHeads(tx: Tx, ctx: EmploymentContext): Promise<void> {
  await lockHeads(tx, ctx, await heldIds(tx, ctx), true);
}

/**
 * 请求里点名的员工中现在存在的那些（普通读，不取锁、不被行锁阻塞）。员工主档不删除、标识由服务端生成，
 * 存在与否在本事务内是稳定事实；查无此人的不取锁，留给首次执行的业务校验（DEC-996，见 lockSameOrderTarget）。
 */
export async function existingTransferEmployees(
  tx: Tx,
  ctx: EmploymentContext,
  ids: readonly string[],
): Promise<string[]> {
  // 不是 UUID 的同样当作查无此人（入口 schema 已拦，这里不抛错：抛错同样会抢在指纹比对之前）。
  const candidates = ids.filter(isUuid);
  if (!candidates.length) return [];
  const found = rowsOf<{ id: string }>(
    await tx.execute(sql`
    SELECT id::text AS id FROM employment_employees WHERE tenant_id=${ctx.tenantId} AND id=ANY(${array(candidates)})
  `),
  );
  const present = new Set(found.map((row) => row.id.toLowerCase()));
  return candidates.filter((id) => present.has(id.toLowerCase()));
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
  options: AcquireOptions = {},
): Promise<SweepLockOutcome> => acquire(tx, ctx, employeeId, extra, options);

/** §9.1：取组织锁后只复核闭包，禁止在较晚的锁级补取员工或业务头。 */
export async function assertTransferPlanHeld(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  extra: readonly string[],
) {
  const actual = await participants(tx, ctx, employeeId, extra);
  const held = new Set(await heldIds(tx, ctx));
  if (actual.some((id) => !held.has(id)))
    throw new AppError('CONFLICT', '联动参与人员已变化，请刷新后重试', { reason: 'ORG_EMPLOYMENT_PLAN_CHANGED' });
}

/**
 * 断言这些员工的锁已在本事务的预锁集合内（落地 / 执行只能重入、复核，不得再新取员工锁：新取会在持组织锁之后逆序，与先锁下属再取
 * 组织锁的事务成环）。不在集合内说明某条入口没经 lockTransferParticipants 规划完整参与者——抛内部错误，开发期即暴露，不静默补锁。
 */
export async function assertEmployeeLocksHeld(tx: Tx, ids: readonly string[]): Promise<void> {
  const [setting] = rowsOf<{ value: string | null }>(
    await tx.execute(
      sql`SELECT current_setting('italent.transfer_employee_locks_' ||
        replace(current_setting('app.tenant_id'),'-',''), true) AS value`,
    ),
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
