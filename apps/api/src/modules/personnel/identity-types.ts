/**
 * 个人身份字典（R2-T04 §2.4，DEC-640③、DEC-638 A-9）：标准项工人 = 10、干部 = 20，只读——不提供新增与修改。
 * 人事 identityType 与退休规则的个人身份条件只能取启用编码；标准项由 DEC-361 种子登记按租户补装。
 */
import { and, asc, eq, retirementIdentityTypes as table, sql, type Tx } from '@italent/db';
import { RETIREMENT_IDENTITY_TYPE_PRESETS } from '@italent/domain';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { registerSeed } from '../../seeds/registry.js';

const columns = {
  id: table.id,
  code: table.code,
  name: table.name,
  enabled: table.enabled,
  displayOrder: table.displayOrder,
  revision: table.revision,
};
const AUDIT = { action: 'retirement_identity_type.save', objectType: 'retirement_identity_type' } as const;

/** 预置只有两项，列表整份返回。 */
export async function listRetirementIdentityTypes(tx: Tx, tenantId: string) {
  return tx
    .select(columns)
    .from(table)
    .where(eq(table.tenantId, tenantId))
    .orderBy(asc(table.displayOrder), asc(table.code), asc(table.id));
}

/** 选用时只能选启用项：编码不存在 → RETIREMENT_IDENTITY_TYPE_UNKNOWN，已停用 → RETIREMENT_IDENTITY_TYPE_DISABLED。 */
export async function requireEnabledIdentityTypes(tx: Tx, tenantId: string, codes: readonly string[]) {
  if (!codes.length) return;
  const found = await tx
    .select({ code: table.code, enabled: table.enabled })
    .from(table)
    .where(and(eq(table.tenantId, tenantId), sql`${table.code} IN ${codes}`));
  const byCode = new Map(found.map((row) => [row.code, row.enabled]));
  for (const code of codes) {
    const enabled = byCode.get(code);
    if (enabled === true) continue;
    throw new AppError('VALIDATION_FAILED', enabled === false ? '个人身份已停用' : '个人身份不存在', {
      reason: enabled === false ? 'RETIREMENT_IDENTITY_TYPE_DISABLED' : 'RETIREMENT_IDENTITY_TYPE_UNKNOWN',
    });
  }
}

registerSeed({
  module: 'employment-retirement',
  key: 'identity-types',
  version: 1,
  codes: RETIREMENT_IDENTITY_TYPE_PRESETS.map((preset) => preset.code),
  existing: async (tx, tenantId) => {
    const rows = await tx.select({ code: table.code }).from(table).where(eq(table.tenantId, tenantId));
    return new Set(rows.map((row) => row.code));
  },
  install: async (tx, write, missing) => {
    for (const preset of RETIREMENT_IDENTITY_TYPE_PRESETS) {
      if (!missing.includes(preset.code)) continue;
      const [after] = await tx
        .insert(table)
        .values({
          tenantId: write.tenantId,
          code: preset.code,
          name: preset.name,
          displayOrder: preset.displayOrder,
          createdAt: write.now,
          updatedAt: write.now,
        })
        .onConflictDoNothing()
        .returning(columns);
      if (!after) continue;
      await recordAudit(tx, {
        tenantId: write.tenantId,
        actorUserId: write.actorUserId,
        ...AUDIT,
        objectId: after.id,
        before: null,
        after,
        commandId: write.commandId,
        occurredAt: write.now,
      });
    }
    return { skipped: [] };
  },
});
