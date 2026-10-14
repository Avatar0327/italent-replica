/** B6 真 PG：整份条件 CAS，EV-R5 与状态 / 报名数事务交错；PGlite 不执行并发用例。 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  activityFixtures,
  activityWorld,
  type ActivityFixtures,
  type ActivityWorld,
} from './AC-EV-activity-support.js';
import { EV_BASE, errorOf, ok } from './AC-EV-support.js';
import { FORMS, type FormView } from './AC-EV-form-support.js';
import type * as Conditions from '../../apps/api/src/modules/evaluation/conditions.js';

const readRace = vi.hoisted(() => ({
  target: '',
  reached: undefined as (() => void) | undefined,
  release: undefined as Promise<void> | undefined,
}));
vi.mock('../../apps/api/src/modules/evaluation/conditions.js', async (importOriginal) => {
  const original = await importOriginal<typeof Conditions>();
  return {
    ...original,
    loadConditions: async (...args: Parameters<typeof original.loadConditions>) => {
      if (args[2].includes(readRace.target) && readRace.reached) {
        const reached = readRace.reached;
        readRace.reached = undefined;
        reached();
        await readRace.release;
      }
      return original.loadConditions(...args);
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
async function waitForActivityLock() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await testDb().db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%ev_activities%'
      AND pid <> pg_backend_pid()`);
    const rows = (Array.isArray(result) ? result : (result as { rows: { n: number }[] }).rows) as { n: number }[];
    if (Number(rows[0]!.n) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('未观测到真实活动行锁等待');
}

describe.skipIf(!process.env['TEST_DATABASE_URL'])('AC-EV-conditions / AC-EV-form 真 PG', () => {
  let w: ActivityWorld;
  let f: ActivityFixtures;
  beforeAll(async () => {
    w = await activityWorld(testDb().db);
    f = await activityFixtures(w);
  });
  const conditions = (value1: number) => [
    {
      kind: 'common',
      applicantKind: 'self',
      categoryIds: [],
      levelIds: [],
      expression: '条件1',
      details: [{ seq: 1, source: 'employee', field: 'age', operator: 'ge', value1, value2: null }],
    },
  ];

  it('同 revision 的两份条件并发保存只成功一份，败者 409，无混合明细与重复子表', async () => {
    const activity = await w.adminActivity(f.body());
    const send = (value: number) =>
      w.setup.request('PATCH', `${EV_BASE}/activities/${activity.id}`, {
        ...w.asAdmin,
        ifMatch: activity.revision,
        body: { conditions: conditions(value) },
      });
    const responses = await Promise.all([send(18), send(21)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = await responses.find((response) => response.status === 200)!.json();
    const read = await w.adminRead(activity.id);
    expect(read).toEqual(winner);
    expect(read.revision).toBe(2);
    const counts = await withTenant(testDb().db, w.tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT
        (SELECT count(*)::int FROM ev_conditions WHERE activity_id = ${activity.id}::uuid) AS conditions,
        (SELECT count(*)::int FROM ev_condition_details d JOIN ev_conditions c ON c.tenant_id = d.tenant_id
          AND c.id = d.condition_id WHERE c.activity_id = ${activity.id}::uuid) AS details`);
      return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows)[0];
    });
    expect(counts).toEqual({ conditions: 1, details: 1 });
  });

  it('读取活动头与条件交错时，详情 / 列表均保持同一 revision 的整份配置，写请求等待读取完成', async () => {
    for (const list of [false, true]) {
      const activity = await w.adminActivity(f.body({ conditions: conditions(18) }));
      const reached = gate();
      const release = gate();
      readRace.target = activity.id;
      readRace.reached = reached.open;
      readRace.release = release.promise;
      const reading = w.setup.request(
        'GET',
        `${EV_BASE}/activities${list ? '?pageSize=200' : `/${activity.id}`}`,
        w.asAdmin,
      );
      await reached.promise;
      let writing: Promise<Response> | undefined;
      try {
        writing = w.setup.request('PATCH', `${EV_BASE}/activities/${activity.id}`, {
          ...w.asAdmin,
          ifMatch: activity.revision,
          body: { conditions: conditions(21) },
        });
        await waitForActivityLock();
      } finally {
        release.open();
        readRace.target = '';
        await Promise.allSettled([reading, writing]);
      }
      const response = await ok<{ items: unknown[] } & typeof activity>(await reading);
      const read = list ? response.items.find((item) => (item as { id: string }).id === activity.id) : response;
      expect(read).toEqual(activity);
      const saved = await ok<{ revision: number; conditions: unknown[] }>(await writing!);
      expect(saved).toMatchObject({ revision: activity.revision + 1, conditions: conditions(21) });
    }
  });

  it.each(['报名数', '发布状态'] as const)('EV-R5：%s 未提交时评价表修改等待，提交后按当前值拒绝', async (kind) => {
    const form = await w.form();
    const activity = await w.adminActivity(
      f.body({
        chains: f.chains(form.id),
        categoryIds: [(await w.qlCategory()).id],
      }),
    );
    if (kind === '报名数') await w.setStatus(activity.id, 'published');
    else await w.setApplyCount(activity.id, 1);
    const ready = gate();
    const release = gate();
    const writer = withTenant(testDb().db, w.tenant.id, async (tx) => {
      await tx.execute(sql`UPDATE ev_activities SET status = 'published', apply_count = 1
        WHERE id = ${activity.id}::uuid`);
      ready.open();
      await release.promise;
    });
    await ready.promise;
    let edit: Promise<Response> | undefined;
    try {
      edit = w.setup.request('PATCH', `${EV_BASE}${FORMS}/${form.id}`, {
        ...w.asAdmin,
        ifMatch: form.revision,
        body: { fullScore: 90 },
      });
      await waitForActivityLock();
    } finally {
      release.open();
      await writer;
    }
    const response = await edit!;
    expect(response.status).toBe(409);
    expect((await errorOf(response)).reason).toBe('FORM_LOCKED');
    const read = await ok<FormView>(await w.setup.request('GET', `${EV_BASE}${FORMS}/${form.id}`, w.asAdmin));
    expect(read).toMatchObject({ revision: form.revision, fullScore: 100 });
  });
});
