/**
 * 两层配置（REQ-TEN-001 R3；docs/02_业务建模/11 §13.1）：有效值 = 租户覆盖 ?? 系统预置；恢复 = 删除覆盖。
 * 覆盖与恢复都在同一租户事务内写审计（AGENTS.md §10「审计」），revision 不一致一律 409。
 * revision 语义：0 表示“当前无覆盖、取系统值”；覆盖行从 1 起递增。
 */
import {
  and,
  auditEvents,
  eq,
  pgErrorCode,
  type SystemSetting,
  systemSettings,
  type TenantSettingOverride,
  tenantSettingOverrides,
  type Tx,
} from '@italent/db';
import { AppError } from '../../errors.js';

export interface EffectiveSetting {
  readonly key: string;
  readonly value: unknown;
  readonly source: 'system' | 'tenant';
  readonly revision: number;
  readonly systemVersion: number;
  readonly overridable: boolean;
}

export interface SettingWrite {
  readonly tenantId: string;
  readonly userId: string;
  readonly key: string;
  readonly expectedRevision: number;
  readonly now: Date;
  readonly commandId: string | null;
}

export async function readEffectiveSetting(tx: Tx, tenantId: string, key: string): Promise<EffectiveSetting> {
  const system = await loadSystemSetting(tx, key);
  const override = await loadOverride(tx, tenantId, key);
  return effective(system, override);
}

export async function overrideSetting(tx: Tx, write: SettingWrite, value: unknown): Promise<EffectiveSetting> {
  const system = await loadSystemSetting(tx, write.key);
  if (!system.overridable) throw new AppError('SETTING_READ_ONLY', '该配置为系统预置只读，不可覆盖');
  const current = await loadOverride(tx, write.tenantId, write.key);
  assertRevision(write.expectedRevision, current);

  const next = { value, revision: write.expectedRevision + 1, updatedBy: write.userId, updatedAt: write.now };
  const [saved] = current
    ? await tx
        .update(tenantSettingOverrides)
        .set(next)
        .where(and(overrideKey(write.tenantId, write.key), eq(tenantSettingOverrides.revision, current.revision)))
        .returning()
    : await insertOverride(tx, { tenantId: write.tenantId, key: write.key, ...next });
  if (!saved) throw revisionConflict(write.expectedRevision, undefined);

  await audit(tx, write, 'tenant_setting.override', snapshot(current), snapshot(saved));
  return effective(system, saved);
}

/** 恢复为系统值。当前本就没有覆盖时是无副作用的空操作（不写审计）。 */
export async function restoreSetting(tx: Tx, write: SettingWrite): Promise<EffectiveSetting> {
  const system = await loadSystemSetting(tx, write.key);
  const current = await loadOverride(tx, write.tenantId, write.key);
  assertRevision(write.expectedRevision, current);
  if (!current) return effective(system, undefined);

  const deleted = await tx
    .delete(tenantSettingOverrides)
    .where(and(overrideKey(write.tenantId, write.key), eq(tenantSettingOverrides.revision, current.revision)))
    .returning();
  if (deleted.length === 0) throw revisionConflict(write.expectedRevision, undefined);

  await audit(tx, write, 'tenant_setting.restore', snapshot(current), null);
  return effective(system, undefined);
}

async function loadSystemSetting(tx: Tx, key: string): Promise<SystemSetting> {
  const [system] = await tx.select().from(systemSettings).where(eq(systemSettings.key, key));
  if (!system) throw new AppError('NOT_FOUND', '配置项不存在');
  return system;
}

async function loadOverride(tx: Tx, tenantId: string, key: string): Promise<TenantSettingOverride | undefined> {
  // 行锁：同一租户同一配置的并发写串行化，后到者在 revision 比对时得到 409
  const [row] = await tx.select().from(tenantSettingOverrides).where(overrideKey(tenantId, key)).for('update');
  return row;
}

async function insertOverride(tx: Tx, row: typeof tenantSettingOverrides.$inferInsert) {
  try {
    return await tx.insert(tenantSettingOverrides).values(row).returning();
  } catch (error) {
    // 并发的首次覆盖：主键冲突说明已被别人抢先覆盖
    if (pgErrorCode(error) === '23505') throw revisionConflict(0, undefined);
    throw error;
  }
}

function overrideKey(tenantId: string, key: string) {
  return and(eq(tenantSettingOverrides.tenantId, tenantId), eq(tenantSettingOverrides.key, key));
}

function assertRevision(expected: number, current: TenantSettingOverride | undefined): void {
  const actual = current?.revision ?? 0;
  if (expected !== actual) throw revisionConflict(expected, actual);
}

function revisionConflict(expected: number, actual: number | undefined): AppError {
  return new AppError('REVISION_CONFLICT', '配置已被他人修改，请刷新后重试', { expected, actual });
}

function effective(system: SystemSetting, override: TenantSettingOverride | undefined): EffectiveSetting {
  const base = { key: system.key, systemVersion: system.version, overridable: system.overridable };
  return override
    ? { ...base, value: override.value, source: 'tenant', revision: override.revision }
    : { ...base, value: system.value, source: 'system', revision: 0 };
}

function snapshot(row: TenantSettingOverride | undefined) {
  return row ? { value: row.value, revision: row.revision } : null;
}

async function audit(tx: Tx, write: SettingWrite, action: string, before: unknown, after: unknown): Promise<void> {
  await tx.insert(auditEvents).values({
    tenantId: write.tenantId,
    actorUserId: write.userId,
    action,
    objectType: 'tenant_setting',
    objectId: write.key,
    before,
    after,
    occurredAt: write.now,
    commandId: write.commandId,
  });
}
