import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { levelBody, levelKinds, levelsWorld } from './AC-SC-levels-support.js';
import { settledOrBlocked, withRelease } from './support/pg-interleave.js';

const testDb = useTestDb();
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-SC B2b 真 PG 锁交错', () => {
  let w: Awaited<ReturnType<typeof levelsWorld>>;
  beforeAll(async () => {
    w = await levelsWorld(testDb().db);
  });
  async function interleave(kind: string, first: () => Promise<Response>, second: () => Promise<Response>) {
    let release!: () => void, ready!: () => void;
    const acquired = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const blocker = withTenant(w.db, w.tenant.id, async (tx) => {
      await tx.execute(sql`SELECT kind FROM succession_rule_settings WHERE kind = ${kind} FOR UPDATE`);
      ready();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await acquired;
    let a: Promise<Response> | undefined, b: Promise<Response> | undefined;
    await withRelease(
      release,
      async (cleanup) => {
        cleanup.track(blocker);
        a = cleanup.track(first());
        expect(await settledOrBlocked(w.db, a, 1)).toBe('blocked');
        b = cleanup.track(second());
        expect(await settledOrBlocked(w.db, b, 2)).toBe('blocked');
      },
      [blocker],
    );
    return await Promise.all([a!, b!]);
  }
  it.each(levelKinds.flatMap((kind) => [true, false].map((sameKey) => ({ kind, sameKey }))))(
    'AC-SC $kind：同 revision 同目标保存，同键=$sameKey',
    async ({ kind, sameKey }) => {
      const saved = await w.createLevel(kind);
      const key = randomUUID();
      const save = (idempotencyKey: string) =>
        w.request('PUT', `/${kind}-levels/${saved.id}`, {
          ifMatch: 1,
          idempotencyKey,
          body: { name: randomUUID(), rules: levelBody(kind).rules },
        });
      const body = { name: randomUUID() };
      const same = () => w.request('PUT', `/${kind}-levels/${saved.id}`, { ifMatch: 1, idempotencyKey: key, body });
      const responses = await interleave(
        kind === 'risk' ? 'position_risk' : 'org_health',
        same,
        sameKey ? same : () => save(randomUUID()),
      );
      expect(responses.map((response) => response.status)).toEqual(sameKey ? [200, 200] : [200, 409]);
      if (sameKey) expect(await responses[0]!.json()).toEqual(await responses[1]!.json());
      expect(await (await w.request('GET', `/${kind}-levels/${saved.id}`)).json()).toMatchObject({
        revision: 2,
        name: body.name,
      });
    },
  );
  it.each(levelKinds.flatMap((kind) => [true, false].map((deleteFirst) => ({ kind, deleteFirst }))))(
    'AC-SC $kind：重排 × 删除，先删=$deleteFirst',
    async ({ kind, deleteFirst }) => {
      const saved = await w.createLevel(kind);
      const before = await w.list(kind);
      const reorder = () =>
        w.request('PUT', `/${kind}-levels/order`, {
          ifMatch: before.collectionRevision,
          body: { ids: before.items.map((item) => item.id).reverse() },
        });
      const remove = () => w.request('DELETE', `/${kind}-levels/${saved.id}`, { ifMatch: 1 });
      const responses = await interleave(
        kind === 'risk' ? 'position_risk' : 'org_health',
        deleteFirst ? remove : reorder,
        deleteFirst ? reorder : remove,
      );
      expect(responses.map((response) => response.status)).toEqual([200, 409]);
      const after = await w.list(kind);
      expect(after.collectionRevision).toBe(before.collectionRevision + 1);
      expect(after.items.some((item) => item.id === saved.id)).toBe(!deleteFirst);
    },
  );
  it.each([true, false])('AC-SC 引用 × 删人员范围，先引用=%s', async (referenceFirst) => {
    const population = await w.create();
    const body = levelBody('health', population.id);
    const reference = () => w.request('POST', '/health-levels', { body });
    const remove = () => w.request('DELETE', `/populations/${population.id}`, { ifMatch: 1 });
    const responses = await interleave(
      'org_health',
      referenceFirst ? reference : remove,
      referenceFirst ? remove : reference,
    );
    expect(responses.map((response) => response.status)).toEqual(referenceFirst ? [201, 409] : [200, 404]);
    if (referenceFirst)
      expect(await responses[1]!.json()).toMatchObject({ error: { details: { reason: 'POPULATION_IN_USE' } } });
    const list = await w.list('health');
    expect(list.items.some((item) => item.code === body.code)).toBe(referenceFirst);
    expect((await w.request('GET', `/populations/${population.id}`)).status).toBe(referenceFirst ? 200 : 404);
  });
});
