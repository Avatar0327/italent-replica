/**
 * R3-T04 PR-B2b 字段映射写入的“命令事务内当前权限复核”（DEC-388①，同 B2a 第 1 轮 P2-01 的写法；DEC-317① 信息泄露例外；
 * AGENTS §10 权限、DEC-067）：路由层检查之后、命令事务之前撤权，
 * - 首次执行：POST / PATCH / DELETE 按**事务内**当前授权拒绝——映射对象的看全部（404）、按钮（403）、字段编辑权（403），
 *   以及**引用字段 = 读取字段对象**的数据范围（404）；业务写 / revision / 审计 / 命令台账都不提交；
 * - 幂等重放：同键重放按当前授权拒绝，不返回首次结果；并发同键败者“失败后回查台账”出口同样复核。
 * 确定性交错：mock `runCommand`，在它开事务前执行测试注入的钩子（路由层检查此时已全部通过）；败者出口用胜者先提交 + 台账行暂移模拟。
 * 每个拒绝用例都对照“不撤权时成功”，证明钩子确实落在检查之后。
 */
import { randomUUID } from 'node:crypto';
import { commandLedger, type Db, eq, sql, type Tx, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import { configOperator, mappingBody, TR_BASE, TR_NOW, type ConfigView } from './AC-TR-scoring-support.js';
import { tenantApi } from './support/tenant-api.js';
import type * as RunCommands from '../../apps/api/src/commands.js';

type RunCommandModule = typeof RunCommands;
interface Loser {
  readonly winner: () => Promise<Response>;
  readonly afterLoserTx: () => Promise<void>;
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
      return original.runCommand(loserDb(db, ctx.tenantId, command.id!, loser), ctx, command);
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
const clock = () => TR_NOW;
const uniq = (label: string) => `${label}${randomUUID().slice(0, 6)}`;

const OBJECT_TYPE = 'TalentReview.FieldMapping';

describe('AC-TR-field-mappings-recheck 命令事务内权限复核 · mapping', () => {
  let world: PermissionWorld;
  let setup: ReturnType<typeof tenantApi>;
  beforeAll(async () => {
    const seeded = await seedPermissionWorld(testDb().db);
    world = { ...seeded, api: tenantApi(seeded.db, { authorize: undefined, clock }) };
    setup = tenantApi(seeded.db, { clock });
  });
  /** 映射看全部 + 字段目录看全部（同一用户两个身份）；fields 是字段目录一侧的操作人，可单独撤范围。 */
  const seeAll = async () => {
    const op = await configOperator(world, 'mapping', { seeAll: true });
    const fields = await configOperator(world, 'field', { seeAll: true, user: op.user });
    return Object.assign(op, { fields });
  };
  type Operator = Awaited<ReturnType<typeof seeAll>>;
  const adminPost = async (path: string, body: Record<string, unknown>) => {
    const response = await setup.request('POST', `${TR_BASE}${path}`, { ...world.asAdmin, ifMatch: 0, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as ConfigView;
  };
  const field = () => {
    const n = uniq('f');
    return adminPost('/fields', { code: `rc_${n}`, name: `复核字段${n}`, kind: 'text', group: 'evaluation' });
  };
  const adminGet = (path: string) => setup.request('GET', `${TR_BASE}${path}`, { ...world.asAdmin });
  const adminRead = async (id: string) => (await (await adminGet(`/field-mappings/${id}`)).json()) as ConfigView;
  const mappingIds = async () =>
    ((await (await adminGet('/field-mappings?pageSize=100')).json()) as { items: { id: string }[] }).items.map(
      (item) => item.id,
    );
  const count = async (query: ReturnType<typeof sql>) =>
    withTenant(testDb().db, world.tenant.id, async (tx) => {
      const result = await tx.execute(query);
      const rows = (Array.isArray(result) ? result : (result as { rows: { n: number }[] }).rows) as { n: number }[];
      return Number(rows[0]?.n);
    });
  const ledger = (key: string) => count(sql`SELECT count(*)::int AS n FROM command_ledger WHERE command_id = ${key}`);
  const audits = () => count(sql`SELECT count(*)::int AS n FROM audit_events WHERE object_type = ${OBJECT_TYPE}`);
  const post = async (op: Operator, key: string = randomUUID(), pair?: [string, string]) => {
    const [a, b] = pair ?? [(await field()).id, (await field()).id];
    return op.request('POST', '/field-mappings', { ifMatch: 0, idempotencyKey: key, body: mappingBody(a, b) });
  };
  const created = async (op: Operator) => {
    const response = await post(op);
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as ConfigView;
  };
  const retarget = async (op: Operator, row: ConfigView, key: string = randomUUID(), targetFieldId?: string) =>
    op.request('PATCH', `/field-mappings/${row.id}`, {
      ifMatch: row.revision,
      idempotencyKey: key,
      body: { targetFieldId: targetFieldId ?? (await field()).id },
    });
  const remove = (op: Operator, row: ConfigView, key: string = randomUUID()) =>
    op.request('DELETE', `/field-mappings/${row.id}`, { ifMatch: row.revision, idempotencyKey: key });
  const expectStatus = async (response: Response, status: number) =>
    expect(response.status, await response.clone().text()).toBe(status);

  it('对照：不撤权时三个入口都成功（钩子确实落在路由检查之后）', async () => {
    const op = await seeAll();
    const row = await created(op);
    await expectStatus(await retarget(op, row), 200);
    await expectStatus(await remove(op, await adminRead(row.id)), 200);
  });

  it('新建：检查后撤映射看全部 404 / 撤新建按钮 403 / 撤字段目录范围 404；没有落库、没有审计、没有台账', async () => {
    const cases: readonly [(op: Operator) => Promise<void>, number][] = [
      [(op) => op.setSeeAll(false), 404],
      [(op) => op.setButtons(true, ['create']), 403],
      [(op) => op.fields.setSeeAll(false), 404],
    ];
    for (const [revoke, status] of cases) {
      const op = await seeAll();
      const key = randomUUID();
      const before = await mappingIds();
      const auditsBefore = await audits();
      hooks.beforeCommand = () => revoke(op);
      await expectStatus(await post(op, key), status);
      expect(await mappingIds()).toEqual(before);
      expect(await audits()).toBe(auditsBefore);
      expect(await ledger(key)).toBe(0);
    }
  });

  it('修改来源 / 目标字段：检查后撤映射看全部 404 / 撤字段编辑权 403 / 撤按钮 403 / 撤字段目录范围 404；数据、审计、台账不变', async () => {
    const admin = await seeAll();
    const row = await created(admin);
    const baseline = await adminRead(row.id);
    const cases: readonly [(op: Operator) => Promise<void>, number][] = [
      [(op) => op.setSeeAll(false), 404],
      [(op) => op.lockFields(['targetFieldId']), 403],
      [(op) => op.setButtons(true, ['update']), 403],
      [(op) => op.fields.setSeeAll(false), 404],
    ];
    for (const [revoke, status] of cases) {
      const op = await seeAll();
      const key = randomUUID();
      const before = await audits();
      hooks.beforeCommand = () => revoke(op);
      await expectStatus(await retarget(op, row, key), status);
      expect(await adminRead(row.id)).toEqual(baseline);
      expect(await audits()).toBe(before);
      expect(await ledger(key)).toBe(0);
    }
  });

  it('删除：检查后撤映射看全部 404 / 撤删除按钮 403；对象仍在，审计、台账不变', async () => {
    const admin = await seeAll();
    const row = await created(admin);
    const baseline = await adminRead(row.id);
    const cases: readonly [(op: Operator) => Promise<void>, number][] = [
      [(op) => op.setSeeAll(false), 404],
      [(op) => op.setButtons(true, ['delete']), 403],
    ];
    for (const [revoke, status] of cases) {
      const op = await seeAll();
      const key = randomUUID();
      const before = await audits();
      hooks.beforeCommand = () => revoke(op);
      await expectStatus(await remove(op, row, key), status);
      expect(await adminRead(row.id)).toEqual(baseline);
      expect(await audits()).toBe(before);
      expect(await ledger(key)).toBe(0);
    }
  });

  it('直接重放：首次成功后、同键重放前撤权 → 不返回首次结果（新建撤映射范围 404 / 撤字段目录范围 404、修改撤字段编辑权 403、删除 404）', async () => {
    for (const revoke of [(op: Operator) => op.setSeeAll(false), (op: Operator) => op.fields.setSeeAll(false)]) {
      const op = await seeAll();
      const key = randomUUID();
      const pair: [string, string] = [(await field()).id, (await field()).id];
      const first = (await (await post(op, key, pair)).json()) as ConfigView;
      hooks.beforeCommand = () => revoke(op);
      const replay = await post(op, key, pair);
      await expectStatus(replay, 404);
      expect(await replay.clone().text()).not.toContain(first.id);
    }

    const writer = await seeAll();
    const row = await created(writer);
    const patchKey = randomUUID();
    const target = (await field()).id;
    await expectStatus(await retarget(writer, row, patchKey, target), 200);
    hooks.beforeCommand = () => writer.lockFields(['targetFieldId']);
    await expectStatus(await retarget(writer, row, patchKey, target), 403);

    const eraser = await seeAll();
    const gone = await created(eraser);
    const deleteKey = randomUUID();
    await expectStatus(await remove(eraser, gone, deleteKey), 200);
    hooks.beforeCommand = () => eraser.setSeeAll(false);
    await expectStatus(await remove(eraser, gone, deleteKey), 404);
  });

  /** 一个可重复发送的请求：胜者与败者同键同内容；error 是败者主事务撞上的真实冲突。 */
  type Send = (op: Operator) => Promise<Response>;
  const cases: readonly { method: string; error: string; send: (op: Operator) => Promise<Send> }[] = [
    {
      method: 'POST',
      error: '同场景同来源 / 目标唯一冲突',
      send: async () => {
        const key = randomUUID();
        const pair: [string, string] = [(await field()).id, (await field()).id];
        return (op) => post(op, key, pair);
      },
    },
    {
      method: 'PATCH',
      error: 'revision 冲突',
      send: async (op) => {
        const row = await created(op);
        const key = randomUUID();
        const target = (await field()).id;
        return (o) => retarget(o, row, key, target);
      },
    },
    {
      method: 'DELETE',
      error: '对象已删除',
      send: async (op) => {
        const row = await created(op);
        const key = randomUUID();
        return (o) => remove(o, row, key);
      },
    },
  ];

  it.each(cases)('$method（$error）：败者回滚后、回查前撤销看全部 → 404，不返回胜者结果', async (c) => {
    const op = await seeAll();
    const send = await c.send(op);
    const loser: Loser = { winner: () => send(op), afterLoserTx: () => op.setSeeAll(false) };
    hooks.loser = loser;
    const response = await send(op);
    const won = await loser.winnerResponse!.clone().json();
    expect(loser.winnerResponse!.ok, JSON.stringify(won)).toBe(true);
    await expectStatus(response, 404);
    expect(await response.clone().text()).not.toContain((won as ConfigView).id);
  });

  it('POST（唯一冲突）：败者回滚后、回查前撤销字段目录范围 → 404（引用字段范围也在回查出口复核）', async () => {
    const op = await seeAll();
    const send = await cases[0]!.send(op);
    const loser: Loser = { winner: () => send(op), afterLoserTx: () => op.fields.setSeeAll(false) };
    hooks.loser = loser;
    const response = await send(op);
    expect(loser.winnerResponse!.ok).toBe(true);
    await expectStatus(response, 404);
  });

  it.each(cases)('$method（$error）对照：不撤权时败者重放胜者结果（证明走的是回查出口）', async (c) => {
    const op = await seeAll();
    const send = await c.send(op);
    const loser: Loser = { winner: () => send(op), afterLoserTx: async () => undefined };
    hooks.loser = loser;
    const response = await send(op);
    expect(response.status, await response.clone().text()).toBe(loser.winnerResponse!.status);
    expect(await response.json()).toEqual(await loser.winnerResponse!.clone().json());
  });
});
