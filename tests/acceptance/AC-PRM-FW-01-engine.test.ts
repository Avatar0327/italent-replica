/**
 * AC-PRM-FW-01 接管 T1 引擎（docs/08_设计/F-039_接管T1_设计.md §2、§5.2 引擎反例；DEC-363）：
 * 已接管模块的路由由引擎按声明执行准入（S1 If-Match → S2 功能 → S3 授权输入 → S4 写字段 → S5 按钮 → S6 范围），
 * 判定由模块登记的实现执行；错误原样传播；未接管模块完全不走引擎（PR-A 包装行为不变）。
 * 用内存 Hono + 夹具模块；列表范围的事务外解析另用 PGlite 真实事务验证。
 */
import {
  AppError,
  accessOf,
  type Context,
  createApp,
  defineTable,
  ERROR_STATUS,
  Hono,
  implement,
  type ModuleImplementations,
  policed,
  type RoutePolicy,
  RoutePolicyError,
  TAKEN_OVER_MODULES,
  verifyRouteDeclarations,
} from '@italent/api';
import { sql, type Tx, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';

const testDb = useTestDb();
const MODULE = 'fixture';
const OBJECT = 'Fixture.Object';
const TENANT = '00000000-0000-4000-8000-000000000001';

interface Ctx {
  readonly tenantId: string;
  readonly expectedRevision: number;
}
interface Scope {
  readonly id: number;
}

const noFields = { mode: 'none', reason: '夹具' } as const;
const viewList: RoutePolicy = {
  kind: 'object',
  object: OBJECT,
  operation: 'view',
  button: { none: true, reason: '夹具' },
  scope: { mode: 'list', predicate: 'fixture.listSql' },
  fields: noFields,
};
const viewPoint = (tx?: 'own' | 'shared'): RoutePolicy => ({
  kind: 'object',
  object: OBJECT,
  operation: 'view',
  button: { code: 'report', level: 'detail' },
  scope: {
    mode: 'point',
    target: { param: 'id' },
    locator: 'fixture.byId',
    denied: { status: 404, code: 'NOT_FOUND' },
    ...(tx ? { tx } : {}),
  },
  fields: noFields,
  input: { parse: [{ key: 'id', using: 'fixture.id' }] },
});
const createPolicy: RoutePolicy = {
  kind: 'object',
  object: OBJECT,
  operation: 'create',
  button: { code: 'copy', level: 'list' },
  scope: { mode: 'see-all', creatorLocator: 'fixture.requester', denied: { status: 404, code: 'NOT_FOUND' } },
  fields: noFields,
  guards: ['fixture.inCommandOnly'],
  input: { revision: true, parse: [{ key: 'body', using: 'fixture.body' }] },
  write: {
    fields: 'body',
    footprint: 'fixture.replay',
    result: 'fixture.replay',
    preconditions: ['fixture.lock'],
  },
};
const adminPolicy: RoutePolicy = { kind: 'admin', capability: 'other_settings', fields: noFields };
const ownAndObject: RoutePolicy = {
  kind: 'all',
  of: [{ kind: 'own', predicate: 'fixture.recipient', fields: noFields }, viewList],
  fields: noFields,
};

const POLICIES: Readonly<Record<string, RoutePolicy>> = {
  'GET /items': viewList,
  'GET /items/:id': viewPoint(),
  'GET /items/:id/report': viewPoint('shared'),
  'POST /items': createPolicy,
  'GET /settings': adminPolicy,
  'GET /notices': ownAndObject,
};

type Trace = string[];

function fail(code: AppError['code'], message: string): never {
  throw new AppError(code, message);
}

/** 夹具实现：每一步都记进 trace；deny 里列出的步骤抛出与现有辅助函数相同形状的 AppError。 */
function fixtureImpl(trace: Trace, deny: ReadonlySet<string> = new Set()): ModuleImplementations<Ctx, Scope, string> {
  let scopes = 0;
  return {
    primitives: {
      revision: (c) => {
        trace.push('revision');
        const header = c.req.header('if-match');
        if (!header) fail('REVISION_REQUIRED', '写请求必须在 If-Match 中携带 revision');
        return Number(header);
      },
      operation: async (_c, object, operation, expectedRevision) => {
        trace.push(`operation:${object}:${operation}`);
        if (deny.has('operation')) fail('FORBIDDEN', '无权执行该操作');
        return { tenantId: TENANT, expectedRevision };
      },
      admin: async (_c, node, expectedRevision) => {
        trace.push(`admin:${node.capability}`);
        if (deny.has('admin')) fail('FORBIDDEN', '无权执行该操作');
        return { tenantId: TENANT, expectedRevision };
      },
      writeFields: async (_ctx, object, operation, payload) => {
        trace.push(`fields:${object}:${operation}:${JSON.stringify(payload)}`);
        if (deny.has('fields')) fail('FORBIDDEN', '无权执行该操作');
      },
      button: async (_ctx, object, ref) => {
        trace.push(`button:${object}#${ref.code}@${ref.level}`);
        if (deny.has('button')) fail('FORBIDDEN', '无权执行该操作');
      },
      scope: async (_c, _ctx, object, view) => {
        scopes += 1;
        trace.push(`scope:${object}:${view ?? ''}`);
        return { id: scopes };
      },
      transaction: async (_ctx, fn) => {
        trace.push('tx:begin');
        const result = await fn('shared-tx');
        trace.push('tx:end');
        return result;
      },
    },
    inputs: {
      'fixture.id': (c) => {
        trace.push('input:id');
        const id = c.req.param('id') ?? '';
        if (!/^\d+$/.test(id)) fail('VALIDATION_FAILED', '对象标识必须为数字');
        return id;
      },
      'fixture.body': async (c) => {
        trace.push('input:body');
        const body = (await c.req.json().catch(() => undefined)) as unknown;
        if (!body || typeof body !== 'object' || Array.isArray(body)) fail('VALIDATION_FAILED', '请求字段不合法');
        return body;
      },
    },
    t1: {
      'fixture.byId': async ({ c, scope, tx }) => {
        trace.push(`check:byId:${scope.id}:${tx ?? 'own'}`);
        // 现状把 asOf 放在定位器实参里解析：输入错误原样传播（设计 §2.3，不做拒绝码比较）
        if (c.req.query('asOf') === 'bad') fail('VALIDATION_FAILED', '查询时点必须为合法日期');
        if (deny.has('scope')) fail('NOT_FOUND', '对象不存在');
        return { id: c.req.param('id') };
      },
      'fixture.requester': async ({ scope }) => {
        trace.push(`check:requester:${scope.id}`);
        if (deny.has('scope')) fail('NOT_FOUND', '对象不存在');
      },
    },
    deferred: {
      'fixture.listSql': 'T2',
      'fixture.recipient': 'T2',
      'fixture.inCommandOnly': 'T3',
    },
  };
}

interface FixtureOptions {
  readonly deny?: ReadonlySet<string>;
  readonly takenOver?: readonly string[];
  readonly reportCallsTx?: boolean;
  readonly impl?: (trace: Trace) => ModuleImplementations<Ctx, Scope, string>;
}

function json(c: Context, body: unknown): Response {
  return c.json(body as object);
}

function registerFixture(app: Hono, trace: Trace, options: FixtureOptions): void {
  const router = policed(app, defineTable(MODULE, POLICIES));
  router.get('/items', async (c) => {
    const access = accessOf<Ctx, Scope, string>(c);
    trace.push('handler:before-scope');
    const scope = await access.getScope();
    const again = await access.getScope();
    trace.push(`handler:scope:${scope.id}:${again === scope}`);
    return json(c, { scope: scope.id });
  });
  router.get('/items/:id', (c) => {
    trace.push('handler');
    return json(c, { point: accessOf(c).point, input: accessOf(c).input });
  });
  router.get('/items/:id/report', async (c) => {
    trace.push('handler');
    c.header('Content-Disposition', 'attachment; filename="secret.csv"');
    if (!options.reportCallsTx) return c.body('secret-row');
    const access = accessOf<Ctx, Scope, string>(c);
    const body = await access.inScopedTx(async (tx, record) => {
      trace.push(`handler:in-tx:${tx}:${JSON.stringify(record)}`);
      return 'csv-row';
    });
    return c.body(body);
  });
  router.post('/items', (c) => {
    trace.push(`handler:ctx:${accessOf<Ctx>(c).ctx.expectedRevision}`);
    return json(c, { created: true });
  });
  router.get('/settings', (c) => {
    trace.push('handler');
    return json(c, { ok: true });
  });
  router.get('/notices', async (c) => {
    trace.push('handler');
    return json(c, { scope: (await accessOf<Ctx, Scope>(c).getScope()).id });
  });
  implement(router, MODULE, (options.impl ?? ((t) => fixtureImpl(t, options.deny)))(trace));
}

function fixtureApp(options: FixtureOptions = {}): { app: Hono; trace: Trace } {
  const trace: Trace = [];
  const app = new Hono();
  app.onError((error, c) =>
    error instanceof AppError
      ? c.json({ error: { code: error.code, message: error.message } }, error.status)
      : c.json({ error: { code: 'INTERNAL_ERROR' } }, 500),
  );
  registerFixture(app, trace, options);
  verifyRouteDeclarations(app, { takenOver: options.takenOver ?? [MODULE] });
  return { app, trace };
}

function startupFailure(run: () => unknown): RoutePolicyError {
  try {
    run();
  } catch (error) {
    if (error instanceof RoutePolicyError) return error;
    throw error;
  }
  throw new Error('期望启动失败（RoutePolicyError），实际没有抛错');
}

const post = (app: Hono, body: string, headers: Record<string, string> = { 'if-match': '0' }) =>
  app.request('/items', { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });

describe('AC-PRM-FW-01 接管引擎：零行为变化的前提', () => {
  it('本 PR 不接管任何模块：TAKEN_OVER_MODULES 为空，createApp 正常启动', () => {
    expect(TAKEN_OVER_MODULES).toEqual([]);
    expect(() => createApp({ db: testDb().db })).not.toThrow();
  });

  it('未接管模块完全不走引擎：不调用任何原语，accessOf 不可用', async () => {
    const { app, trace } = fixtureApp({ takenOver: [] });
    const res = await app.request('/settings');
    expect(res.status).toBe(200);
    expect(trace).toEqual(['handler']);
    const items = await app.request('/items');
    expect(items.status).toBe(500); // 处理函数自己调用 accessOf，未接管时不存在
    expect(trace).toEqual(['handler', 'handler:before-scope']);
  });
});

describe('AC-PRM-FW-01 接管引擎：阶段顺序（保序主序，DEC-363①）', () => {
  it('写路由：If-Match → 功能 → 请求体 → 写字段 → 按钮 → 范围 → 处理函数；延后名称不执行', async () => {
    const { app, trace } = fixtureApp();
    const res = await post(app, '{"name":"x"}', { 'if-match': '3' });
    expect(res.status).toBe(200);
    expect(trace).toEqual([
      'revision',
      `operation:${OBJECT}:create`,
      'input:body',
      `fields:${OBJECT}:create:{"name":"x"}`,
      `button:${OBJECT}#copy@list`,
      `scope:${OBJECT}:`,
      'check:requester:1',
      'handler:ctx:3',
    ]);
  });

  it.each([
    ['operation', 403, 'FORBIDDEN', ['revision', `operation:${OBJECT}:create`]],
    ['fields', 403, 'FORBIDDEN', 4],
    ['button', 403, 'FORBIDDEN', 5],
    ['scope', 404, 'NOT_FOUND', 7],
  ] as const)('%s 拒绝：原样返回该错误，后续阶段与处理函数都不执行', async (stage, status, code, upTo) => {
    const { app, trace } = fixtureApp({ deny: new Set([stage]) });
    const res = await post(app, '{"name":"x"}');
    expect(res.status).toBe(status);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
    expect(trace).toHaveLength(Array.isArray(upTo) ? upTo.length : upTo);
    expect(trace.some((step) => step.startsWith('handler'))).toBe(false);
  });

  it('缺 If-Match 先于功能权限（现状 revision(c) 在实参里先求值）', async () => {
    const { app, trace } = fixtureApp({ deny: new Set(['operation']) });
    const res = await post(app, '{}', {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('REVISION_REQUIRED');
    expect(trace).toEqual(['revision']);
  });

  it('无权 + 请求体不是对象：仍先报 403（功能权限先于请求体解析，与现状一致）', async () => {
    const { app } = fixtureApp({ deny: new Set(['operation']) });
    expect((await post(app, '[]')).status).toBe(403);
  });

  it('有权 + 请求体不是对象：400，写字段与按钮都不执行', async () => {
    const { app, trace } = fixtureApp();
    expect((await post(app, '[]')).status).toBe(400);
    expect(trace).toEqual(['revision', `operation:${OBJECT}:create`, 'input:body']);
  });

  it('管理员路由：只调用 admin 原语', async () => {
    const { app, trace } = fixtureApp();
    expect((await app.request('/settings')).status).toBe(200);
    expect(trace).toEqual(['admin:other_settings', 'handler']);
  });

  it('HEAD 按 GET 声明执行同样的阶段', async () => {
    const { app, trace } = fixtureApp({ deny: new Set(['admin']) });
    expect((await app.request('/settings', { method: 'HEAD' })).status).toBe(403);
    expect(trace).toEqual(['admin:other_settings']);
  });
});

describe('AC-PRM-FW-01 接管引擎：范围（设计 §2.2 / §2.4）', () => {
  it('列表：引擎不提前解析；处理函数显式 getScope()，同一请求只解析一次', async () => {
    const { app, trace } = fixtureApp();
    expect(await (await app.request('/items')).json()).toEqual({ scope: 1 });
    expect(trace).toEqual([`operation:${OBJECT}:view`, 'handler:before-scope', `scope:${OBJECT}:`, 'handler:scope:1:true']);
  });

  it('本人 AND 对象：本人谓词是 T2（不执行），对象分支照常', async () => {
    const { app, trace } = fixtureApp();
    expect((await app.request('/notices')).status).toBe(200);
    expect(trace).toEqual([`operation:${OBJECT}:view`, 'handler', `scope:${OBJECT}:`]);
  });

  it('点校验 own：先解析范围再调用登记实现，结果放进 access.point', async () => {
    const { app, trace } = fixtureApp();
    const res = await app.request('/items/7');
    expect(await res.json()).toEqual({ point: { id: '7' }, input: { id: '7' } });
    expect(trace).toEqual([
      `operation:${OBJECT}:view`,
      'input:id',
      `button:${OBJECT}#report@detail`,
      `scope:${OBJECT}:`,
      'check:byId:1:own',
      'handler',
    ]);
  });

  it('登记实现里的输入错误原样传播（asOf 非法仍是 400，不被当成拒绝码不符）', async () => {
    const { app } = fixtureApp();
    const res = await app.request('/items/7?asOf=bad');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'VALIDATION_FAILED', message: '查询时点必须为合法日期' } });
  });

  it('非法路径标识：400 来自登记的输入解析器，原样传播', async () => {
    const { app, trace } = fixtureApp();
    expect((await app.request('/items/x')).status).toBe(400);
    expect(trace).toEqual([`operation:${OBJECT}:view`, 'input:id']);
  });

  it('点校验 shared：处理函数调用 inScopedTx，校验在同一事务里先于读取', async () => {
    const { app, trace } = fixtureApp({ reportCallsTx: true });
    const res = await app.request('/items/7/report');
    expect(await res.text()).toBe('csv-row');
    expect(trace.slice(-6)).toEqual([
      `scope:${OBJECT}:`,
      'handler',
      'tx:begin',
      'check:byId:1:shared-tx',
      'handler:in-tx:shared-tx:{"id":"7"}',
      'tx:end',
    ]);
  });

  it('点校验 shared：处理函数未调用 inScopedTx → 500 ROUTE_POLICY_UNCHECKED，不放出任何数据（DEC-363④）', async () => {
    const { app } = fixtureApp({ reportCallsTx: false });
    const res = await app.request('/items/7/report');
    expect(res.status).toBe(500);
    expect(ERROR_STATUS.ROUTE_POLICY_UNCHECKED).toBe(500);
    expect(res.headers.get('content-disposition')).toBeNull();
    const text = await res.text();
    expect(text).not.toContain('secret');
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'ROUTE_POLICY_UNCHECKED' } });
  });

  it('点校验 shared 下范围外：inScopedTx 抛出登记实现的 404，读取不执行', async () => {
    const { app, trace } = fixtureApp({ reportCallsTx: true, deny: new Set(['scope']) });
    expect((await app.request('/items/7/report')).status).toBe(404);
    expect(trace.some((step) => step.startsWith('handler:in-tx'))).toBe(false);
  });
});

describe('AC-PRM-FW-01 接管引擎：列表范围在事务外解析（PGlite 真实事务，设计 §2.2）', () => {
  it('处理函数在业务事务之前 getScope()，范围解析另开的事务能完成', async () => {
    const db = testDb().db;
    const trace: Trace = [];
    const app = new Hono();
    const router = policed(app, defineTable(MODULE, { 'GET /items': viewList }));
    router.get('/items', async (c) => {
      const scope = await accessOf<Ctx, Scope, Tx>(c).getScope();
      const rows = await withTenant(db, TENANT, (tx) => tx.execute(sql`SELECT ${scope.id}::int AS id`));
      return c.json({ rows: Array.isArray(rows) ? rows.length : (rows as { rows: unknown[] }).rows.length });
    });
    const base = fixtureImpl(trace);
    implement(router, MODULE, {
      ...base,
      primitives: {
        ...base.primitives,
        // 与真实授权器相同：范围解析自己开一个租户事务
        scope: async () => withTenant(db, TENANT, async (tx) => (await tx.execute(sql`SELECT 1`)) && { id: 1 }),
      },
      t1: {},
      deferred: { 'fixture.listSql': 'T2' },
    });
    verifyRouteDeclarations(app, { takenOver: [MODULE] });
    const res = await Promise.race([
      app.request('/items'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('列表请求超时（连接等待）')), 3000)),
    ]);
    expect(await res.json()).toEqual({ rows: 1 });
  });
});

describe('AC-PRM-FW-01 接管引擎：启动期检查（ROUTE_POLICY_IMPL_MISSING，DEC-363④）', () => {
  const variant = (patch: Partial<ModuleImplementations<Ctx, Scope, string>>) => (trace: Trace) => ({
    ...fixtureImpl(trace),
    ...patch,
  });

  it.each([
    ['未归类的守卫名', variant({ deferred: { 'fixture.listSql': 'T2', 'fixture.recipient': 'T2' } })],
    ['T1 定位器没有登记实现', variant({ t1: { 'fixture.requester': async () => undefined } })],
    ['输入解析器缺失', variant({ inputs: { 'fixture.id': () => '1' } })],
    ['缺原语（transaction）', (t: Trace) => ({ ...fixtureImpl(t), primitives: { ...fixtureImpl(t).primitives, transaction: undefined } })],
    [
      '同一名称既登记实现又登记延后',
      (t: Trace) => ({ ...fixtureImpl(t), deferred: { ...fixtureImpl(t).deferred, 'fixture.byId': 'T3' as const } }),
    ],
    [
      '按位置不归 T1 的名称（写足迹）登记了实现',
      (t: Trace) => ({ ...fixtureImpl(t), t1: { ...fixtureImpl(t).t1, 'fixture.replay': async () => undefined } }),
    ],
  ])('%s → 启动失败', (_label, impl) => {
    const error = startupFailure(() => fixtureApp({ impl }));
    expect(error.code).toBe('ROUTE_POLICY_IMPL_MISSING');
  });

  it('登记了声明里没有用到的名称 → ROUTE_POLICY_IMPL_UNUSED', () => {
    const impl = (t: Trace) => ({ ...fixtureImpl(t), deferred: { ...fixtureImpl(t).deferred, 'fixture.stale': 'T3' as const } });
    expect(startupFailure(() => fixtureApp({ impl })).code).toBe('ROUTE_POLICY_IMPL_UNUSED');
  });

  it('接管模块没有任何实现登记 → 启动失败', () => {
    const app = new Hono();
    policed(app, defineTable(MODULE, { 'GET /settings': adminPolicy })).get('/settings', (c) => c.json({}));
    expect(startupFailure(() => verifyRouteDeclarations(app, { takenOver: [MODULE] })).code).toBe(
      'ROUTE_POLICY_IMPL_MISSING',
    );
  });

  it.each([
    ['any 组合（推广阶段才支持）', { kind: 'any', of: [adminPolicy, viewList] }],
    ['动态对象选择器', { ...viewList, object: { from: 'param', path: 'kind', map: { a: OBJECT } } }],
    ['可选分支', { ...viewList, optional: { extra: adminPolicy } }],
    ['写路由用 shared 点校验', { ...createPolicy, scope: { ...(viewPoint('shared') as { scope: object }).scope } }],
  ] as [string, RoutePolicy][])('引擎尚不支持：%s → 启动失败', (_label, policy) => {
    const app = new Hono();
    const router = policed(app, defineTable(MODULE, { 'POST /x': policy }));
    router.post('/x', (c) => c.json({}));
    implement(router, MODULE, { primitives: {}, inputs: {}, t1: {}, deferred: {} });
    const error = startupFailure(() => verifyRouteDeclarations(app, { takenOver: [MODULE] }));
    expect(error.code).toBe('ROUTE_POLICY_IMPL_MISSING');
    expect(error.message).toContain('尚不支持');
  });

  it('接管列表里的模块没有任何声明 → 启动失败', () => {
    const app = new Hono();
    policed(app, defineTable(MODULE, { 'GET /settings': adminPolicy })).get('/settings', (c) => c.json({}));
    expect(startupFailure(() => verifyRouteDeclarations(app, { takenOver: ['ghost'] })).code).toBe(
      'ROUTE_POLICY_IMPL_MISSING',
    );
  });
});
