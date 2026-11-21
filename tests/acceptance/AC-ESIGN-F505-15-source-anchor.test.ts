import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { ensureOfferSignSource } from '../../apps/api/src/modules/esign/offer-source.js';
import { OF_NOW } from './AC-OF-BE14a-support.js';
import { lifecycleWorld, ok } from './AC-ESIGN-F505-s3-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();

it('AC-15 锚点落库复用、创建审计、删除审计与跨租户拒绝', async () => {
  const { db } = testDb();
  const w = await lifecycleWorld(db, 'anchor');
  const other = await lifecycleWorld(db, 'anchor-other');
  const source = await w.social({ name: 'ZZ_F505_锚点来源' });
  const ctx = { tenantId: w.tenant.id, userId: w.user.id, now: OF_NOW, commandId: uniqueSuffix() };
  const foreign = { ...ctx, tenantId: other.tenant.id, userId: other.user.id };
  const anchors = () => w.query(sql`SELECT deleted_at FROM esign_offer_sources WHERE offer_id=${source.id}::uuid`);
  const audits = () =>
    w.query(sql`SELECT action, actor_user_id::text FROM audit_events WHERE object_id=${source.id}
    AND action LIKE 'esign.offer_source.%' ORDER BY action`);

  await expect(
    withTenant(db, foreign.tenantId, (tx) => ensureOfferSignSource(tx, foreign, source.id)),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(
    withTenant(db, w.tenant.id, async (tx) => {
      await ensureOfferSignSource(tx, ctx, source.id);
      throw new Error('ZZ_F505 受控事务回滚');
    }),
  ).rejects.toThrow('ZZ_F505 受控事务回滚');
  expect(await anchors()).toEqual([]);
  expect(await audits()).toEqual([]);
  await withTenant(db, w.tenant.id, async (tx) => {
    await ensureOfferSignSource(tx, ctx, source.id);
    await ensureOfferSignSource(tx, ctx, source.id);
  });
  expect(await anchors()).toEqual([{ deleted_at: null }]);
  expect(await audits()).toEqual([{ action: 'esign.offer_source.created', actor_user_id: w.user.id }]);
  await ok(await w.deleteOffer(source));
  expect(await anchors()).toEqual([{ deleted_at: expect.anything() }]);
  expect(await audits()).toEqual([
    { action: 'esign.offer_source.created', actor_user_id: w.user.id },
    { action: 'esign.offer_source.deleted', actor_user_id: w.user.id },
  ]);
  await expect(withTenant(db, w.tenant.id, (tx) => ensureOfferSignSource(tx, ctx, source.id))).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});
