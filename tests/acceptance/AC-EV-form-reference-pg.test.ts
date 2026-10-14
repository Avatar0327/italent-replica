/** B6 P2-2：审查死锁反例的两种先后顺序；HTTP 与 PG 实际行锁 / 外键锁均参与。 */
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  activityFixtures,
  activityWorld,
  sendableChainWithId,
  type ActivityFixtures,
  type ActivityWorld,
} from './AC-EV-activity-support.js';
import { EV_BASE, ok } from './AC-EV-support.js';
import type * as Store from '../../apps/api/src/modules/evaluation/store.js';

const race = vi.hoisted(() => ({
  firstId: '',
  reached: undefined as (() => void) | undefined,
  release: undefined as Promise<void> | undefined,
}));
vi.mock('../../apps/api/src/modules/evaluation/store.js', async (load) => {
  const original = await load<typeof Store>();
  return {
    ...original,
    lockEditable: async (...args: Parameters<typeof original.lockEditable>) => {
      const row = await original.lockEditable(...args);
      if (args[3] === race.firstId && race.reached) {
        const reached = race.reached;
        race.reached = undefined;
        reached();
        await race.release;
      }
      return row;
    },
  };
});
const testDb = useTestDb();
const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

describe.skipIf(!process.env['TEST_DATABASE_URL'])('AC-EV-form × 活动引用真 PG 协调', () => {
  let w: ActivityWorld;
  let f: ActivityFixtures;
  beforeAll(async () => {
    w = await activityWorld(testDb().db);
    f = await activityFixtures(w);
  });

  it.each(['活动先行', '评价表先行'])('%s：新增同表答辩环节与改满分均成功，不能 500 / 死锁', async (order) => {
    const form = await w.form();
    const activity = await w.adminActivity(f.body({ chains: f.chains(form.id) }));
    expect(activity).toMatchObject({ status: 'draft', applyCount: 0 });
    const chains = activity.chains.map(sendableChainWithId);
    const { id: _id, ...secondDefense } = chains.find((chain) => chain.type === 'defense')!;
    chains.splice(chains.length - 1, 0, { ...secondDefense, name: '第二轮答辩' });
    const editActivity = () =>
      w.setup.request('PATCH', `${EV_BASE}/activities/${activity.id}`, {
        ...w.asAdmin,
        ifMatch: activity.revision,
        body: { chains },
      });
    const editForm = () =>
      w.setup.request('PATCH', `${EV_BASE}/evaluation-forms/${form.id}`, {
        ...w.asAdmin,
        ifMatch: form.revision,
        body: { fullScore: 90 },
      });
    const reached = gate();
    const release = gate();
    race.firstId = order === '活动先行' ? activity.id : form.id;
    race.reached = reached.open;
    race.release = release.promise;
    const first = order === '活动先行' ? editActivity() : editForm();
    let second: Promise<Response> | undefined;
    try {
      await reached.promise;
      second = order === '活动先行' ? editForm() : editActivity();
      const deadline = Date.now() + 15_000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const result = await testDb().db.execute(sql`SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`);
        waiting = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows).length > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting, '后到请求必须实际等待前一事务的锁').toBe(true);
    } finally {
      release.open();
      await Promise.allSettled([first, second]);
      race.firstId = '';
    }
    const responses = await Promise.all([first, second!]);
    expect(
      responses.map((response) => response.status),
      (await Promise.all(responses.map((r) => r.clone().text()))).join('\n'),
    ).toEqual([200, 200]);
    const saved = await w.adminRead(activity.id);
    expect(saved.revision).toBe(activity.revision + 1);
    expect(saved.chains.filter((chain) => chain.type === 'defense').map((chain) => chain.formId)).toEqual([
      form.id,
      form.id,
    ]);
    const read = await ok(await w.setup.request('GET', `${EV_BASE}/evaluation-forms/${form.id}`, w.asAdmin));
    expect(read).toMatchObject({ revision: form.revision + 1, fullScore: 90 });
  });
});
