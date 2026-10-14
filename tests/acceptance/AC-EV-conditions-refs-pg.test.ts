/** B6 P2-1：主体与全部条件组的反向引用、清除最后引用，以及真实 HTTP 保存 × 删除交错。 */
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  activityFixtures,
  activityWorld,
  type ActivityFixtures,
  type ActivityWorld,
} from './AC-EV-activity-support.js';
import { EV_BASE, errorOf, ok } from './AC-EV-support.js';
import type * as EvaluationStore from '../../apps/api/src/modules/evaluation/store.js';
import type * as QualificationStore from '../../apps/api/src/modules/qualification/store.js';

const race = vi.hoisted(() => ({
  evaluation: false,
  qualification: false,
  reached: undefined as (() => void) | undefined,
  release: undefined as Promise<void> | undefined,
}));
vi.mock('../../apps/api/src/modules/evaluation/store.js', async (load) => {
  const original = await load<typeof EvaluationStore>();
  return {
    ...original,
    audit: async (...args: Parameters<typeof original.audit>) => {
      await original.audit(...args);
      if (race.evaluation) {
        race.reached?.();
        await race.release;
      }
    },
  };
});
vi.mock('../../apps/api/src/modules/qualification/store.js', async (load) => {
  const original = await load<typeof QualificationStore>();
  return {
    ...original,
    audit: async (...args: Parameters<typeof original.audit>) => {
      await original.audit(...args);
      if (race.qualification) {
        race.reached?.();
        await race.release;
      }
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
const condition = (categoryIds: string[], levelIds: string[], kind = 'extra', applicantKind = 'others') => ({
  kind,
  applicantKind,
  categoryIds,
  levelIds,
  expression: null,
  details: [{ seq: 1, source: 'employee', field: 'age', operator: 'ge', value1: 18, value2: null }],
});

describe('AC-EV-conditions 类别 / 级别引用完整性', () => {
  let w: ActivityWorld;
  let f: ActivityFixtures;
  let displayOrder = 20;
  beforeAll(async () => {
    w = await activityWorld(testDb().db);
    f = await activityFixtures(w);
  });
  const remove = (kind: string, ref: { id: string; revision: number }) =>
    w.setup.request('DELETE', `/api/tenant/qualification/${kind}/${ref.id}`, { ...w.asAdmin, ifMatch: ref.revision });
  const patch = (id: string, revision: number, body: unknown) =>
    w.setup.request('PATCH', `${EV_BASE}/activities/${id}`, { ...w.asAdmin, ifMatch: revision, body });

  it.each(['common/self', 'common/others', 'extra/self', 'extra/others'])(
    '%s：主体缩小后仅条件引用仍拒删；清空最后条件引用后允许删除',
    async (group) => {
      const category = await w.qlCategory();
      const level = await w.qlLevel(displayOrder++);
      const [kind, applicant] = group.split('/');
      const conditions = [condition([category.id], [level.id], kind, applicant)];
      const activity = await w.adminActivity(
        f.body({
          applicants: ['self', 'others'],
          categoryIds: [f.cat1.id, category.id],
          levelIds: [f.lv1.id, level.id],
          conditions,
        }),
      );
      const narrowed = await ok<{ revision: number }>(
        await patch(activity.id, activity.revision, {
          categoryIds: [f.cat1.id],
          levelIds: [f.lv1.id],
        }),
      );
      const before = await w.adminRead(activity.id);
      for (const [path, ref, reason] of [
        ['categories', category, 'CATEGORY_IN_USE'],
        ['levels', level, 'LEVEL_IN_USE'],
      ] as const) {
        const response = await remove(path, ref);
        expect(response.status).toBe(409);
        expect((await errorOf(response)).reason).toBe(reason);
        expect((await w.setup.request('GET', `/api/tenant/qualification/${path}/${ref.id}`, w.asAdmin)).status).toBe(
          200,
        );
      }
      expect(await w.adminRead(activity.id)).toEqual(before);
      await ok(await patch(activity.id, narrowed.revision, { conditions: [] }));
      for (const [path, ref] of [
        ['categories', category],
        ['levels', level],
      ] as const) {
        await ok(await remove(path, ref));
        expect((await w.setup.request('GET', `/api/tenant/qualification/${path}/${ref.id}`, w.asAdmin)).status).toBe(
          404,
        );
      }
      expect(await w.adminRead(activity.id)).toMatchObject({ conditions: [] });
    },
  );

  it('多组引用：清除一组仍拒删，主体引用保留时清空全部条件仍拒删', async () => {
    const category = await w.qlCategory();
    const level = await w.qlLevel(displayOrder++);
    const groups = [condition([category.id], [level.id], 'common', 'self'), condition([category.id], [level.id])];
    const activity = await w.adminActivity(
      f.body({ categoryIds: [category.id], levelIds: [level.id], conditions: groups }),
    );
    const one = await ok<{ revision: number }>(
      await patch(activity.id, activity.revision, { conditions: groups.slice(1) }),
    );
    expect((await remove('categories', category)).status).toBe(409);
    expect((await remove('levels', level)).status).toBe(409);
    await ok(await patch(activity.id, one.revision, { conditions: [] }));
    expect((await remove('categories', category)).status).toBe(409);
    expect((await remove('levels', level)).status).toBe(409);
  });

  describe.skipIf(!process.env['TEST_DATABASE_URL'])('真 PG 双向交错', () => {
    it.each(
      ['categories', 'levels'].flatMap((kind) =>
        ['POST', 'PATCH'].flatMap((method) => ['保存先行', '删除先行'].map((order) => [kind, method, order])),
      ),
    )('%s × %s：%s，等待后复核，不留下失效条件', async (kind, method, order) => {
      const ref = kind === 'categories' ? await w.qlCategory() : await w.qlLevel(displayOrder++);
      const conditions = [condition(kind === 'categories' ? [ref.id] : [], kind === 'levels' ? [ref.id] : [])];
      const activity = method === 'PATCH' ? await w.adminActivity(f.body()) : undefined;
      const save = () =>
        activity
          ? patch(activity.id, activity.revision, { conditions })
          : w.setup.request('POST', `${EV_BASE}/activities`, {
              ...w.asAdmin,
              ifMatch: 0,
              body: f.body({ conditions }),
            });
      const reached = gate();
      const release = gate();
      race.evaluation = order === '保存先行';
      race.qualification = !race.evaluation;
      race.reached = reached.open;
      race.release = release.promise;
      const first = order === '保存先行' ? save() : remove(kind, ref);
      let second: Promise<Response> | undefined;
      try {
        await reached.promise;
        second = order === '保存先行' ? remove(kind, ref) : save();
        const deadline = Date.now() + 15_000;
        let waiting = false;
        while (!waiting && Date.now() < deadline) {
          const result = await testDb().db.execute(sql`SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%ql_%'
            AND pid <> pg_backend_pid()`);
          waiting = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows).length > 0;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(waiting, '必须观测到真实类别 / 级别行锁等待').toBe(true);
      } finally {
        release.open();
        await Promise.allSettled([first, second]);
        race.evaluation = race.qualification = false;
      }
      const responses = await Promise.all([first, second!]);
      const savedStatus = method === 'POST' ? 201 : 200;
      expect(responses.map((response) => response.status)).toEqual(
        order === '保存先行' ? [savedStatus, 409] : [200, 404],
      );
      if (order === '保存先行') {
        const saved = (await responses[0]!.json()) as { id: string };
        expect(await w.adminRead(saved.id)).toMatchObject({ conditions });
        expect((await errorOf(responses[1]!)).reason).toBe(kind === 'categories' ? 'CATEGORY_IN_USE' : 'LEVEL_IN_USE');
      } else if (activity) expect(await w.adminRead(activity.id)).toEqual(activity);
    });
  });
});
