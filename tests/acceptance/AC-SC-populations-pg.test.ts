/** AC-SC B2a：真 PG 的集合锁、对象 revision 与失败回查重放。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { configWorld } from './AC-SC-config-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { waitForBlocked, withRelease } from './support/pg-interleave.js';
const testDb = useTestDb();
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-SC B2a 真 PG 并发', () => {
  let w: Awaited<ReturnType<typeof configWorld>>;
  beforeAll(async () => {
    w = await configWorld(testDb().db);
  });
  it.each([true, false])('同 revision 两请求排队：同键=%s，重放或冲突，审计一次', async (sameKey) => {
    const saved = await w.create();
    let release!: () => void;
    let ready!: () => void;
    const locked = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const blocker = withTenant(w.db, w.tenant.id, async (tx) => {
      await tx.execute(sql`SELECT kind FROM succession_rule_settings WHERE kind = 'org_health' FOR UPDATE`);
      ready();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await locked;
    const key = randomUUID();
    const request = (idempotencyKey: string) =>
      w.request('PUT', `/populations/${saved.id}`, { ifMatch: 1, body: { name: '并发修改' }, idempotencyKey });
    const requests = [request(key), request(sameKey ? key : randomUUID())];
    await withRelease(
      release,
      async (cleanup) => {
        [...requests, blocker].forEach((request) => cleanup.track<unknown>(request));
        await waitForBlocked(w.db, 2);
      },
      [blocker],
    );
    await blocker;
    const responses = await Promise.all(requests);
    expect(responses.map((response) => response.status).sort()).toEqual(sameKey ? [200, 200] : [200, 409]);
    if (sameKey) expect(await responses[0]!.json()).toEqual(await responses[1]!.json());
    const [audit] = await withTenant(w.db, w.tenant.id, async (tx) =>
      resultRows<{ n: number }>(
        await tx.execute(sql`SELECT count(*)::int AS n FROM audit_events WHERE object_id = ${saved.id}
        AND action = 'succession.population.update'`),
      ),
    );
    expect(audit!.n).toBe(1);
  });
  it('默认颜色首次同 revision 并发创建：一个成功、另一个冲突', async () => {
    const responses = await Promise.all(
      ['#112233', '#AABBCC'].map((defaultColor) =>
        w.request('PUT', '/rule-settings/position_risk', { ifMatch: 0, body: { defaultColor } }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await (await w.request('GET', '/rule-settings/position_risk')).json()).toMatchObject({ revision: 1 });
  });
});
