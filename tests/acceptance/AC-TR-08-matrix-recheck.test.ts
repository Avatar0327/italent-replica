/**
 * AC-TR-08-matrix-recheck · F-085 第 1 轮 P2-01：九宫格 6 个写入口的“命令事务内当前权限复核”（DEC-388①；AGENTS §10 权限、
 * DEC-067；DEC-385③ 同类问题不换出口）。入口：POST / PATCH / DELETE /matrices，POST / PATCH / DELETE /matrices/:id/ratio-groups。
 * 路由层检查之后、命令事务之前撤权，三个出口都必须按**事务内**当前授权拒绝，且业务、revision、审计、台账都不提交：
 * - 首次执行：撤范围 404、撤按钮 403、撤字段编辑权 403、撤字段目录范围 404（带字段引用的入口）；
 * - 直接重放：首次成功后、同键重放前撤权，不返回首次结果；
 * - 失败后回查台账：并发同键败者回滚后、回查前撤权，不返回胜者结果（对照：不撤权时重放胜者结果）。
 * 确定性交错：mock `runCommand`，在它开事务前执行测试注入的钩子（路由层检查此时已全部通过）；失败后回查用与
 * AC-EV-config-dicts-recheck 相同的败者模拟（PGlite 单连接无法真正交错）。
 */
import { randomUUID } from 'node:crypto';
import { commandLedger, type Db, eq, sql, type Tx, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import { configBody, TR_BASE, TR_NOW } from './AC-TR-config-support.js';
import { MATRICES, matrixBody, matrixOperator, type MatrixView, ratioGroupBody } from './AC-TR-matrix-support.js';
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
const unique = (label: string) => `${label}${randomUUID().slice(0, 6)}`;

let world: PermissionWorld;
let setup: ReturnType<typeof tenantApi>;
const admin = async (method: string, path: string, ifMatch: number, body?: unknown) => {
  const response = await setup.request(method, `${TR_BASE}${path}`, { ...world.asAdmin, ifMatch, body });
  expect(response.status, await response.clone().text()).toBeLessThan(300);
  return (await response.json()) as MatrixView;
};
const adminRead = async (id: string) =>
  (await (await setup.request('GET', `${TR_BASE}${MATRICES}/${id}`, world.asAdmin)).json()) as MatrixView;

const optionField = () =>
  admin(
    'POST',
    '/fields',
    0,
    configBody('field', {
      kind: 'option',
      group: 'result',
      options: [
        { value: '1', label: '低' },
        { value: '2', label: '中' },
        { value: '3', label: '高' },
      ],
    }),
  );
const positionField = () => admin('POST', '/fields', 0, configBody('field', { kind: 'number', group: 'position' }));
const freshRefs = async () => ({
  x: (await optionField()).id,
  y: (await optionField()).id,
  before: (await positionField()).id,
  after: (await positionField()).id,
});
const freshMatrix = async () => admin('POST', MATRICES, 0, matrixBody(await freshRefs()));

type Operator = Awaited<ReturnType<typeof matrixOperator>>;
/** 一个可重复发送的请求（同键同内容）与它的“状态快照”（撤权被拒时必须不变）。 */
interface Prepared {
  readonly send: (op: Operator) => Promise<Response>;
  readonly key: string;
  readonly snapshot: () => Promise<unknown>;
  /** 写成功后响应里能认出首次结果的标识（重放被拒时响应不得含它）。 */
  readonly marker: (first: unknown) => string;
}
interface Entry {
  readonly name: string;
  readonly status: 200 | 201;
  readonly prepare: () => Promise<Prepared>;
  /** 带字段引用（轴 / 位置字段）的入口：另有“字段目录范围”复核。 */
  readonly references?: boolean;
  /** 该入口载荷里会被逐字段复核编辑权的字段。 */
  readonly editField: string;
}
const send = (method: string, path: string, key: string, ifMatch: number, body?: unknown) => (op: Operator) =>
  op.request(method, path, { ifMatch, idempotencyKey: key, ...(body === undefined ? {} : { body }) });

const ENTRIES: readonly Entry[] = [
  {
    name: 'POST /matrices',
    status: 201,
    references: true,
    editField: 'name',
    prepare: async () => {
      const body = matrixBody(await freshRefs());
      const key = randomUUID();
      return {
        send: send('POST', MATRICES, key, 0, body),
        key,
        snapshot: async () => {
          const list = (await (
            await setup.request('GET', `${TR_BASE}${MATRICES}?pageSize=200`, world.asAdmin)
          ).json()) as {
            items: { code: string }[];
          };
          return list.items.some((item) => item.code === body.code);
        },
        marker: (first) => (first as MatrixView).id,
      };
    },
  },
  {
    name: 'PATCH /matrices/:id',
    status: 200,
    references: true,
    editField: 'name',
    prepare: async () => {
      const matrix = await freshMatrix();
      const refs = await freshRefs();
      const key = randomUUID();
      // 改名 + 换轴字段（带字段引用）
      const body = { name: unique('改名'), xFieldId: refs.x };
      return {
        send: send('PATCH', `${MATRICES}/${matrix.id}`, key, matrix.revision, body),
        key,
        snapshot: () => adminRead(matrix.id),
        marker: () => body.name,
      };
    },
  },
  {
    name: 'DELETE /matrices/:id',
    status: 200,
    editField: 'name',
    prepare: async () => {
      const matrix = await freshMatrix();
      const key = randomUUID();
      return {
        send: send('DELETE', `${MATRICES}/${matrix.id}`, key, matrix.revision),
        key,
        snapshot: () => adminRead(matrix.id),
        marker: () => matrix.code,
      };
    },
  },
  {
    name: 'POST /matrices/:id/ratio-groups',
    status: 201,
    editField: 'ratioGroups',
    prepare: async () => {
      const matrix = await freshMatrix();
      const key = randomUUID();
      const body = ratioGroupBody({ name: unique('规则组') });
      return {
        send: send('POST', `${MATRICES}/${matrix.id}/ratio-groups`, key, matrix.revision, body),
        key,
        snapshot: () => adminRead(matrix.id),
        marker: () => body.name,
      };
    },
  },
  {
    name: 'PATCH /matrices/:id/ratio-groups/:groupId',
    status: 200,
    editField: 'ratioGroups',
    prepare: async () => {
      const matrix = await freshMatrix();
      const withGroup = await admin('POST', `${MATRICES}/${matrix.id}/ratio-groups`, matrix.revision, ratioGroupBody());
      const group = withGroup.ratioGroups[0]!;
      const key = randomUUID();
      const body = { name: unique('改组名') };
      return {
        send: send('PATCH', `${MATRICES}/${matrix.id}/ratio-groups/${group.id}`, key, withGroup.revision, body),
        key,
        snapshot: () => adminRead(matrix.id),
        marker: () => body.name,
      };
    },
  },
  {
    name: 'DELETE /matrices/:id/ratio-groups/:groupId',
    status: 200,
    editField: 'ratioGroups',
    prepare: async () => {
      const matrix = await freshMatrix();
      const withGroup = await admin('POST', `${MATRICES}/${matrix.id}/ratio-groups`, matrix.revision, ratioGroupBody());
      const group = withGroup.ratioGroups[0]!;
      const key = randomUUID();
      return {
        send: send('DELETE', `${MATRICES}/${matrix.id}/ratio-groups/${group.id}`, key, withGroup.revision),
        key,
        snapshot: () => adminRead(matrix.id),
        marker: () => group.name,
      };
    },
  },
];

const ledger = (key: string) =>
  withTenant(testDb().db, world.tenant.id, async (tx) => {
    const result = await tx.execute(sql`SELECT count(*)::int AS n FROM command_ledger WHERE command_id = ${key}`);
    const rows = (Array.isArray(result) ? result : (result as { rows: { n: number }[] }).rows) as { n: number }[];
    return Number(rows[0]?.n);
  });
const auditCount = async () => {
  const audit = auditApi(testDb().db, TR_NOW.toISOString(), { authorize: undefined });
  return (await audit.dataChanges(world.asAdmin, { objectType: 'TalentReview.Matrix', limit: '100' })).items.length;
};
const writer = () => matrixOperator(world, { seeAll: true, fields: 'seeAll' });

beforeAll(async () => {
  world = await seedPermissionWorld(testDb().db);
  setup = tenantApi(world.db, { clock });
  world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock }) };
});

describe.each(ENTRIES)('九宫格写入口命令事务内权限复核 · $name', (entry) => {
  it('首次执行：路由检查后撤销看全部 → 404，业务 / 审计 / 台账都不提交', async () => {
    const prepared = await entry.prepare();
    const op = await writer();
    const before = await prepared.snapshot();
    const audits = await auditCount();
    hooks.beforeCommand = () => op.setSeeAll('matrix', false);
    const response = await prepared.send(op);
    expect(response.status, await response.clone().text()).toBe(404);
    expect(await prepared.snapshot()).toEqual(before);
    expect(await auditCount()).toBe(audits);
    expect(await ledger(prepared.key)).toBe(0);
  });

  it('首次执行：路由检查后撤销按钮 → 403；撤销字段编辑权 → 403；都不提交', async () => {
    const prepared = await entry.prepare();
    const op = await writer();
    const before = await prepared.snapshot();
    hooks.beforeCommand = () => op.setButtons(false);
    const button = await prepared.send(op);
    expect(button.status, await button.clone().text()).toBe(403);
    expect(await prepared.snapshot()).toEqual(before);
    if (entry.name.startsWith('DELETE')) return;
    const second = await entry.prepare();
    const locked = await writer();
    hooks.beforeCommand = () => locked.lockFields([entry.editField]);
    const field = await second.send(locked);
    expect(field.status, await field.clone().text()).toBe(403);
    expect(await ledger(second.key)).toBe(0);
  });

  it.runIf(entry.references)('首次执行：路由检查后撤销字段目录范围 → 404（引用字段看不到），不提交', async () => {
    const prepared = await entry.prepare();
    const op = await writer();
    const before = await prepared.snapshot();
    hooks.beforeCommand = () => op.setSeeAll('field', false);
    const response = await prepared.send(op);
    expect(response.status, await response.clone().text()).toBe(404);
    expect(await prepared.snapshot()).toEqual(before);
    expect(await ledger(prepared.key)).toBe(0);
  });

  it('直接重放：首次成功后、同键重放前撤销看全部 → 404，不返回首次结果', async () => {
    const prepared = await entry.prepare();
    const op = await writer();
    const first = await prepared.send(op);
    expect(first.status, await first.clone().text()).toBe(entry.status);
    const firstBody = await first.json();
    hooks.beforeCommand = () => op.setSeeAll('matrix', false);
    const replay = await prepared.send(op);
    expect(replay.status, await replay.clone().text()).toBe(404);
    const text = await replay.clone().text();
    expect(text).not.toContain(prepared.marker(firstBody));
  });
});

describe.each(ENTRIES)('九宫格写入口失败后回查台账出口的权限复核 · $name', (entry) => {
  /** 败者的冲突来自胜者先提交的同键同内容请求（新建重名 / 规则组重名 / revision 过期 / 对象已删除）。 */
  it('败者回滚后、回查前撤销看全部 → 404，不返回胜者结果', async () => {
    const prepared = await entry.prepare();
    const op = await writer();
    const loser: Loser = { winner: () => prepared.send(op), afterLoserTx: () => op.setSeeAll('matrix', false) };
    hooks.loser = loser;
    const response = await prepared.send(op);
    const won = await loser.winnerResponse!.clone().text();
    expect(loser.winnerResponse!.ok, won).toBe(true);
    expect(response.status, await response.clone().text()).toBe(404);
    expect(await response.clone().text()).not.toContain(prepared.marker(JSON.parse(won)));
  });

  it('对照：不撤权时败者重放胜者结果（证明走的是回查出口）', async () => {
    const prepared = await entry.prepare();
    const op = await writer();
    const loser: Loser = { winner: () => prepared.send(op), afterLoserTx: async () => undefined };
    hooks.loser = loser;
    const response = await prepared.send(op);
    expect(response.status, await response.clone().text()).toBe(loser.winnerResponse!.status);
    expect(await response.json()).toEqual(await loser.winnerResponse!.clone().json());
  });
});
