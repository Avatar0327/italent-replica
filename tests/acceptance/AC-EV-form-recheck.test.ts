/**
 * R3-T02 PR-B B4 评价表写命令的“事务内当前权限复核”（接入 #199 的 ledgerExit；DEC-338⑤ / DEC-385③ / DEC-388①②；AGENTS §10
 * 权限、DEC-067）。评价表的引用（通用评分项的字典查看权 / 范围、指标的查看权 / 名称字段）和所属组织范围都在命令事务内重新
 * 解析。写入口 × 路径：POST / PATCH（名称启停、所属组织、评分项整组编辑）/ DELETE × 首次执行、直接重放、失败后回查。
 * 确定性交错同 AC-EV-review-group-recheck：mock `runCommand`，在它开事务前执行测试注入的钩子；败者路径让胜者先完整提交、
 * 把胜者台账行暂时移走，败者主事务撞上真实冲突（POST：补回台账行造成主键冲突；PATCH：revision；DELETE：对象已删除）回滚，
 * 放回台账并撤权后回查。真 PG 的并发版见 AC-EV-form-recheck-pg。被拒必须不提交业务写、审计与台账。
 */
import { randomUUID } from 'node:crypto';
import { commandLedger, type Db, eq, sql, type Tx, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { EV_BASE, ok } from './AC-EV-support.js';
import {
  type FormOperator,
  type FormOperatorOptions,
  formOperator,
  type FormView,
  FORMS,
  formWorld,
  type FormWorld,
  type GeneralItem,
  type TargetRef,
} from './AC-EV-form-support.js';
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

describe('AC-EV-form-recheck 评价表命令事务内权限复核', () => {
  let w: FormWorld;
  let g1: GeneralItem;
  let g2: GeneralItem;
  let t1: TargetRef;
  beforeAll(async () => {
    w = (await formWorld(testDb().db)) as FormWorld;
    g1 = await w.generalItem('复核评分项甲');
    g2 = await w.generalItem('复核评分项乙');
    t1 = await w.qlTarget('复核指标甲');
  });

  const body = (extra: Record<string, unknown> = {}) => ({
    name: `复核表${suffix()}`,
    ownerOrgId: w.orgA,
    scoreMode: 'by_indicator',
    fullScore: 100,
    passScore: 60,
    totalRule: 'weighted',
    items: [
      { kind: 'standard', weight: 80, hiddenTargetIds: [t1.id] },
      { kind: 'general', generalItemId: g1.id, weight: 20 },
    ],
    ...extra,
  });
  const manager = (options: FormOperatorOptions = {}) => formOperator(w, { evOrgs: [w.orgA], ...options });
  const create = (op: FormOperator, data: Record<string, unknown> = body(), key: string = randomUUID()) =>
    op.request('POST', FORMS, { ifMatch: 0, idempotencyKey: key, body: data });
  const created = (op: FormOperator, data: Record<string, unknown> = body()) =>
    create(op, data).then((r) => ok<FormView>(r, 201));
  const patch = (op: FormOperator, form: FormView, data: Record<string, unknown>, key = randomUUID()) =>
    op.request('PATCH', `${FORMS}/${form.id}`, { ifMatch: form.revision, idempotencyKey: key, body: data });
  const remove = (op: FormOperator, form: FormView, key = randomUUID()) =>
    op.request('DELETE', `${FORMS}/${form.id}`, { ifMatch: form.revision, idempotencyKey: key });
  const adminRead = (id: string) => w.setup.request('GET', `${EV_BASE}${FORMS}/${id}`, w.asAdmin);
  const ledger = (key: string) =>
    withTenant(testDb().db, w.tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT count(*)::int AS n FROM command_ledger WHERE command_id = ${key}`);
      const rows = (Array.isArray(result) ? result : (result as { rows: { n: number }[] }).rows) as { n: number }[];
      return Number(rows[0]?.n);
    });
  const unchanged = async (form: FormView) => {
    const now = (await (await adminRead(form.id)).json()) as FormView;
    expect(now).toMatchObject({ revision: form.revision, name: form.name, ownerOrgId: form.ownerOrgId });
    expect(now.items.map((item) => item.generalItemId ?? null)).toEqual(
      form.items.map((item) => item.generalItemId ?? null),
    );
  };

  describe('首次执行：路由层检查通过后、命令事务内撤权', () => {
    it('POST：撤销评价表范围 → 404；撤销字典查看权 → 403；撤销指标查看权 → 403；都没有落库与台账', async () => {
      const op = await manager();
      const key = randomUUID();
      hooks.beforeCommand = () => op.setEvOrgs(undefined);
      const gone = await create(op, body(), key);
      expect(gone.status, await gone.clone().text()).toBe(404);
      expect(await ledger(key)).toBe(0);
      const noGeneral = await manager();
      hooks.beforeCommand = () => noGeneral.revokeGeneralView();
      const g = await create(noGeneral, body({ items: [{ kind: 'general', generalItemId: g1.id, weight: 10 }] }));
      expect(g.status, await g.clone().text()).toBe(403);
      const noTarget = await manager();
      hooks.beforeCommand = () => noTarget.revokeTargetView();
      const t = await create(noTarget);
      expect(t.status, await t.clone().text()).toBe(403);
    });

    it('PATCH：撤销范围 → 404；撤销评分项字段编辑权 → 403；新增通用评分项引用时撤销字典查看权 → 403；保留原引用不重校', async () => {
      const group = await w.adminForm(body());
      const op = await manager();
      hooks.beforeCommand = () => op.setEvOrgs(undefined);
      expect((await patch(op, group, { name: `越权${suffix()}` })).status).toBe(404);
      await unchanged(group);
      const writer = await manager();
      hooks.beforeCommand = () => writer.hideFormFields(['items']);
      const fieldless = await patch(writer, group, { items: [{ kind: 'standard', weight: 10 }] });
      expect(fieldless.status, await fieldless.clone().text()).toBe(403);
      await unchanged(group);
      const adder = await manager();
      hooks.beforeCommand = () => adder.revokeGeneralView();
      const added = await patch(adder, group, {
        items: [...group.items.map(sendable), { kind: 'general', generalItemId: g2.id, weight: 1 }],
      });
      expect(added.status, await added.clone().text()).toBe(403);
      await unchanged(group);
      // 只保留原有引用（含字典已看不到）：不新增 ID，不重新校验可见性
      const keeper = await manager();
      hooks.beforeCommand = () => keeper.revokeGeneralView();
      const kept = await patch(keeper, group, { name: `保留${suffix()}`, items: group.items.map(sendable) });
      expect(kept.status, await kept.clone().text()).toBe(200);
      expect(((await kept.json()) as FormView).items[1]).toEqual({ kind: 'general', generalItemId: g1.id, weight: 20 });
    });

    it('PATCH 所属组织：检查后新组织不在范围内 → 404，所属组织不变', async () => {
      const op = await manager({ evOrgs: [w.orgA, w.orgB] });
      const form = await w.adminForm(body());
      hooks.beforeCommand = () => op.setEvOrgs([w.orgA]);
      const response = await patch(op, form, { ownerOrgId: w.orgB });
      expect(response.status, await response.clone().text()).toBe(404);
      await unchanged(form);
    });

    it('DELETE：撤销范围 → 404，对象仍在、台账不变', async () => {
      const op = await manager();
      const form = await w.adminForm(body());
      const key = randomUUID();
      hooks.beforeCommand = () => op.setEvOrgs(undefined);
      const response = await remove(op, form, key);
      expect(response.status, await response.clone().text()).toBe(404);
      await unchanged(form);
      expect(await ledger(key)).toBe(0);
    });
  });

  describe('直接重放：同键重放按当前授权复核', () => {
    it('POST 重放：评价表范围被撤销 → 404 且不含首次结果；撤销字典 / 指标查看权后重放响应只剩 ID（访问在事务内重新解析）', async () => {
      const op = await manager();
      const key = randomUUID();
      const data = body();
      const first = await ok<FormView>(await create(op, data, key), 201);
      expect(first.items[1]).toMatchObject({ name: g1.name });
      hooks.beforeCommand = () => op.setEvOrgs(undefined);
      const replay = await create(op, data, key);
      expect(replay.status, await replay.clone().text()).toBe(404);
      expect(await replay.clone().text()).not.toContain(first.id);
      const viewer = await manager();
      const key2 = randomUUID();
      const data2 = body();
      await ok(await create(viewer, data2, key2), 201);
      await viewer.revokeGeneralView();
      await viewer.revokeTargetView();
      const bare = await ok<FormView>(await create(viewer, data2, key2), 201);
      expect(bare.items[1]).toEqual({ kind: 'general', generalItemId: g1.id, weight: 20 });
      expect(bare.items[0]!.hiddenTargets).toEqual([{ id: t1.id }]);
    });

    it('PATCH 重放：撤销字段编辑权 → 403；DELETE 重放按快照的所属组织 ∪ 所属人复核（范围内 200，出范围 404）', async () => {
      const writer = await manager();
      const form = await w.adminForm(body());
      const key = randomUUID();
      const first = await ok<FormView>(await patch(writer, form, { name: `改${suffix()}` }, key));
      hooks.beforeCommand = () => writer.hideFormFields(['name']);
      const denied = await patch(writer, form, { name: first.name }, key);
      expect(denied.status, await denied.clone().text()).toBe(403);

      const op = await manager({ evOrgs: [w.orgA] });
      const target = await w.adminForm(body());
      const delKey = randomUUID();
      await ok(await remove(op, target, delKey));
      expect((await remove(op, target, delKey)).status).toBe(200);
      await op.setEvOrgs([w.orgB]);
      const gone = await remove(op, target, delKey);
      expect(gone.status, await gone.clone().text()).toBe(404);
    });
  });

  describe('失败后回查台账：败者回滚后、回查前撤权', () => {
    type Send = (op: FormOperator) => Promise<Response>;
    const cases: readonly {
      readonly method: string;
      readonly error: string;
      readonly ledgerConflict?: boolean;
      readonly send: (op: FormOperator) => Promise<Send>;
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
          const form = await created(op);
          const key = randomUUID();
          const data = { name: `改${suffix()}` };
          return (o) => patch(o, form, data, key);
        },
      },
      {
        method: 'DELETE',
        error: '对象已删除',
        send: async (op) => {
          const form = await created(op);
          const key = randomUUID();
          return (o) => remove(o, form, key);
        },
      },
    ];

    it.each(cases)('$method（$error）：回查前撤销评价表范围 → 不返回胜者结果', async (c) => {
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
      expect(await response.clone().text()).not.toContain((won as FormView).id);
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

    it('POST 回查：回查前撤销字典与指标查看权 → 重放胜者结果，但名称都不再给（访问重新解析）', async () => {
      const op = await manager();
      const key = randomUUID();
      const data = body();
      const loser: Loser = {
        winner: () => create(op, data, key),
        afterLoserTx: async () => {
          await op.revokeGeneralView();
          await op.revokeTargetView();
        },
        ledgerConflict: true,
      };
      hooks.loser = loser;
      const response = await create(op, data, key);
      expect(response.status, await response.clone().text()).toBe(201);
      const replayed = (await response.json()) as FormView;
      expect(replayed.items[1]).toEqual({ kind: 'general', generalItemId: g1.id, weight: 20 });
      expect(replayed.items[0]!.hiddenTargets).toEqual([{ id: t1.id }]);
    });
  });
});

function sendable(item: FormView['items'][number]) {
  return {
    kind: item.kind,
    ...(item.generalItemId ? { generalItemId: item.generalItemId } : {}),
    ...(item.weight !== null ? { weight: item.weight } : {}),
    ...(item.hiddenTargets?.length ? { hiddenTargetIds: item.hiddenTargets.map((target) => target.id) } : {}),
  };
}
