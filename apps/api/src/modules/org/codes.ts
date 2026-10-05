import {
  and,
  eq,
  orgCodeReservations,
  orgHierarchyLinks,
  orgObjects,
  orgSettings,
  orgVersions,
  sql,
  type Tx,
} from '@italent/db';
import { AppError } from '../../errors.js';
import { recordAudit } from '../../audit/record.js';

export interface OrgSetupContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly rootName: string;
  readonly now: Date;
  readonly commandId: string;
  readonly expectedRevision: number;
}

/** 全部编码写入先锁同一租户设置行，避免跨“实体/预占”两表抢码（REQ-ORG-002）。 */
export async function ensureOrgSetup(tx: Tx, ctx: OrgSetupContext): Promise<void> {
  await tx.insert(orgSettings).values({ tenantId: ctx.tenantId }).onConflictDoNothing();
  await tx.select().from(orgSettings).where(eq(orgSettings.tenantId, ctx.tenantId)).for('update');
  const [existing] = await tx.select().from(orgObjects).where(eq(orgObjects.id, ctx.tenantId));
  if (existing) return;
  await tx.insert(orgObjects).values({ id: ctx.tenantId, tenantId: ctx.tenantId });
  const [version] = await tx
    .insert(orgVersions)
    .values({
      tenantId: ctx.tenantId,
      orgId: ctx.tenantId,
      versionNo: 1,
      code: 'ROOT',
      name: ctx.rootName,
      fullName: ctx.rootName,
      startDate: '0001-01-01',
      level: 0,
    })
    .returning();
  if (!version) throw new AppError('SERVICE_UNAVAILABLE', '无法初始化租户组织根');
  await tx.insert(orgHierarchyLinks).values({ tenantId: ctx.tenantId, versionId: version.id, dimension: 'admin' });
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    objectType: 'organization',
    objectId: ctx.tenantId,
    action: 'org.initialize',
    before: null,
    after: { id: ctx.tenantId, name: ctx.rootName, code: 'ROOT' },
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
}

export async function assertCodeAvailable(
  tx: Tx,
  ctx: OrgSetupContext,
  code: string,
  asOf: string,
  exceptOrgId?: string,
) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(code) || code === 'ROOT') {
    throw new AppError('VALIDATION_FAILED', '机构编码格式不合法或为保留编码');
  }
  const objects = await tx.execute(sql`
    SELECT org_id FROM (
      SELECT org_id, code, start_date, stop_date,
        lead(start_date) OVER (PARTITION BY org_id ORDER BY start_date, version_no) AS next_start
      FROM org_versions WHERE tenant_id = ${ctx.tenantId}
    ) version_intervals
    WHERE code = ${code}
      AND org_id <> ${exceptOrgId ?? '00000000-0000-0000-0000-000000000000'}
      AND start_date <= '9999-12-31'
      AND LEAST(stop_date, COALESCE(next_start - 1, stop_date)) >= ${asOf}
    LIMIT 1
  `);
  const [held] = await tx
    .select()
    .from(orgCodeReservations)
    .where(
      and(
        eq(orgCodeReservations.code, code),
        eq(orgCodeReservations.state, 'held'),
        sql`${orgCodeReservations.expiresAt} > ${ctx.now.toISOString()}`,
      ),
    );
  const rows = Array.isArray(objects) ? objects : (objects as { rows: unknown[] }).rows;
  if (rows.length || held) {
    throw new AppError('CONFLICT', '机构编码已使用或被预占', { reason: 'CODE_CONFLICT' });
  }
}

export async function reserveCode(tx: Tx, ctx: OrgSetupContext) {
  await ensureOrgSetup(tx, ctx);
  await tx
    .update(orgCodeReservations)
    .set({ state: 'released' })
    .where(
      and(eq(orgCodeReservations.state, 'held'), sql`${orgCodeReservations.expiresAt} <= ${ctx.now.toISOString()}`),
    );
  const reusable = await tx.execute(sql`
    SELECT r.code
    FROM org_code_reservations r
    WHERE r.tenant_id = ${ctx.tenantId}
      AND r.state = 'released'
      AND NOT EXISTS (SELECT 1 FROM org_versions v WHERE v.tenant_id = r.tenant_id AND v.code = r.code)
      AND NOT EXISTS (
        SELECT 1 FROM org_code_reservations h
        WHERE h.tenant_id = r.tenant_id AND h.code = r.code
          AND h.state = 'held' AND h.expires_at > ${ctx.now.toISOString()}
      )
    ORDER BY r.code LIMIT 1
  `);
  const reusableRows = (Array.isArray(reusable) ? reusable : (reusable as { rows: { code: string }[] }).rows) as {
    code: string;
  }[];
  let code = reusableRows[0]?.code;
  if (!code) code = await nextCode(tx, ctx);
  const [reservation] = await tx
    .insert(orgCodeReservations)
    .values({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      code,
      reservedAt: ctx.now,
      expiresAt: new Date(ctx.now.getTime() + 30 * 60 * 1000),
    })
    .returning();
  if (!reservation) throw new AppError('SERVICE_UNAVAILABLE', '编码预占失败');
  await reservationAudit(tx, ctx, reservation.id, 'org.code.reserve', null, reservation);
  return { id: reservation.id, code: reservation.code, revision: reservation.revision };
}

async function available(tx: Tx, code: string): Promise<boolean> {
  const orgs = await tx.execute(sql`SELECT 1 FROM org_versions WHERE code = ${code} LIMIT 1`);
  const [held] = await tx
    .select()
    .from(orgCodeReservations)
    .where(and(eq(orgCodeReservations.code, code), eq(orgCodeReservations.state, 'held')));
  const rows = Array.isArray(orgs) ? orgs : (orgs as { rows: unknown[] }).rows;
  return rows.length === 0 && !held;
}

async function nextCode(tx: Tx, ctx: OrgSetupContext): Promise<string> {
  const [settings] = await tx.select().from(orgSettings).where(eq(orgSettings.tenantId, ctx.tenantId));
  let next = settings?.nextCodeNumber ?? 1;
  while (next < 2_147_483_647) {
    const code = `zz${String(next++).padStart(5, '0')}`;
    if (!(await available(tx, code))) continue;
    await tx.update(orgSettings).set({ nextCodeNumber: next }).where(eq(orgSettings.tenantId, ctx.tenantId));
    return code;
  }
  throw new AppError('CONFLICT', '机构编码空间已用尽');
}

export async function releaseCode(tx: Tx, ctx: OrgSetupContext, id: string) {
  await ensureOrgSetup(tx, ctx);
  const row = await ownedReservation(tx, ctx, id);
  if (row.revision !== ctx.expectedRevision) throw new AppError('REVISION_CONFLICT', '编码预占版本已变化');
  if (row.state !== 'held') throw new AppError('CONFLICT', '编码预占已结束');
  const [released] = await tx
    .update(orgCodeReservations)
    .set({ state: 'released', revision: row.revision + 1 })
    .where(eq(orgCodeReservations.id, id))
    .returning();
  await reservationAudit(tx, ctx, id, 'org.code.release', row, released);
  return { id, code: row.code, status: 'released', revision: released!.revision };
}

export async function consumeCode(tx: Tx, ctx: OrgSetupContext, input: { reservationId?: string; code?: string }) {
  await ensureOrgSetup(tx, ctx);
  if (input.code && !input.reservationId) {
    await assertCodeAvailable(tx, ctx, input.code, ctx.now.toISOString().slice(0, 10));
    return input.code;
  }
  const id = input.reservationId ?? (await reserveCode(tx, ctx)).id;
  const row = await ownedReservation(tx, ctx, id);
  if (row.state !== 'held' || row.expiresAt <= ctx.now || (input.code && input.code !== row.code)) {
    throw new AppError('CONFLICT', '编码预占不可用', { reason: 'RESERVATION_UNAVAILABLE' });
  }
  await tx
    .update(orgCodeReservations)
    .set({ state: 'consumed', revision: row.revision + 1 })
    .where(eq(orgCodeReservations.id, row.id));
  await reservationAudit(tx, ctx, row.id, 'org.code.consume', row, {
    ...row,
    state: 'consumed',
    revision: row.revision + 1,
  });
  return row.code;
}

async function ownedReservation(tx: Tx, ctx: OrgSetupContext, id: string) {
  const [row] = await tx.select().from(orgCodeReservations).where(eq(orgCodeReservations.id, id)).for('update');
  if (!row || row.userId !== ctx.userId) throw new AppError('NOT_FOUND', '编码预占不存在');
  return row;
}

async function reservationAudit(
  tx: Tx,
  ctx: OrgSetupContext,
  id: string,
  action: string,
  before: unknown,
  after: unknown,
) {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    action,
    objectType: 'org_code_reservation',
    objectId: id,
    before,
    after,
    occurredAt: ctx.now,
    commandId: ctx.commandId,
  });
}
