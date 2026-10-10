/**
 * R3-T02 PR-B 配置字典写入的“命令事务内当前权限复核”（B1b 第 1 轮 P2-01，审查含 B1a 活动类型的同一包装器；DEC-317① 信息
 * 泄露例外；AGENTS §10 权限、DEC-067）：路由层检查之后、命令事务之前撤权，
 * - 首次执行：POST / PATCH / DELETE 按**事务内**当前授权拒绝（范围撤销 404、字段编辑权撤销 403），业务写 / 审计 / 命令台账
 *   都不提交；
 * - 幂等重放：同键重放按当前授权拒绝，不返回首次结果，也不因“失败后回查台账”绕过复核。
 * 确定性交错：mock `runCommand`，在它开事务前执行测试注入的钩子（路由层检查此时已全部通过）。
 * #199 第 3 轮（DEC-338⑤ / DEC-385③）：并发同键同内容的败者走“失败后回查台账”出口时同样按当前权限复核。PGlite 单连接
 * 无法真正交错，用确定性模拟：败者的 `runCommand` 开事务前先让胜者完整提交，把胜者的台账行暂时移走；败者主事务查不到台账、
 * 执行时撞上胜者留下的真实冲突（新建：名称唯一；修改：revision；删除：对象已删除）并回滚；回滚后放回台账、执行撤权，
 * 败者随即回查台账。9 个入口各测一次撤权（必须拒绝）与一次对照（不撤权时重放胜者结果，证明走的正是回查出口）。
 */
import { randomUUID } from 'node:crypto';
import { commandLedger, type Db, eq, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { EV_NOW, type EvaluationKey, ok, operator, type Operator } from './AC-EV-support.js';
import { seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';
import type * as RunCommands from '../../apps/api/src/commands.js';

type RunCommandModule = typeof RunCommands;
interface Loser {
  /** 胜者：同一操作人、同键同内容的完整请求。 */
  readonly winner: () => Promise<Response>;
  /** 败者主事务回滚、台账放回之后执行（撤权，或对照组什么都不做）。 */
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

/** 第一个事务（败者主事务）开始前移走胜者的台账行，结束后放回并执行 afterLoserTx；之后的事务（回查）原样。 */
function loserDb(db: Db, tenantId: string, commandId: string, loser: Loser): Db {
  let first = true;
  const wrapper = Object.create(db) as Db;
  wrapper.transaction = (async (fn: Parameters<Db['transaction']>[0]) => {
    if (!first) return db.transaction(fn);
    first = false;
    const [row] = await withTenant(db, tenantId, (tx) =>
      tx.delete(commandLedger).where(eq(commandLedger.commandId, commandId)).returning(),
    );
    if (!row) throw new Error('胜者没有写台账，模拟前提不成立');
    try {
      return await db.transaction(fn);
    } finally {
      await withTenant(db, tenantId, (tx) => tx.insert(commandLedger).values(row));
      await loser.afterLoserTx();
    }
  }) as Db['transaction'];
  return wrapper;
}

const testDb = useTestDb();
const name = (label = '复核') => `${label}${randomUUID().slice(0, 6)}`;

interface Row {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly description?: string | null;
}
interface Subject {
  readonly key: EvaluationKey;
  readonly label: string;
  readonly path: string;
  readonly objectType: string;
  /** 撤销编辑权的字段，及一个会触发该字段检查的修改载荷。 */
  readonly field: string;
  readonly fieldPatch: Record<string, unknown>;
  readonly extra: Record<string, unknown>;
}
const SUBJECTS: readonly Subject[] = [
  {
    key: 'activityType',
    label: '活动类型（B1a）',
    path: '/activity-types',
    objectType: 'TEvaluation.ActivityType',
    field: 'syncQualification',
    fieldPatch: { syncQualification: true },
    extra: {},
  },
  {
    key: 'activityCycle',
    label: '活动周期',
    path: '/activity-cycles',
    objectType: 'TEvaluation.ActivityCycle',
    field: 'enabled',
    fieldPatch: { enabled: false },
    extra: {},
  },
  {
    key: 'generalScoreItem',
    label: '通用评分项',
    path: '/general-score-items',
    objectType: 'TEvaluation.GeneralScoreItem',
    field: 'description',
    fieldPatch: { description: null },
    extra: { description: '现场表现' },
  },
];

describe.each(SUBJECTS)('AC-EV-config-dicts 命令事务内权限复核 $label', (s) => {
  let world: PermissionWorld;
  beforeAll(async () => {
    const seeded = await seedPermissionWorld(testDb().db);
    world = { ...seeded, api: tenantApi(seeded.db, { authorize: undefined, clock: () => EV_NOW }) };
  });
  const seeAll = (auditor = false) => operator(world, { seeAll: true, auditor });
  const create = (op: Operator, extra: Record<string, unknown> = {}, key: string = randomUUID()) =>
    op.request('POST', s.path, { ifMatch: 0, idempotencyKey: key, body: { name: name(), ...s.extra, ...extra } });
  const created = (op: Operator) => create(op).then((r) => ok<Row>(r, 201));
  const read = (op: Operator, id: string) => op.request('GET', `${s.path}/${id}`);
  const ledger = async (key: string) =>
    withTenant(testDb().db, world.tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT count(*)::int AS n FROM command_ledger WHERE command_id = ${key}`);
      const rows = (Array.isArray(result) ? result : (result as { rows: { n: number }[] }).rows) as { n: number }[];
      return Number(rows[0]?.n);
    });
  const auditCount = async (admin: Operator) => {
    const audit = auditApi(testDb().db, EV_NOW.toISOString(), { authorize: undefined });
    return (await audit.dataChanges(admin.as, { objectType: s.objectType, limit: '100' })).items.length;
  };

  it('新建：检查后撤销看全部 → 404，没有落库、没有审计、没有台账', async () => {
    const admin = await seeAll(true);
    const op = await seeAll();
    const label = name('新建');
    const key = randomUUID();
    const before = await auditCount(admin);
    hooks.beforeCommand = () => op.revokeSeeAll();
    const response = await create(op, { name: label }, key);
    expect(response.status, await response.clone().text()).toBe(404);
    const listed = await ok<{ items: Row[] }>(await admin.request('GET', `${s.path}?pageSize=100`));
    expect(listed.items.some((item) => item.name === label)).toBe(false);
    expect(await auditCount(admin)).toBe(before);
    expect(await ledger(key)).toBe(0);
  });

  it('修改：检查后撤销看全部 → 404，数据不变；检查后撤销字段编辑权 → 403，数据不变（含显式清空）', async () => {
    const admin = await seeAll();
    const row = await created(admin);
    const op = await seeAll();
    hooks.beforeCommand = () => op.revokeSeeAll();
    const gone = await op.request('PATCH', `${s.path}/${row.id}`, {
      ifMatch: row.revision,
      body: { name: name('越权') },
    });
    expect(gone.status, await gone.clone().text()).toBe(404);
    expect(await ok<Row>(await read(admin, row.id))).toEqual(row);

    const writer = await seeAll();
    hooks.beforeCommand = () => writer.hide(s.key, [s.field]);
    const key = randomUUID();
    const fieldless = await writer.request('PATCH', `${s.path}/${row.id}`, {
      ifMatch: row.revision,
      idempotencyKey: key,
      body: s.fieldPatch,
    });
    expect(fieldless.status, await fieldless.clone().text()).toBe(403);
    expect(await ok<Row>(await read(admin, row.id))).toEqual(row);
    expect(await ledger(key)).toBe(0);
  });

  it('删除：检查后撤销看全部 → 404，对象仍在、审计与台账不变', async () => {
    const admin = await seeAll(true);
    const row = await created(admin);
    const op = await seeAll();
    const key = randomUUID();
    const before = await auditCount(admin);
    hooks.beforeCommand = () => op.revokeSeeAll();
    const response = await op.request('DELETE', `${s.path}/${row.id}`, {
      ifMatch: row.revision,
      idempotencyKey: key,
    });
    expect(response.status, await response.clone().text()).toBe(404);
    expect(await ok<Row>(await read(admin, row.id))).toEqual(row);
    expect(await auditCount(admin)).toBe(before);
    expect(await ledger(key)).toBe(0);
  });

  it('重放：首次成功后、同键重放前撤销看全部 → 404，不返回首次结果；撤销字段编辑权 → 403', async () => {
    const op = await seeAll();
    const key = randomUUID();
    const body = { name: name('重放'), ...s.extra };
    const first = await ok<Row>(await op.request('POST', s.path, { ifMatch: 0, idempotencyKey: key, body }), 201);
    hooks.beforeCommand = () => op.revokeSeeAll();
    const replay = await op.request('POST', s.path, { ifMatch: 0, idempotencyKey: key, body });
    expect(replay.status, await replay.clone().text()).toBe(404);
    expect(await replay.clone().text()).not.toContain(first.id);

    const admin = await seeAll();
    const row = await created(admin);
    const writer = await seeAll();
    const patchKey = randomUUID();
    const patch = () =>
      writer.request('PATCH', `${s.path}/${row.id}`, {
        ifMatch: row.revision,
        idempotencyKey: patchKey,
        body: s.fieldPatch,
      });
    await ok(await patch());
    hooks.beforeCommand = () => writer.hide(s.key, [s.field]);
    const denied = await patch();
    expect(denied.status, await denied.clone().text()).toBe(403);
  });
});

describe.each(SUBJECTS)('AC-EV-config-dicts 失败后回查台账出口的权限复核 $label', (s) => {
  let world: PermissionWorld;
  beforeAll(async () => {
    const seeded = await seedPermissionWorld(testDb().db);
    world = { ...seeded, api: tenantApi(seeded.db, { authorize: undefined, clock: () => EV_NOW }) };
  });
  const seeAll = () => operator(world, { seeAll: true });

  /** 一个可重复发送的请求：胜者与败者同键同内容。 */
  type Send = (op: Operator) => Promise<Response>;
  const cases: readonly {
    readonly method: string;
    readonly error: string;
    readonly send: (op: Operator) => Promise<Send>;
  }[] = [
    {
      method: 'POST',
      error: '名称唯一冲突',
      send: async () => {
        const key = randomUUID();
        const body = { name: name('并发'), ...s.extra };
        return (op) => op.request('POST', s.path, { ifMatch: 0, idempotencyKey: key, body });
      },
    },
    {
      method: 'PATCH',
      error: 'revision 冲突',
      send: async (op) => {
        const row = await ok<Row>(
          await op.request('POST', s.path, { ifMatch: 0, body: { name: name(), ...s.extra } }),
          201,
        );
        const key = randomUUID();
        const body = { name: name('改') };
        return (o) => o.request('PATCH', `${s.path}/${row.id}`, { ifMatch: row.revision, idempotencyKey: key, body });
      },
    },
    {
      method: 'DELETE',
      error: '对象已删除',
      send: async (op) => {
        const row = await ok<Row>(
          await op.request('POST', s.path, { ifMatch: 0, body: { name: name(), ...s.extra } }),
          201,
        );
        const key = randomUUID();
        return (o) => o.request('DELETE', `${s.path}/${row.id}`, { ifMatch: row.revision, idempotencyKey: key });
      },
    },
  ];

  it.each(cases)('$method（$error）：败者回滚后、回查前撤销看全部 → 404，不返回胜者结果', async (c) => {
    const op = await seeAll();
    const send = await c.send(op);
    const loser: Loser = { winner: () => send(op), afterLoserTx: () => op.revokeSeeAll() };
    hooks.loser = loser;
    const response = await send(op);
    const won = await loser.winnerResponse!.clone().json();
    expect(loser.winnerResponse!.ok, JSON.stringify(won)).toBe(true);
    expect(response.status, await response.clone().text()).toBe(404);
    expect(await response.clone().text()).not.toContain((won as Row).id);
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
