import { desc, eq, establishmentSettings, establishmentTimingVersions, lte, and, type Tx } from '@italent/db';
import { gt } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import { assertRevision, audit, businessDate, lockEstablishment, today, type EstablishmentContext } from './store.js';

export async function readSettings(tx: Tx, tenantId: string, asOf: string) {
  const [head] = await tx
    .select()
    .from(establishmentSettings)
    .where(eq(establishmentSettings.tenantId, tenantId))
    .limit(1);
  const [version] = await tx
    .select()
    .from(establishmentTimingVersions)
    .where(and(eq(establishmentTimingVersions.tenantId, tenantId), lte(establishmentTimingVersions.startDate, asOf)))
    .orderBy(desc(establishmentTimingVersions.startDate), desc(establishmentTimingVersions.versionNo))
    .limit(1);
  if (!version) throw new AppError('SERVICE_UNAVAILABLE', '请先配置编制占用时机');
  return { ...version, revision: head?.revision ?? 0 };
}

export async function updateSettings(
  tx: Tx,
  ctx: EstablishmentContext,
  input: { transferIn: 'submitted' | 'approved'; transferOut: 'submitted' | 'approved'; effectiveDate?: string },
) {
  await lockEstablishment(tx, ctx);
  const [head] = await tx
    .select()
    .from(establishmentSettings)
    .where(eq(establishmentSettings.tenantId, ctx.tenantId))
    .limit(1);
  assertRevision(ctx.expectedRevision, head?.revision ?? 0);
  const date = businessDate(input.effectiveDate ?? today(ctx));
  const [future] = await tx
    .select({ id: establishmentTimingVersions.id })
    .from(establishmentTimingVersions)
    .where(and(eq(establishmentTimingVersions.tenantId, ctx.tenantId), gt(establishmentTimingVersions.startDate, date)))
    .limit(1);
  if (future) throw new AppError('CONFLICT', '占用时机已有后续版本', { reason: 'FUTURE_VERSION_EXISTS' });
  const [previous] = await tx
    .select()
    .from(establishmentTimingVersions)
    .where(eq(establishmentTimingVersions.tenantId, ctx.tenantId))
    .orderBy(desc(establishmentTimingVersions.versionNo))
    .limit(1);
  const revision = (head?.revision ?? 0) + 1;
  await tx.update(establishmentSettings).set({ revision }).where(eq(establishmentSettings.tenantId, ctx.tenantId));
  await tx.insert(establishmentTimingVersions).values({
    tenantId: ctx.tenantId,
    versionNo: revision,
    previousVersionId: previous?.id ?? null,
    startDate: date,
    transferIn: input.transferIn,
    transferOut: input.transferOut,
    createdAt: ctx.now,
  });
  const saved = await readSettings(tx, ctx.tenantId, date);
  await audit(
    tx,
    ctx,
    'establishment.settings.update',
    'establishment-settings',
    ctx.tenantId,
    previous ?? null,
    saved,
  );
  return saved;
}
