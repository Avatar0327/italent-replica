import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { levelReferenceWorld } from './AC-SC-levels-reference-support.js';
import { settledOrBlocked, withRelease } from './support/pg-interleave.js';

const testDb = useTestDb();
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-SC B2b P2-2 字段引用真 PG 交错', () => {
  it.each([true, false])('AC-SC 字段共享锁与删除互斥，先引用=%s', async (referenceFirst) => {
    const w = await levelReferenceWorld(testDb().db);
    let release!: () => void, ready!: () => void;
    const acquired = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const blocker = withTenant(w.db, w.tenant.id, async (tx) => {
      await tx.execute(sql`SELECT id FROM talent_review_fields
        WHERE tenant_id = ${w.tenant.id}::uuid AND id = ${w.field.id}::uuid FOR UPDATE`);
      ready();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await acquired;
    let first: Promise<Response> | undefined, second: Promise<Response> | undefined;
    await withRelease(
      release,
      async (cleanup) => {
        cleanup.track(blocker);
        first = cleanup.track(referenceFirst ? w.reference() : w.fieldRequest('DELETE'));
        expect(await settledOrBlocked(w.db, first, 1)).toBe('blocked');
        second = cleanup.track(referenceFirst ? w.fieldRequest('DELETE') : w.reference());
        expect(await settledOrBlocked(w.db, second, 2)).toBe('blocked');
      },
      [blocker],
    );
    const responses = await Promise.all([first!, second!]);
    expect(responses.map((response) => response.status)).toEqual(referenceFirst ? [201, 409] : [200, 400]);
    if (referenceFirst)
      expect(await responses[1]!.json()).toMatchObject({
        error: { details: { reason: 'FIELD_IN_USE', referrer: 'SUCCESSION_HEALTH_LEVEL' } },
      });
    else
      expect(await responses[1]!.json()).toMatchObject({
        error: { details: { errors: expect.arrayContaining([expect.objectContaining({ reason: 'FIELD_UNKNOWN' })]) } },
      });
    expect((await w.list('health')).total).toBe(referenceFirst ? 1 : 0);
    expect((await w.fieldRequest('GET')).status).toBe(referenceFirst ? 200 : 404);
  });
});
