/** C2-1a：真 PG 的双发布竞争，两个命令到达协调锁前再同时放行。 */
import { useTestDb } from '@italent/testkit';
import type * as ReferenceLocks from '../../apps/api/src/modules/evaluation/reference-locks.js';
import { describe, expect, it, vi } from 'vitest';
import { activityFixtures, activityWorld } from './AC-EV-activity-support.js';

const race = vi.hoisted(() => ({ armed: false, arrived: 0, release: () => {}, gate: Promise.resolve() }));
vi.mock('../../apps/api/src/modules/evaluation/reference-locks.js', async (original) => {
  const actual = await original<typeof ReferenceLocks>();
  return {
    ...actual,
    coordinateActivityForms: async (...args: Parameters<typeof actual.coordinateActivityForms>) => {
      if (race.armed) {
        race.arrived++;
        if (race.arrived === 2) race.release();
        await race.gate;
      }
      return actual.coordinateActivityForms(...args);
    },
  };
});
const testDb = useTestDb();
describe.skipIf(!process.env['TEST_DATABASE_URL'])('AC-EV-flow-base-pg', () => {
  it('同组织同类别两个草稿并发发布恰好一胜一负，不留下重复进行中活动', async () => {
    const w = await activityWorld(testDb().db);
    const f = await activityFixtures(w);
    const a = await w.adminActivity(f.body());
    const b = await w.adminActivity(f.body());
    race.arrived = 0;
    race.gate = new Promise<void>((resolve) => {
      race.release = resolve;
    });
    race.armed = true;
    try {
      const results = await Promise.all(
        [a, b].map((item) =>
          w.setup.request('POST', `/api/tenant/evaluation/activities/${item.id}/publish`, {
            ...w.asAdmin,
            ifMatch: 1,
            body: {},
          }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(JSON.stringify(await results.find((r) => r.status === 409)!.json())).toContain('ACTIVITY_SCOPE_DUPLICATE');
      expect((await Promise.all([a, b].map((item) => w.adminRead(item.id)))).map((row) => row.status).sort()).toEqual([
        'draft',
        'published',
      ]);
      expect(race.arrived).toBe(2);
    } finally {
      race.armed = false;
      race.release();
    }
  });
});
