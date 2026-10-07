import { eq, establishmentNotifications, establishmentOutbox, establishmentSettings, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { lockOrganizationSettings } from '../org/locks.js';
import { AppError } from '../../errors.js';
import { validIsoDate } from '../org/read-model.js';
import { ensureDefaultScheme } from './default-scheme.js';
import { recordAudit } from '../../audit/record.js';

export interface CapacityScopeTarget {
  readonly operation: 'create' | 'update';
  readonly id?: string;
  readonly orgId: string;
  readonly linked?: boolean;
}

export interface EstablishmentContext {
  readonly tenantId: string;
  readonly userId: string | null;
  readonly timezone: string;
  readonly now: Date;
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly authorizeCapacityScope?: (tx: Tx, target: CapacityScopeTarget) => Promise<void>;
  readonly authorizeCapacity?: (
    tx: Tx,
    change: CapacityScopeTarget & {
      readonly payload: Readonly<Record<string, unknown>>;
    },
  ) => Promise<void>;
}

/** 容量、方案、占编和复制共用租户锁，避免“分别合法、合起来超编”的并发写入。 */
export async function lockEstablishment(
  tx: Tx,
  ctx: EstablishmentContext,
  options: { initializeDefault?: boolean } = {},
): Promise<void> {
  // 全局 org → establishment 顺序见 org/locks.ts；预检、落地、重试、编制携带不得各自倒序。
  await lockOrganizationSettings(tx, ctx.tenantId);
  await tx.insert(establishmentSettings).values({ tenantId: ctx.tenantId }).onConflictDoNothing();
  await tx.select().from(establishmentSettings).where(eq(establishmentSettings.tenantId, ctx.tenantId)).for('update');
  if (options.initializeDefault !== false) await ensureDefaultScheme(tx, ctx);
}

export function assertRevision(expected: number, actual: number): void {
  if (expected !== actual) {
    throw new AppError('REVISION_CONFLICT', '编制已被他人修改，请刷新后显式重提', { expected, actual });
  }
}

export function invalid(field: string, message: string): AppError {
  return new AppError('VALIDATION_FAILED', message, { fields: { [field]: message } });
}

export function businessDate(value: string, field = 'effectiveDate'): string {
  if (typeof value !== 'string' || !validIsoDate(value)) throw invalid(field, '业务日期必须为合法 YYYY-MM-DD');
  return value;
}

export function today(ctx: EstablishmentContext): string {
  return tenantLocalDate(ctx.now, ctx.timezone);
}

export function nonnegative(value: number | null | undefined, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    throw invalid(field, '编制必须为非负整数');
  }
  return value;
}

export function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

export async function audit(
  tx: Tx,
  ctx: EstablishmentContext,
  action: string,
  objectType: string,
  objectId: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    action,
    objectType,
    objectId,
    before,
    after,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
  await tx.insert(establishmentOutbox).values({
    tenantId: ctx.tenantId,
    eventType: action,
    objectId,
    payload: { objectType, before, after, commandId: ctx.commandId },
    createdAt: ctx.now,
  });
}

export async function notify(
  tx: Tx,
  ctx: EstablishmentContext,
  reason: string,
  reference: { jobId?: string; movementId?: string; attempt: number; recipientUserId?: string | null },
): Promise<void> {
  const [notice] = await tx
    .insert(establishmentNotifications)
    .values({ tenantId: ctx.tenantId, recipientUserId: ctx.userId, reason, ...reference, createdAt: ctx.now })
    .returning();
  if (!notice) throw new AppError('SERVICE_UNAVAILABLE', '无法生成编制通知');
  await audit(tx, ctx, 'establishment.notification.queued', 'establishment-notification', notice.id, null, notice);
}
