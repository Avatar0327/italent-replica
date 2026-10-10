/**
 * R3-T02 PR-B B5 评定活动写命令的真 PostgreSQL 并发回归（DEC-338⑤ / DEC-385③ / DEC-388②；设计 §3.2 适用范围重复拦截）。
 * PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行（CI 的 test:pg 任务）。
 * - 失败后回查：两个同键同内容请求真实并发（mock `runCommand` 让两个请求都先通过“查台账”再一起往下执行），败者在回查事务开始前
 *   被撤权，回查必须按**当前**授权复核（404，不返回胜者结果），败者的业务写回滚；
 * - 适用范围重复：另一事务持“租户 + 申请类别”咨询锁把同范围活动置为进行中且未提交，新建请求必须等它提交后再判断，
 *   于是新建得到 409（没有锁时会读到旧的草稿状态而放行，同范围出现两个活动）。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@italent/db';
import { EV_BASE } from './AC-EV-support.js';
import { lockActivityScope } from '../../apps/api/src/modules/evaluation/activity-scope.js';
import {
  ACTIVITIES,
  type ActivityFixtures,
  activityFixtures,
  type ActivityOperator,
  activityOperator,
  type ActivityView,
  activityWorld,
  type ActivityWorld,
} from './AC-EV-activity-support.js';
import type * as RunCommands from '../../apps/api/src/commands.js';

type RunCommandModule = typeof RunCommands;
const race = vi.hoisted(() => ({
  active: false,
  arrived: 0,
  open: undefined as undefined | (() => void),
  gate: undefined as undefined | Promise<void>,
  revoke: undefined as undefined | (() => Promise<void>),
  revoked: false,
}));
vi.mock('../../apps/api/src/commands.js', async (importOriginal) => {
  const original = await importOriginal<RunCommandModule>();
  return {
    ...original,
    runCommand: async (...args: Parameters<typeof original.runCommand>) => {
      const [db, ctx, command] = args;
      // 只包评定配置的写命令（带 guard）；撤权用的权限命令等其他命令照常
      if (!race.active || !command.guard) return original.runCommand(...args);
      let beforeCalls = 0;
      const guard = {
        ...command.guard!,
        // 第二次 before = 失败后回查事务：在它开始前撤权（一次）
        before: async (tx: Parameters<NonNullable<typeof command.guard>['before']>[0]) => {
          beforeCalls++;
          if (beforeCalls === 2 && !race.revoked) {
            race.revoked = true;
            await race.revoke?.();
          }
          return command.guard!.before(tx);
        },
      };
      const execute = async (...rest: Parameters<typeof command.execute>) => {
        race.arrived++;
        if (race.arrived >= 2) race.open?.();
        await race.gate; // 两个请求都已通过“查台账”，一起往下执行
        return command.execute(...rest);
      };
      return original.runCommand(db, ctx, { ...command, guard, execute });
    },
  };
});

const testDb = useTestDb();
const suffix = () => randomUUID().slice(0, 6);

describe.skipIf(!process.env['TEST_DATABASE_URL'])('AC-EV-activity-recheck-pg 真 PG 并发', () => {
  let w: ActivityWorld;
  let f: ActivityFixtures;
  beforeAll(async () => {
    w = (await activityWorld(testDb().db)) as ActivityWorld;
    f = await activityFixtures(w);
  });

  const body = (extra: Record<string, unknown> = {}) => f.body(extra);
  const manager = (): Promise<ActivityOperator> => activityOperator(w, { evOrgs: [w.orgA], personOrgs: [w.orgA] });
  const arm = (revoke?: () => Promise<void>) => {
    race.active = true;
    race.arrived = 0;
    race.revoked = false;
    race.revoke = revoke;
    race.gate = new Promise<void>((resolve) => {
      race.open = resolve;
    });
  };
  const both = async (send: () => Promise<Response>) => {
    try {
      return await Promise.all([send(), send()]);
    } finally {
      race.active = false;
    }
  };
  const adminList = async () =>
    (
      (await (await w.setup.request('GET', `${EV_BASE}${ACTIVITIES}?pageSize=200`, w.asAdmin)).json()) as {
        items: ActivityView[];
      }
    ).items;

  describe('失败后回查', () => {
    it('POST：真实并发的台账主键冲突，回查前撤销活动范围 → 败者 404 且不含胜者结果，只落一条活动', async () => {
      const op = await manager();
      const data = body({ categoryIds: [(await w.qlCategory()).id] });
      const key = randomUUID();
      arm(() => op.setEvOrgs(undefined));
      const responses = await both(() =>
        op.request('POST', ACTIVITIES, { ifMatch: 0, idempotencyKey: key, body: data }),
      );
      expect(
        responses.map((r) => r.status).sort(),
        JSON.stringify(await Promise.all(responses.map((r) => r.clone().text()))),
      ).toEqual([201, 404]);
      const winner = (await responses.find((r) => r.status === 201)!.json()) as ActivityView;
      expect(await responses.find((r) => r.status === 404)!.text()).not.toContain(winner.id);
      expect((await adminList()).filter((item) => item.code === data.code)).toHaveLength(1);
    });

    it('PATCH：真实并发的 revision 冲突，回查前撤销活动范围 → 败者 404，名称只改一次', async () => {
      const op = await manager();
      const activity = await w.adminActivity(body({ categoryIds: [(await w.qlCategory()).id] }));
      const data = { name: `改名${suffix()}` };
      const key = randomUUID();
      arm(() => op.setEvOrgs(undefined));
      const responses = await both(() =>
        op.request('PATCH', `${ACTIVITIES}/${activity.id}`, {
          ifMatch: activity.revision,
          idempotencyKey: key,
          body: data,
        }),
      );
      expect(responses.map((r) => r.status).sort()).toEqual([200, 404]);
      expect(await w.adminRead(activity.id)).toMatchObject({ name: data.name, revision: activity.revision + 1 });
    });

    it('DELETE：真实并发，第二个在行锁上等待，回查前撤权 → 败者 404；对象已删', async () => {
      const op = await manager();
      const activity = await w.adminActivity(body({ categoryIds: [(await w.qlCategory()).id] }));
      const key = randomUUID();
      arm(() => op.setEvOrgs(undefined));
      const responses = await both(() =>
        op.request('DELETE', `${ACTIVITIES}/${activity.id}`, {
          ifMatch: activity.revision,
          idempotencyKey: key,
        }),
      );
      expect(responses.map((r) => r.status).sort()).toEqual([200, 404]);
      expect((await w.setup.request('GET', `${EV_BASE}${ACTIVITIES}/${activity.id}`, w.asAdmin)).status).toBe(404);
    });

    it('对照：不撤权时败者拿到胜者的同一份结果（POST / PATCH）', async () => {
      const op = await manager();
      const data = body({ categoryIds: [(await w.qlCategory()).id] });
      const key = randomUUID();
      arm();
      const posts = await both(() => op.request('POST', ACTIVITIES, { ifMatch: 0, idempotencyKey: key, body: data }));
      expect(posts.map((r) => r.status)).toEqual([201, 201]);
      const [a, b] = await Promise.all(posts.map((r) => r.json()));
      expect(a).toEqual(b);
      expect((await adminList()).filter((item) => item.code === data.code)).toHaveLength(1);
      const activity = await w.adminActivity(body({ categoryIds: [(await w.qlCategory()).id] }));
      const patch = { name: `对照${suffix()}` };
      const patchKey = randomUUID();
      arm();
      const patches = await both(() =>
        op.request('PATCH', `${ACTIVITIES}/${activity.id}`, {
          ifMatch: activity.revision,
          idempotencyKey: patchKey,
          body: patch,
        }),
      );
      expect(patches.map((r) => r.status)).toEqual([200, 200]);
      const [c, d] = await Promise.all(patches.map((r) => r.json()));
      expect(c).toEqual(d);
    });
  });

  describe('适用范围重复拦截的并发', () => {
    it('另一事务持“租户 + 类别”锁把同范围活动置为进行中且未提交：新建请求等它提交后判断 → 409，同范围只有一个活动', async () => {
      const category = await w.qlCategory();
      const first = await w.adminActivity(body({ categoryIds: [category.id] }));
      const op = await manager();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const holding = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const publisher = testDb().db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.tenant_id', ${w.tenant.id}, true)`);
        await lockActivityScope(tx, w.tenant.id, [category.id]);
        await tx.execute(sql`UPDATE ev_activities SET status = 'published' WHERE id = ${first.id}::uuid`);
        locked();
        await gate;
      });
      await holding;
      const pending = op.request('POST', ACTIVITIES, { ifMatch: 0, body: body({ categoryIds: [category.id] }) });
      const outcome = await Promise.race([
        pending.then(() => 'done'),
        new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 600)),
      ]);
      expect(outcome).toBe('waiting');
      release();
      await publisher;
      const response = await pending;
      expect(response.status, await response.clone().text()).toBe(409);
      const inScope = (await adminList()).filter((item) => item.categoryIds.includes(category.id));
      expect(inScope.map((item) => item.id)).toEqual([first.id]);
    });
  });
});
