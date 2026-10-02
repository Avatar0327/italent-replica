import { randomUUID } from 'node:crypto';
import {
  and,
  auditEvents,
  eq,
  establishmentOutbox,
  establishmentSchemeObjects,
  establishmentSchemeVersions,
  type Tx,
} from '@italent/db';
import { AppError } from '../../errors.js';
import type { EstablishmentContext } from './store.js';

export const DEFAULT_SCHEME_CODE = 'DEFAULT';
const action = 'establishment.scheme.default.create';

/** docs/02_业务建模/18 §2：仅在写事务取得租户锁后预置；历史上已建过或已停用均不重建。 */
export async function ensureDefaultScheme(tx: Tx, ctx: EstablishmentContext): Promise<void> {
  const [existing] = await tx
    .select({ id: establishmentSchemeVersions.schemeId })
    .from(establishmentSchemeVersions)
    .where(
      and(
        eq(establishmentSchemeVersions.tenantId, ctx.tenantId),
        eq(establishmentSchemeVersions.code, DEFAULT_SCHEME_CODE),
      ),
    )
    .limit(1);
  if (existing) return;

  const objectId = randomUUID();
  await tx.insert(establishmentSchemeObjects).values({
    id: objectId,
    tenantId: ctx.tenantId,
    revision: 1,
    createdAt: ctx.now,
  });
  const [version] = await tx
    .insert(establishmentSchemeVersions)
    .values({
      tenantId: ctx.tenantId,
      schemeId: objectId,
      versionNo: 1,
      code: DEFAULT_SCHEME_CODE,
      name: '默认方案',
      cycle: 'annual',
      maintenanceMode: 'local',
      startMonth: 1,
      subdivision: 'none',
      unmatchedPolicy: 'organization',
      enabled: true,
      startDate: '0001-01-01',
      stopDate: '9999-12-31',
      createdAt: ctx.now,
    })
    .returning();
  if (!version) throw new AppError('SERVICE_UNAVAILABLE', '无法预置默认编制方案');
  const after = {
    ...version,
    id: objectId,
    versionId: version.id,
    revision: 1,
    periodType: version.cycle,
    excludedOrgIds: [],
    occupancyRanges: [],
  };
  await tx.insert(auditEvents).values({
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    action,
    objectType: 'establishment-scheme',
    objectId,
    before: null,
    after,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
  await tx.insert(establishmentOutbox).values({
    tenantId: ctx.tenantId,
    eventType: action,
    objectId,
    payload: { objectType: 'establishment-scheme', before: null, after, commandId: ctx.commandId },
    createdAt: ctx.now,
  });
}
