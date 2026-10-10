/**
 * R3-T04 PR-B2a 评价规则 / 模块等级写入的“命令事务内当前权限复核”（第 1 轮审查 P2-01，DEC-388①；DEC-317① 信息泄露例外；
 * AGENTS §10 权限、DEC-067）：路由层检查之后、命令事务之前撤权，
 * - 首次执行：POST / PATCH / DELETE 按**事务内**当前授权拒绝（撤看全部 404、撤按钮 403、撤字段编辑权 403），业务写 / revision /
 *   审计 / 命令台账都不提交；
 * - 幂等重放：同键重放按当前授权拒绝，不返回首次结果；并发同键败者“失败后回查台账”出口同样复核。
 * 确定性交错：mock `runCommand`，在它开事务前执行测试注入的钩子（路由层检查此时已全部通过）；败者出口用 AC-EV 同款模拟
 * （胜者先完整提交，台账行暂时移走，败者主事务撞上真实冲突回滚，放回台账、撤权后败者回查）。
 * 6 个写入口 × 首次 / 直接重放 / 失败后回查 三个出口；每个拒绝用例都对照“不撤权时成功”，证明钩子确实落在检查之后。
 */
import { randomUUID } from 'node:crypto';
import { commandLedger, type Db, eq, sql, type Tx, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import {
  configOperator,
  gradeRuleBody,
  moduleGradeBody,
  TR_BASE,
  TR_NOW,
  type ConfigView,
} from './AC-TR-scoring-support.js';
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

interface Subject {
  readonly object: 'scoreRule' | 'moduleGrade';
  readonly path: string;
  readonly objectType: string;
  readonly body: (name: string) => Record<string, unknown>;
  /** 会触发字段编辑权检查的修改载荷，及其字段。 */
  readonly field: string;
  readonly fieldPatch: Record<string, unknown>;
}
const SUBJECTS: readonly Subject[] = [
  {
    object: 'scoreRule',
    path: '/score-rules',
    objectType: 'TalentReview.ScoreRule',
    body: (name) => gradeRuleBody({ name }),
    field: 'allowUnable',
    fieldPatch: { allowUnable: true },
  },
  {
    object: 'moduleGrade',
    path: '/module-grades',
    objectType: 'TalentReview.ModuleGrade',
    body: (name) => moduleGradeBody({ name }),
    field: 'enabled',
    fieldPatch: { enabled: false },
  },
];

describe.each(SUBJECTS)('AC-TR-scoring-recheck 命令事务内权限复核 · $object', (s) => {
  let world: PermissionWorld;
  let setup: ReturnType<typeof tenantApi>;
  beforeAll(async () => {
    const seeded = await seedPermissionWorld(testDb().db);
    world = { ...seeded, api: tenantApi(seeded.db, { authorize: undefined, clock }) };
    setup = tenantApi(seeded.db, { clock });
  });
  const seeAll = () => configOperator(world, s.object, { seeAll: true });
  type Operator = Awaited<ReturnType<typeof seeAll>>;
  const adminGet = async (path: string) => setup.request('GET', `${TR_BASE}${path}`, { ...world.asAdmin });
  const adminRead = async (id: string) => (await (await adminGet(`${s.path}/${id}`)).json()) as ConfigView;
  const adminNames = async () =>
    ((await (await adminGet(`${s.path}?pageSize=100`)).json()) as { items: { name: string }[] }).items.map(
      (item) => item.name,
    );
  const count = async (query: ReturnType<typeof sql>) =>
    withTenant(testDb().db, world.tenant.id, async (tx) => {
      const result = await tx.execute(query);
      const rows = (Array.isArray(result) ? result : (result as { rows: { n: number }[] }).rows) as { n: number }[];
      return Number(rows[0]?.n);
    });
  const ledger = (key: string) => count(sql`SELECT count(*)::int AS n FROM command_ledger WHERE command_id = ${key}`);
  const audits = () => count(sql`SELECT count(*)::int AS n FROM audit_events WHERE object_type = ${s.objectType}`);
  const post = (op: Operator, name: string, key: string = randomUUID()) =>
    op.request('POST', s.path, { ifMatch: 0, idempotencyKey: key, body: s.body(name) });
  const created = async (op: Operator) => {
    const response = await post(op, uniq('建'));
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as ConfigView;
  };
  const patch = (op: Operator, row: ConfigView, body: Record<string, unknown>, key: string = randomUUID()) =>
    op.request('PATCH', `${s.path}/${row.id}`, { ifMatch: row.revision, idempotencyKey: key, body });
  const remove = (op: Operator, row: ConfigView, key: string = randomUUID()) =>
    op.request('DELETE', `${s.path}/${row.id}`, { ifMatch: row.revision, idempotencyKey: key });
  const expectStatus = async (response: Response, status: number) =>
    expect(response.status, await response.clone().text()).toBe(status);

  it('对照：不撤权时三个入口都成功（钩子确实落在路由检查之后）', async () => {
    const op = await seeAll();
    const row = await created(op);
    await expectStatus(await patch(op, row, s.fieldPatch), 200);
    const next = await adminRead(row.id);
    await expectStatus(await remove(op, next), 200);
  });

  it('新建：检查后撤销看全部 → 404；撤销新建按钮 → 403；都没有落库、没有审计、没有台账', async () => {
    for (const [revoke, status] of [
      [(op: Operator) => op.setSeeAll(false), 404],
      [(op: Operator) => op.setButtons(true, ['create']), 403],
    ] as const) {
      const op = await seeAll();
      const name = uniq('新建');
      const key = randomUUID();
      const before = await audits();
      hooks.beforeCommand = () => revoke(op);
      const response = await post(op, name, key);
      await expectStatus(response, status);
      expect(await adminNames()).not.toContain(name);
      expect(await audits()).toBe(before);
      expect(await ledger(key)).toBe(0);
    }
  });

  it('修改：检查后撤销看全部 404 / 撤销字段编辑权 403 / 撤销按钮 403；数据、revision、审计、台账都不变', async () => {
    const admin = await seeAll();
    const row = await created(admin);
    const cases: readonly [(op: Operator) => Promise<void>, number][] = [
      [(op) => op.setSeeAll(false), 404],
      [(op) => op.lockFields([s.field]), 403],
      [(op) => op.setButtons(true, ['update']), 403],
    ];
    for (const [revoke, status] of cases) {
      const op = await seeAll();
      const key = randomUUID();
      const before = await audits();
      hooks.beforeCommand = () => revoke(op);
      await expectStatus(await patch(op, row, s.fieldPatch, key), status);
      expect(await adminRead(row.id)).toEqual(row);
      expect(await audits()).toBe(before);
      expect(await ledger(key)).toBe(0);
    }
  });

  it('删除：检查后撤销看全部 404 / 撤销按钮 403；对象仍在，审计、台账不变', async () => {
    const admin = await seeAll();
    const row = await created(admin);
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
      expect(await adminRead(row.id)).toEqual(row);
      expect(await audits()).toBe(before);
      expect(await ledger(key)).toBe(0);
    }
  });

  it('直接重放：首次成功后、同键重放前撤权 → 不返回首次结果（新建 404、修改 403、删除 404）', async () => {
    const op = await seeAll();
    const key = randomUUID();
    const name = uniq('重放');
    const first = (await (await post(op, name, key)).json()) as ConfigView;
    hooks.beforeCommand = () => op.setSeeAll(false);
    const replayCreate = await post(op, name, key);
    await expectStatus(replayCreate, 404);
    expect(await replayCreate.clone().text()).not.toContain(first.id);

    const writer = await seeAll();
    const row = await created(writer);
    const patchKey = randomUUID();
    await expectStatus(await patch(writer, row, s.fieldPatch, patchKey), 200);
    hooks.beforeCommand = () => writer.lockFields([s.field]);
    await expectStatus(await patch(writer, row, s.fieldPatch, patchKey), 403);

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
      error: '名称唯一冲突',
      send: async () => {
        const key = randomUUID();
        const name = uniq('并发');
        return (op) => post(op, name, key);
      },
    },
    {
      method: 'PATCH',
      error: 'revision 冲突',
      send: async (op) => {
        const row = await created(op);
        const key = randomUUID();
        const body = { name: uniq('改') };
        return (o) => patch(o, row, body, key);
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
