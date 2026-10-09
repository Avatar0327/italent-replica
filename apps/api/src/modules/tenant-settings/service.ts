/**
 * 两层配置（REQ-TEN-001 R3；docs/02_业务建模/11 §13.1）：有效值 = 激活的租户覆盖 ?? 系统预置；
 * 恢复 = 覆盖行置为非激活（不删行）。覆盖与恢复都在同一租户事务内写审计（AGENTS.md §10「审计」）。
 * revision 语义：每个（租户, 配置）一行，从未覆盖过时为 0；覆盖、恢复各 +1，单调递增，
 * 所以恢复后持有旧 ETag 的客户端一定得到 409（无 ABA）。
 */
import {
  and,
  eq,
  pgErrorCode,
  type SystemSetting,
  systemSettings,
  type TenantSettingOverride,
  tenantSettingOverrides,
  type Tx,
} from '@italent/db';
import { AppError } from '../../errors.js';
import { recordAudit } from '../../audit/record.js';

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
  readonly commandId: string;
}

/** 按键登记的取值校验（业务模块在加载时登记，如继任开关）；未登记的键保持原样不校验。 */
const validators = new Map<string, (value: unknown) => boolean>();

export function registerSettingValidator(key: string, valid: (value: unknown) => boolean): void {
  const existing = validators.get(key);
  if (existing && existing !== valid) throw new Error(`配置键 ${key} 已登记了取值校验`);
  validators.set(key, valid);
}

export async function readEffectiveSetting(tx: Tx, tenantId: string, key: string): Promise<EffectiveSetting> {
  const system = await loadSystemSetting(tx, key);
  // 只读路径不加行锁：读者不应阻塞写者，也不需要 UPDATE 权限
  const [override] = await tx.select().from(tenantSettingOverrides).where(overrideKey(tenantId, key));
  return effective(system, override);
}

export async function overrideSetting(tx: Tx, write: SettingWrite, value: unknown): Promise<EffectiveSetting> {
  const system = await loadSystemSetting(tx, write.key);
  if (!system.overridable) throw new AppError('SETTING_READ_ONLY', '该配置为系统预置只读，不可覆盖');
  if (validators.get(write.key)?.(value) === false) {
    throw new AppError('VALIDATION_FAILED', '配置值不合法', { reason: 'SETTING_VALUE_INVALID', key: write.key });
  }
  const current = await loadOverrideForUpdate(tx, write.tenantId, write.key);
  assertRevision(write.expectedRevision, current);

  const next = {
    value,
    active: true,
    revision: write.expectedRevision + 1,
    updatedBy: write.userId,
    updatedAt: write.now,
  };
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

/** 恢复为系统值。当前本就取系统值时是无副作用的空操作（revision 不变、不写审计）。 */
export async function restoreSetting(tx: Tx, write: SettingWrite): Promise<EffectiveSetting> {
  const system = await loadSystemSetting(tx, write.key);
  const current = await loadOverrideForUpdate(tx, write.tenantId, write.key);
  assertRevision(write.expectedRevision, current);
  if (!current?.active) return effective(system, current);

  const [saved] = await tx
    .update(tenantSettingOverrides)
    .set({ active: false, revision: current.revision + 1, updatedBy: write.userId, updatedAt: write.now })
    .where(and(overrideKey(write.tenantId, write.key), eq(tenantSettingOverrides.revision, current.revision)))
    .returning();
  if (!saved) throw revisionConflict(write.expectedRevision, undefined);

  await audit(tx, write, 'tenant_setting.restore', snapshot(current), null);
  return effective(system, saved);
}

async function loadSystemSetting(tx: Tx, key: string): Promise<SystemSetting> {
  const [system] = await tx.select().from(systemSettings).where(eq(systemSettings.key, key));
  if (!system) throw new AppError('NOT_FOUND', '配置项不存在');
  return system;
}

/** 仅供覆盖 / 恢复路径使用。 */
async function loadOverrideForUpdate(tx: Tx, tenantId: string, key: string) {
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

/** 覆盖行（可能非激活）决定 revision；只有激活的覆盖才决定取值。 */
function effective(system: SystemSetting, row: TenantSettingOverride | undefined): EffectiveSetting {
  const base = { key: system.key, systemVersion: system.version, overridable: system.overridable };
  const revision = row?.revision ?? 0;
  return row?.active
    ? { ...base, value: row.value, source: 'tenant', revision }
    : { ...base, value: system.value, source: 'system', revision };
}

/** 审计里的“变更前”只记激活的覆盖；非激活行等同于取系统值。 */
function snapshot(row: TenantSettingOverride | undefined) {
  return row?.active ? { value: row.value, revision: row.revision } : null;
}

async function audit(tx: Tx, write: SettingWrite, action: string, before: unknown, after: unknown): Promise<void> {
  await recordAudit(tx, {
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
