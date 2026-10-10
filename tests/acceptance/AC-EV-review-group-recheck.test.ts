/**
 * R3-T02 PR-B B3 评审组写命令的“事务内当前权限复核”（#207 第 2 轮，接入 #199 的 ledgerExit；DEC-338⑤ / DEC-385③ /
 * DEC-388②；AGENTS §10 权限、DEC-067）。评审组比字典多一处：成员是人员引用，员工信息的查看权 / 人员范围 / 字段在命令事务内
 * 重新解析（不沿用事务外的快照，也不用带请求缓存的 requestScope）。
 * 写入口 × 路径：POST / PATCH（名称启停、所属组织、成员整组编辑）× 首次执行、直接重放、失败后回查（评审组没有删除入口，DEC-393⑤）。
 * 确定性交错同 AC-EV-config-dicts-recheck：mock `runCommand`，在它开事务前执行测试注入的钩子；败者路径让胜者先完整提交、
 * 把胜者台账行暂时移走，败者主事务撞上真实冲突（POST：台账主键，评审组名称不唯一所以没有别的自然冲突；PATCH：revision）
 * 回滚，放回台账并撤权后回查。真 PG 的并发版见 AC-EV-review-group-recheck-pg。被拒必须不提交业务写、审计与台账。
 */
import { randomUUID } from 'node:crypto';
import { commandLedger, type Db, eq, sql, type Tx, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { errorOf, EV_BASE, EV_NOW, ok } from './AC-EV-support.js';
import {
  type Employee,
  GROUPS,
  type GroupView,
  type ReviewOperator,
  reviewOperator,
  type ReviewOperatorOptions,
  reviewWorld,
  type ReviewWorld,
} from './AC-EV-review-support.js';
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

describe('AC-EV-review-group-recheck 评审组命令事务内权限复核', () => {
  let w: ReviewWorld;
  let e1: Employee; // 甲部
  let e2: Employee; // 乙部
  let e3: Employee; // 乙部
  beforeAll(async () => {
    w = await reviewWorld(testDb().db);
    e1 = await w.hire('复核甲一', w.orgA);
    e2 = await w.hire('复核乙二', w.orgB);
    e3 = await w.hire('复核乙三', w.orgB);
  });

  const members = (...list: [Employee, boolean][]) =>
    list.map(([employee, isLeader]) => ({ employeeId: employee.id, isLeader }));
  const body = (extra: Record<string, unknown> = {}) => ({
    name: `复核组${suffix()}`,
    ownerOrgId: w.orgA,
    members: members([e1, true]),
    ...extra,
  });
  /** 评审组范围 = 甲部（可选带乙部），人员范围 = 甲部。 */
  const manager = (options: ReviewOperatorOptions = {}) =>
    reviewOperator(w, { evOrgs: [w.orgA], personOrgs: [w.orgA], ...options });
  const create = (op: ReviewOperator, data: Record<string, unknown> = body(), key: string = randomUUID()) =>
    op.request('POST', GROUPS, { ifMatch: 0, idempotencyKey: key, body: data });
  const created = (op: ReviewOperator, data: Record<string, unknown> = body()) =>
    create(op, data).then((r) => ok<GroupView>(r, 201));
  const patch = (op: ReviewOperator, group: GroupView, data: Record<string, unknown>, key = randomUUID()) =>
    op.request('PATCH', `${GROUPS}/${group.id}`, { ifMatch: group.revision, idempotencyKey: key, body: data });
  const adminReads = async (id: string) => w.setup.request('GET', `${EV_BASE}${GROUPS}/${id}`, w.asAdmin);
  const adminGroup = async (data = body()) => w.adminGroup(data);
  const ledger = (key: string) =>
    withTenant(testDb().db, w.tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT count(*)::int AS n FROM command_ledger WHERE command_id = ${key}`);
      const rows = (Array.isArray(result) ? result : (result as { rows: { n: number }[] }).rows) as { n: number }[];
      return Number(rows[0]?.n);
    });
  const auditCount = async (id?: string) => {
    const audit = auditApi(testDb().db, EV_NOW.toISOString(), { authorize: undefined });
    const auditor = await manager({ auditor: true, evOrgs: [w.orgA, w.orgB] });
    const items = (await audit.dataChanges(auditor.as, { objectType: 'TEvaluation.ReviewGroup', limit: '100' })).items;
    return id ? items.filter((item) => item.objectId === id).length : items.length;
  };
  const unchanged = async (group: GroupView) => {
    const now = (await (await adminReads(group.id)).json()) as GroupView;
    expect(now.revision).toBe(group.revision);
    expect(now.name).toBe(group.name);
    expect(now.ownerOrgId).toBe(group.ownerOrgId);
    expect(now.members.map((m) => [m.employeeId, m.isLeader])).toEqual(
      group.members.map((m) => [m.employeeId, m.isLeader]),
    );
  };

  describe('首次执行：路由层检查通过后、命令事务内撤权', () => {
    it('POST：撤销评审组范围 → 404（所属组织不在范围内），没有落库、审计与台账', async () => {
      const op = await manager();
      const before = await auditCount();
      const data = body();
      const key = randomUUID();
      hooks.beforeCommand = () => op.setEvOrgs(undefined);
      const response = await create(op, data, key);
      expect(response.status, await response.clone().text()).toBe(404);
      const listed = await w.setup.request('GET', `${EV_BASE}${GROUPS}?pageSize=100`, w.asAdmin);
      const items = ((await listed.json()) as { items: GroupView[] }).items;
      expect(items.some((item) => item.name === data.name)).toBe(false);
      expect(await auditCount()).toBe(before);
      expect(await ledger(key)).toBe(0);
    });

    it('POST：撤销人员范围 → 新增成员 404；撤销员工信息查看权 → 403 NO_EMPLOYEE_ACCESS；都不落库', async () => {
      const op = await manager();
      const key = randomUUID();
      hooks.beforeCommand = () => op.setPersonOrgs(undefined);
      const gone = await create(op, body(), key);
      expect(gone.status, await gone.clone().text()).toBe(404);
      expect(await ledger(key)).toBe(0);
      const viewer = await manager();
      hooks.beforeCommand = () => viewer.revokeEmployeeView();
      const denied = await create(viewer);
      expect(denied.status, await denied.clone().text()).toBe(403);
      expect((await errorOf(denied)).reason).toBe('NO_EMPLOYEE_ACCESS');
    });

    it('PATCH 名称启停：撤销范围 → 404；撤销字段编辑权 → 403；数据不变', async () => {
      const op = await manager();
      const group = await adminGroup();
      hooks.beforeCommand = () => op.setEvOrgs(undefined);
      const gone = await patch(op, group, { name: `越权${suffix()}`, enabled: false });
      expect(gone.status, await gone.clone().text()).toBe(404);
      await unchanged(group);
      const writer = await manager();
      const key = randomUUID();
      hooks.beforeCommand = () => writer.hideGroupFields(['name']);
      const fieldless = await patch(writer, group, { name: `越权${suffix()}` }, key);
      expect(fieldless.status, await fieldless.clone().text()).toBe(403);
      await unchanged(group);
      expect(await ledger(key)).toBe(0);
    });

    it('PATCH 所属组织：检查后新组织不在范围内 → 404，所属组织不变', async () => {
      const op = await manager({ evOrgs: [w.orgA, w.orgB] });
      const group = await adminGroup();
      hooks.beforeCommand = () => op.setEvOrgs([w.orgA]);
      const response = await patch(op, group, { ownerOrgId: w.orgB });
      expect(response.status, await response.clone().text()).toBe(404);
      await unchanged(group);
    });

    it('PATCH 成员整组编辑：新增成员检查后出人员范围 → 404；保留原成员 / 删除成员 / 调整组长不要求原有人员在范围内', async () => {
      const op = await manager({ evOrgs: [w.orgA], personOrgs: [w.orgA, w.orgB] });
      const group = await adminGroup(body({ members: members([e1, true], [e2, false], [e3, false]) }));
      hooks.beforeCommand = () => op.setPersonOrgs([w.orgB]);
      const fresh = await w.hire('复核甲新', w.orgA);
      const gone = await patch(op, group, {
        members: members([e1, true], [e2, false], [e3, false], [fresh, false]),
      });
      expect(gone.status, await gone.clone().text()).toBe(404);
      await unchanged(group);
      // 人员范围整体撤销后：不新增任何 ID（保留 E1 / E2、删除 E3、E2 改任组长）仍然成功
      await op.setPersonOrgs(undefined);
      const reshaped = await ok<GroupView>(await patch(op, group, { members: members([e1, false], [e2, true]) }));
      expect(reshaped.members.map((m) => [m.employeeId, m.isLeader])).toEqual([
        [e1.id, false],
        [e2.id, true],
      ]);
    });
  });

  describe('直接重放：同键重放按当前授权复核', () => {
    it('POST 重放：评审组范围被撤销 → 404 且不含首次结果；对象权限被撤销 → 403', async () => {
      const op = await manager();
      const key = randomUUID();
      const data = body();
      const first = await ok<GroupView>(await create(op, data, key), 201);
      hooks.beforeCommand = () => op.setEvOrgs(undefined);
      const replay = await create(op, data, key);
      expect(replay.status, await replay.clone().text()).toBe(404);
      expect(await replay.clone().text()).not.toContain(first.id);
      const viewer = await manager();
      const again = randomUUID();
      await ok(await create(viewer, body(), again), 201);
      hooks.beforeCommand = () => viewer.revokeEvaluationObject();
      expect((await create(viewer, body(), again)).status).toBe(403);
    });

    it('POST 重放：撤销员工信息查看权后，重放响应的成员只剩 ID（人员访问在事务内重新解析）', async () => {
      const op = await manager();
      const key = randomUUID();
      const data = body();
      const first = await ok<GroupView>(await create(op, data, key), 201);
      expect(first.members[0]).toMatchObject({ employeeId: e1.id, name: e1.name });
      hooks.beforeCommand = () => op.revokeEmployeeView();
      const replay = await create(op, data, key);
      expect(replay.status, await replay.clone().text()).toBe(201);
      const again = (await replay.json()) as GroupView;
      expect(again.members.map((m) => Object.keys(m).sort())).toEqual([['employeeId', 'isLeader']]);
    });

    it('PATCH 重放：撤销字段编辑权 → 403', async () => {
      const writer = await manager();
      const group = await adminGroup();
      const key = randomUUID();
      const first = await ok<GroupView>(await patch(writer, group, { name: `改${suffix()}` }, key));
      hooks.beforeCommand = () => writer.hideGroupFields(['name']);
      const denied = await patch(writer, group, { name: first.name }, key);
      expect(denied.status, await denied.clone().text()).toBe(403);
    });
  });

  describe('失败后回查台账：败者回滚后、回查前撤权', () => {
    type Send = (op: ReviewOperator) => Promise<Response>;
    const cases: readonly {
      readonly method: string;
      readonly error: string;
      readonly ledgerConflict?: boolean;
      readonly send: (op: ReviewOperator) => Promise<Send>;
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
          const group = await created(op);
          const key = randomUUID();
          const data = { name: `改${suffix()}` };
          return (o) => patch(o, group, data, key);
        },
      },
    ];

    it.each(cases)('$method（$error）：回查前撤销评审组对象权限 → 不返回胜者结果', async (c) => {
      const op = await manager();
      const send = await c.send(op);
      const loser: Loser = {
        winner: () => send(op),
        afterLoserTx: () => op.revokeEvaluationObject(),
        ...(c.ledgerConflict ? { ledgerConflict: true } : {}),
      };
      hooks.loser = loser;
      const response = await send(op);
      const won = await loser.winnerResponse!.clone().json();
      expect(loser.winnerResponse!.ok, JSON.stringify(won)).toBe(true);
      expect([403, 404]).toContain(response.status);
      expect(await response.clone().text()).not.toContain((won as GroupView).id);
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

    it('POST 回查：回查前撤销员工信息查看权 → 重放胜者结果，但成员只剩 ID（人员访问重新解析）', async () => {
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
      expect(loser.winnerResponse!.status).toBe(201);
      const replayed = (await response.json()) as GroupView;
      expect(replayed.members.map((m) => Object.keys(m).sort())).toEqual([['employeeId', 'isLeader']]);
    });
  });
});
