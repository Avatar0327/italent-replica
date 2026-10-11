/**
 * R3-T02 PR-B B5 评定活动写命令的“事务内当前权限复核”（接入 #199 的 ledgerExit；DEC-338⑤ / DEC-385③ / DEC-388①②；AGENTS §10
 * 权限、DEC-067）。活动的引用访问（类型 / 周期 / 类别 / 级别 / 环节评价表的查看权与范围、负责人的人员范围与字段）和所属组织、
 * 适用范围都在命令事务内重新解析。写入口 × 路径：POST / PATCH（名称、所属组织、环节整份编辑、新增引用）/ DELETE × 首次执行、
 * 直接重放、失败后回查。确定性交错同 AC-EV-form-recheck：mock `runCommand`，在它开事务前执行测试注入的钩子；败者路径让胜者先
 * 完整提交、把胜者台账行暂时移走，败者主事务撞上真实冲突（POST：补回台账行造成主键冲突；PATCH：revision；DELETE：对象已删除）
 * 回滚，放回台账并撤权后回查。真 PG 的并发版见 AC-EV-activity-recheck-pg。被拒必须不提交业务写、审计与台账。
 */
import { randomUUID } from 'node:crypto';
import { commandLedger, type Db, eq, sql, type Tx, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ok } from './AC-EV-support.js';
import {
  ACTIVITIES,
  type ActivityFixtures,
  activityFixtures,
  type ActivityOperator,
  type ActivityOperatorOptions,
  activityOperator,
  type ActivityView,
  activityWorld,
  type ActivityWorld,
  sendableChain,
} from './AC-EV-activity-support.js';
import type * as RunCommands from '../../apps/api/src/commands.js';

type RunCommandModule = typeof RunCommands;
interface Loser {
  readonly winner: () => Promise<Response>;
  readonly afterLoserTx: () => Promise<void>;
  /** 败者执行完业务写后，在同一事务里补回胜者的台账行，让它自己的台账写入撞上主键（POST 没有别的自然冲突）。 */
  readonly ledgerConflict?: boolean;
  removedRow?: typeof commandLedger.$inferSelect;
  winnerResponse?: Response;
}
const hooks = vi.hoisted(() => ({
  beforeCommand: undefined as undefined | (() => Promise<void>),
  loser: undefined as undefined | Loser,
}));
vi.mock('../../apps/api/src/commands.js', async (importOriginal) => {
  const original = await importOriginal<RunCommandModule>();
  return {
    ...original,
    runCommand: async (...args: Parameters<typeof original.runCommand>) => {
      const hook = hooks.beforeCommand;
      hooks.beforeCommand = undefined;
      await hook?.();
      const loser = hooks.loser;
      hooks.loser = undefined;
      if (!loser) return original.runCommand(...args);
      const [db, ctx, command] = args;
      loser.winnerResponse = await loser.winner();
      const conflicting = {
        ...command,
        execute: async (tx: Tx, id: string) => {
          const result = await command.execute(tx, id);
          if (loser.ledgerConflict) await tx.insert(commandLedger).values(loser.removedRow!);
          return result;
        },
      };
      return original.runCommand(loserDb(db, ctx.tenantId, command.id!, loser), ctx, conflicting);
    },
  };
});

function asOwner<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

/** 第一个事务（败者主事务）开始前移走胜者的台账行，结束后放回并执行 afterLoserTx；之后的事务（回查）原样。 */
function loserDb(db: Db, tenantId: string, commandId: string, loser: Loser): Db {
  let first = true;
  const wrapper = Object.create(db) as Db;
  wrapper.transaction = (async (fn: Parameters<Db['transaction']>[0]) => {
    if (!first) return db.transaction(fn);
    first = false;
    const [row] = await asOwner(db, tenantId, (tx) =>
      tx.delete(commandLedger).where(eq(commandLedger.commandId, commandId)).returning(),
    );
    if (!row) throw new Error('胜者没有写台账，模拟前提不成立');
    loser.removedRow = row;
    try {
      return await db.transaction(fn);
    } finally {
      await asOwner(db, tenantId, (tx) => tx.insert(commandLedger).values(row));
      await loser.afterLoserTx();
    }
  }) as Db['transaction'];
  return wrapper;
}

const testDb = useTestDb();
const suffix = () => randomUUID().slice(0, 6);

describe('AC-EV-activity-recheck 评定活动命令事务内权限复核', () => {
  let w: ActivityWorld;
  let f: ActivityFixtures;
  beforeAll(async () => {
    w = (await activityWorld(testDb().db)) as ActivityWorld;
    f = await activityFixtures(w);
  });

  const body = (extra: Record<string, unknown> = {}) => f.body(extra);
  const manager = (options: ActivityOperatorOptions = {}) =>
    activityOperator(w, { evOrgs: [w.orgA, w.orgC], personOrgs: [w.orgA], ...options });
  const create = (op: ActivityOperator, data: Record<string, unknown> = body(), key: string = randomUUID()) =>
    op.request('POST', ACTIVITIES, { ifMatch: 0, idempotencyKey: key, body: data });
  const created = (op: ActivityOperator, data: Record<string, unknown> = body()) =>
    create(op, data).then((r) => ok<ActivityView>(r, 201));
  const patch = (op: ActivityOperator, activity: ActivityView, data: Record<string, unknown>, key = randomUUID()) =>
    op.request('PATCH', `${ACTIVITIES}/${activity.id}`, {
      ifMatch: activity.revision,
      idempotencyKey: key,
      body: data,
    });
  const remove = (op: ActivityOperator, activity: ActivityView, key = randomUUID()) =>
    op.request('DELETE', `${ACTIVITIES}/${activity.id}`, { ifMatch: activity.revision, idempotencyKey: key });
  const ledger = (key: string) =>
    withTenant(testDb().db, w.tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT count(*)::int AS n FROM command_ledger WHERE command_id = ${key}`);
      const rows = (Array.isArray(result) ? result : (result as { rows: { n: number }[] }).rows) as { n: number }[];
      return Number(rows[0]?.n);
    });
  const unchanged = async (activity: ActivityView) => {
    const now = await w.adminRead(activity.id);
    expect(now).toMatchObject({ revision: activity.revision, name: activity.name, ownerOrgId: activity.ownerOrgId });
    expect(now.chains.map((chain) => chain.id)).toEqual(activity.chains.map((chain) => chain.id));
  };

  describe('首次执行：路由层检查通过后、命令事务内撤权', () => {
    it('POST：撤销活动范围 → 404；撤销类型 / 评价表 / 类别 / 员工信息查看权 → 403；撤销负责人的人员范围 → 404；都没有落库与台账', async () => {
      const op = await manager();
      const key = randomUUID();
      hooks.beforeCommand = () => op.setEvOrgs(undefined);
      const gone = await create(op, body(), key);
      expect(gone.status, await gone.clone().text()).toBe(404);
      expect(await ledger(key)).toBe(0);
      const revokers: [string, (o: ActivityOperator) => Promise<void>][] = [
        ['类型', (o) => o.revokeTypeView()],
        ['周期', (o) => o.revokeCycleView()],
        ['评价表', (o) => o.revokeFormView()],
        ['类别', (o) => o.revokeCategoryView()],
        ['级别', (o) => o.revokeLevelView()],
        ['员工信息', (o) => o.revokeEmployeeView()],
      ];
      for (const [label, revoke] of revokers) {
        const victim = await manager();
        hooks.beforeCommand = () => revoke(victim);
        const response = await create(victim);
        expect(response.status, `${label}: ${await response.clone().text()}`).toBe(403);
      }
      const shrunk = await manager();
      hooks.beforeCommand = () => shrunk.setPersonOrgs(undefined);
      const person = await create(shrunk);
      expect(person.status, await person.clone().text()).toBe(404);
    });

    it('PATCH：撤销范围 → 404；撤销环节字段编辑权 → 403；新增评价表引用时撤销评价表查看权 → 403；保留原引用不重校', async () => {
      const activity = await w.adminActivity(body());
      const op = await manager();
      hooks.beforeCommand = () => op.setEvOrgs(undefined);
      expect((await patch(op, activity, { name: `越权${suffix()}` })).status).toBe(404);
      await unchanged(activity);
      const writer = await manager();
      hooks.beforeCommand = () => writer.hideActivityFields(['chains']);
      const fieldless = await patch(writer, activity, { chains: activity.chains.map(sendableChain) });
      expect(fieldless.status, await fieldless.clone().text()).toBe(403);
      await unchanged(activity);
      const spare = await w.form(w.orgA);
      const adder = await manager();
      hooks.beforeCommand = () => adder.revokeFormView();
      const swapped = activity.chains.map((chain) =>
        chain.type === 'defense' ? { ...sendableChain(chain), formId: spare.id } : sendableChain(chain),
      );
      const added = await patch(adder, activity, { chains: swapped });
      expect(added.status, await added.clone().text()).toBe(403);
      await unchanged(activity);
      // 只保留原有引用（含评价表已看不到）：不新增 ID，不重新校验可见性
      const keeper = await manager();
      hooks.beforeCommand = () => keeper.revokeFormView();
      const kept = await patch(keeper, activity, {
        name: `保留${suffix()}`,
        chains: activity.chains.map(sendableChain),
      });
      expect(kept.status, await kept.clone().text()).toBe(200);
    });

    it('PATCH 所属组织 / 适用范围：检查后新组织不在范围内 → 404，原值不变', async () => {
      const op = await manager({ evOrgs: [w.orgA, w.orgC] });
      const activity = await w.adminActivity(body());
      hooks.beforeCommand = () => op.setEvOrgs([w.orgA]);
      const owner = await patch(op, activity, { ownerOrgId: w.orgC });
      expect(owner.status, await owner.clone().text()).toBe(404);
      await unchanged(activity);
      const range = await manager({ evOrgs: [w.orgA, w.orgC] });
      hooks.beforeCommand = () => range.setEvOrgs([w.orgA]);
      const added = await patch(range, activity, { orgRange: f.orgs(w.orgA, w.orgC) });
      expect(added.status, await added.clone().text()).toBe(404);
      expect((await w.adminRead(activity.id)).orgRange.map((item) => item.orgId)).toEqual([w.orgA]);
    });

    it('DELETE：撤销范围 → 404，对象仍在、台账不变', async () => {
      const op = await manager();
      const activity = await w.adminActivity(body());
      const key = randomUUID();
      hooks.beforeCommand = () => op.setEvOrgs(undefined);
      const response = await remove(op, activity, key);
      expect(response.status, await response.clone().text()).toBe(404);
      await unchanged(activity);
      expect(await ledger(key)).toBe(0);
    });
  });

  describe('直接重放：同键重放按当前授权复核', () => {
    it('POST 重放：活动范围被撤销 → 404 且不含首次结果；撤销员工信息查看权后重放，负责人只剩 ID（访问在事务内重新解析）', async () => {
      const op = await manager();
      const key = randomUUID();
      const data = body();
      const first = await ok<ActivityView>(await create(op, data, key), 201);
      expect(first.manager).toMatchObject({ name: '负责人甲' });
      hooks.beforeCommand = () => op.setEvOrgs(undefined);
      const replay = await create(op, data, key);
      expect(replay.status, await replay.clone().text()).toBe(404);
      expect(await replay.clone().text()).not.toContain(first.id);
      const viewer = await manager();
      const key2 = randomUUID();
      const data2 = body();
      await ok(await create(viewer, data2, key2), 201);
      await viewer.revokeEmployeeView();
      const bare = await ok<ActivityView>(await create(viewer, data2, key2), 201);
      expect(bare.managerEmployeeId).toBe(f.mgrA.id);
      expect(bare.manager).toEqual({});
    });

    it('PATCH 重放：撤销字段编辑权 → 403；DELETE 重放按快照的所属组织 ∪ 所属人复核（范围内 200，出范围 404）', async () => {
      const writer = await manager();
      const activity = await w.adminActivity(body());
      const key = randomUUID();
      const first = await ok<ActivityView>(await patch(writer, activity, { name: `改${suffix()}` }, key));
      hooks.beforeCommand = () => writer.hideActivityFields(['name']);
      const denied = await patch(writer, activity, { name: first.name }, key);
      expect(denied.status, await denied.clone().text()).toBe(403);

      const op = await manager({ evOrgs: [w.orgA] });
      const target = await w.adminActivity(body());
      const delKey = randomUUID();
      await ok(await remove(op, target, delKey));
      expect((await remove(op, target, delKey)).status).toBe(200);
      await op.setEvOrgs([w.orgB]);
      const gone = await remove(op, target, delKey);
      expect(gone.status, await gone.clone().text()).toBe(404);
    });
  });

  describe('失败后回查台账：败者回滚后、回查前撤权', () => {
    type Send = (op: ActivityOperator) => Promise<Response>;
    const cases: readonly {
      readonly method: string;
      readonly error: string;
      readonly ledgerConflict?: boolean;
      readonly send: (op: ActivityOperator) => Promise<Send>;
    }[] = [
      {
        method: 'POST',
        error: '台账主键冲突',
        ledgerConflict: true,
        send: async () => {
          const key = randomUUID();
          const data = body();
          return (o) => create(o, data, key);
        },
      },
      {
        method: 'PATCH',
        error: 'revision 冲突',
        send: async (op) => {
          const activity = await created(op);
          const key = randomUUID();
          const data = { name: `改${suffix()}` };
          return (o) => patch(o, activity, data, key);
        },
      },
      {
        method: 'DELETE',
        error: '对象已删除',
        send: async (op) => {
          const activity = await created(op);
          const key = randomUUID();
          return (o) => remove(o, activity, key);
        },
      },
    ];

    it.each(cases)('$method（$error）：回查前撤销活动范围 → 不返回胜者结果', async (c) => {
      const op = await manager();
      const send = await c.send(op);
      const loser: Loser = {
        winner: () => send(op),
        afterLoserTx: () => op.setEvOrgs(undefined),
        ...(c.ledgerConflict ? { ledgerConflict: true } : {}),
      };
      hooks.loser = loser;
      const response = await send(op);
      const won = await loser.winnerResponse!.clone().json();
      expect(loser.winnerResponse!.ok, JSON.stringify(won)).toBe(true);
      expect(response.status, await response.clone().text()).toBe(404);
      expect(await response.clone().text()).not.toContain((won as ActivityView).id);
    });

    it.each(cases)('$method（$error）对照：不撤权时败者重放胜者结果（证明走的是回查出口）', async (c) => {
      const op = await manager();
      const send = await c.send(op);
      const loser: Loser = {
        winner: () => send(op),
        afterLoserTx: async () => undefined,
        ...(c.ledgerConflict ? { ledgerConflict: true } : {}),
      };
      hooks.loser = loser;
      const response = await send(op);
      expect(response.status, await response.clone().text()).toBe(loser.winnerResponse!.status);
      expect(await response.json()).toEqual(await loser.winnerResponse!.clone().json());
    });

    it('POST 回查：回查前撤销员工信息查看权 → 重放胜者结果，但负责人只剩 ID（访问重新解析）', async () => {
      const op = await manager();
      const key = randomUUID();
      const data = body();
      const loser: Loser = {
        winner: () => create(op, data, key),
        afterLoserTx: () => op.revokeEmployeeView(),
        ledgerConflict: true,
      };
      hooks.loser = loser;
      const response = await create(op, data, key);
      expect(response.status, await response.clone().text()).toBe(201);
      const replayed = (await response.json()) as ActivityView;
      expect(replayed.managerEmployeeId).toBe(f.mgrA.id);
      expect(replayed.manager).toEqual({});
    });
  });
});
