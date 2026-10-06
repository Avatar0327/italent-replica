import { eq, orgSettings, type Tx } from '@italent/db';
import type { OrgDimension } from '@italent/domain';
import { AppError } from '../../errors.js';
import { ensureOrgSetup, type OrgSetupContext } from './codes.js';
import { recordAudit } from '../../audit/record.js';

export async function readOrgSettings(tx: Tx, tenantId: string) {
  const [row] = await tx.select().from(orgSettings).where(eq(orgSettings.tenantId, tenantId));
  const enabledDimensions: OrgDimension[] = ['admin'];
  if (row?.businessEnabled) enabledDimensions.push('business');
  if (row?.productEnabled) enabledDimensions.push('product');
  if (row?.reserve4Enabled) enabledDimensions.push('reserve4');
  if (row?.reserve5Enabled) enabledDimensions.push('reserve5');
  return { enabledDimensions, fullNameStartLevel: row?.fullNameStartLevel ?? 0, revision: row?.revision ?? 0 };
}

export async function writeOrgSettings(
  tx: Tx,
  ctx: OrgSetupContext,
  input: { enabledDimensions: OrgDimension[]; fullNameStartLevel: number },
) {
  await ensureOrgSetup(tx, ctx);
  const before = await readOrgSettings(tx, ctx.tenantId);
  if (before.revision !== ctx.expectedRevision) throw new AppError('REVISION_CONFLICT', '组织设置版本已变化');
  await tx
    .update(orgSettings)
    .set({
      businessEnabled: input.enabledDimensions.includes('business'),
      productEnabled: input.enabledDimensions.includes('product'),
      reserve4Enabled: input.enabledDimensions.includes('reserve4'),
      reserve5Enabled: input.enabledDimensions.includes('reserve5'),
      fullNameStartLevel: input.fullNameStartLevel,
      revision: before.revision + 1,
    })
    .where(eq(orgSettings.tenantId, ctx.tenantId));
  const after = await readOrgSettings(tx, ctx.tenantId);
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    action: 'org.settings.update',
    objectType: 'org_setting',
    objectId: ctx.tenantId,
    before,
    after,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
  return after;
}
