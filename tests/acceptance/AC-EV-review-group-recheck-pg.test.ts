/**
 * R3-T02 PR-B B3 评审组写命令“失败后回查台账”出口的真 PostgreSQL 并发回归（#207 第 2 轮，DEC-338⑤ / DEC-385③ / DEC-388②）。
 * PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行（CI 的 test:pg 任务）。
 * 两个同键同内容请求真实并发：mock `runCommand` 让两个请求都先通过“查台账”再一起往下执行（栅栏），于是
 * - POST：两个事务各自写业务行，第二个提交台账时在主键上真实等待，第一个提交后报主键冲突；
 * - PATCH：第二个在评审组行锁上真实等待，第一个提交后 revision 冲突；
 * 败者随后进入“失败后回查”，在它的第二次 `before`（回查事务）开始前，用另一条连接撤销操作人的评审组范围。
 * 回查必须按**当前**授权复核：败者 404，不返回胜者的结果；败者的业务写回滚（只有一条评审组 / 名称只改一次）。
 * 对照：不撤权时败者拿到胜者的同一份结果。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { EV_BASE } from './AC-EV-support.js';
import {
  type Employee,
  GROUPS,
  type GroupView,
  type ReviewOperator,
  reviewOperator,
  reviewWorld,
  type ReviewWorld,
} from './AC-EV-review-support.js';
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

describe.skipIf(!process.env['TEST_DATABASE_URL'])('AC-EV-review-group-recheck-pg 真 PG 并发：失败后回查', () => {
  let w: ReviewWorld;
  let e1: Employee;
  beforeAll(async () => {
    w = await reviewWorld(testDb().db);
    e1 = await w.hire('并发甲一', w.orgA);
  });

  const body = () => ({
    name: `并发组${suffix()}`,
    ownerOrgId: w.orgA,
    members: [{ employeeId: e1.id, isLeader: true }],
  });
  const manager = () => reviewOperator(w, { evOrgs: [w.orgA], personOrgs: [w.orgA] });
  const arm = (revoke?: () => Promise<void>) => {
    race.active = true;
    race.arrived = 0;
    race.revoked = false;
    race.revoke = revoke;
    race.gate = new Promise<void>((resolve) => {
      race.open = resolve;
    });
  };
  const disarm = () => {
    race.active = false;
  };
  const both = async (send: () => Promise<Response>) => {
    try {
      return await Promise.all([send(), send()]);
    } finally {
      disarm();
    }
  };
  const adminList = async () =>
    (
      (await (await w.setup.request('GET', `${EV_BASE}${GROUPS}?pageSize=100`, w.asAdmin)).json()) as {
        items: GroupView[];
      }
    ).items;

  it('POST：真实并发的台账主键冲突，回查前撤销评审组范围 → 败者 404 且不含胜者结果，只落一条评审组', async () => {
    const op: ReviewOperator = await manager();
    const data = body();
    const key = randomUUID();
    arm(() => op.setEvOrgs(undefined));
    const responses = await both(() => op.request('POST', GROUPS, { ifMatch: 0, idempotencyKey: key, body: data }));
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses, JSON.stringify(await Promise.all(responses.map((r) => r.clone().text())))).toEqual([201, 404]);
    const winner = (await responses.find((r) => r.status === 201)!.json()) as GroupView;
    const loser = responses.find((r) => r.status === 404)!;
    expect(await loser.text()).not.toContain(winner.id);
    expect((await adminList()).filter((item) => item.name === data.name)).toHaveLength(1);
  });

  it('PATCH：真实并发的 revision 冲突，回查前撤销评审组范围 → 败者 404，名称只改一次', async () => {
    const op = await manager();
    const group = await w.adminGroup(body());
    const data = { name: `改名${suffix()}` };
    const key = randomUUID();
    arm(() => op.setEvOrgs(undefined));
    const responses = await both(() =>
      op.request('PATCH', `${GROUPS}/${group.id}`, { ifMatch: group.revision, idempotencyKey: key, body: data }),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 404]);
    const now = (await (
      await w.setup.request('GET', `${EV_BASE}${GROUPS}/${group.id}`, w.asAdmin)
    ).json()) as GroupView;
    expect(now).toMatchObject({ name: data.name, revision: group.revision + 1 });
  });

  it('对照：不撤权时败者拿到胜者的同一份结果（POST / PATCH 各一次，证明走的是回查出口）', async () => {
    const op = await manager();
    const data = body();
    const key = randomUUID();
    arm();
    const posts = await both(() => op.request('POST', GROUPS, { ifMatch: 0, idempotencyKey: key, body: data }));
    expect(posts.map((r) => r.status)).toEqual([201, 201]);
    const [a, b] = await Promise.all(posts.map((r) => r.json()));
    expect(a).toEqual(b);
    expect((await adminList()).filter((item) => item.name === data.name)).toHaveLength(1);

    const group = await w.adminGroup(body());
    const patch = { name: `对照${suffix()}` };
    const patchKey = randomUUID();
    arm();
    const patches = await both(() =>
      op.request('PATCH', `${GROUPS}/${group.id}`, { ifMatch: group.revision, idempotencyKey: patchKey, body: patch }),
    );
    expect(patches.map((r) => r.status)).toEqual([200, 200]);
    const [c, d] = await Promise.all(patches.map((r) => r.json()));
    expect(c).toEqual(d);
  });
});
