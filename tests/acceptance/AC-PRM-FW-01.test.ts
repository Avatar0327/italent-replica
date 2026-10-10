/**
 * AC-PRM-FW-01（F-039 PR-A，docs/08_设计/F-039_权限框架强制_设计.md §2.3；DEC-300 / DEC-303）：
 * 路由声明的注册校验——缺失即失败。反例按 DEC-300 的三类致命项分组：身份不匹配、缺失声明、初始化不可信；
 * 校验按**注册实例**（包装函数身份）绑定，不只看 method / path。正例核对全部 560 个端点都已登记、
 * 中间件按最终路径登记、HEAD 走 GET 声明。前四组用内存 Hono + 框架；最后一组用 createApp 真实装配。
 */
import {
  AppError,
  type Context,
  createApp,
  defineTable,
  ERROR_STATUS,
  Hono,
  mergeTables,
  mount,
  type Next,
  policed,
  policedSub,
  type PolicyTable,
  rawRouter,
  type RoutePolicy,
  RoutePolicyError,
  routeManifest,
  useMiddleware,
  verifyRouteDeclarations,
} from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { PROBE_POLICIES, probeRoutes } from './support/probe-routes.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

const ok = (c: Context) => c.json({ ok: true });
const okToo = (c: Context) => c.json({ ok: 2 });
const passThrough = async (_c: Context, next: Next) => next();
const member: RoutePolicy = { kind: 'member', reason: '测试夹具', fields: { mode: 'none', reason: '测试夹具' } };

function table(module: string, ...keys: readonly string[]): PolicyTable {
  return defineTable(module, Object.fromEntries(keys.map((key) => [key, member])));
}

/** 断言抛出的是 RoutePolicyError 并返回它（校验码在各用例里精确比对）。 */
function failure(run: () => unknown): RoutePolicyError {
  try {
    run();
  } catch (error) {
    if (error instanceof RoutePolicyError) return error;
    throw error;
  }
  throw new Error('期望抛出 RoutePolicyError，实际没有抛错');
}

type RawHandler = (c: Context, next: Next) => Promise<Response>;
function lastHandler(app: Hono): RawHandler {
  const entry = rawRouter(app).routes.at(-1);
  if (!entry) throw new Error('路由表为空');
  return entry.handler as RawHandler;
}

describe('AC-PRM-FW-01 身份不匹配（始终失败）', () => {
  it('已声明的包装被再注册到别的路径 → ROUTE_ALIAS', () => {
    const app = new Hono();
    policed(app, table('t', 'GET /a')).get('/a', ok);
    rawRouter(app).post('/alias', lastHandler(app));
    expect(failure(() => verifyRouteDeclarations(app)).code).toBe('ROUTE_ALIAS');
  });

  it('同一包装在同一路径注册两次 → ROUTE_DUPLICATE_REGISTRATION', () => {
    const app = new Hono();
    policed(app, table('t', 'GET /a')).get('/a', ok);
    rawRouter(app).get('/a', lastHandler(app));
    expect(failure(() => verifyRouteDeclarations(app)).code).toBe('ROUTE_DUPLICATE_REGISTRATION');
  });

  it('两条声明落到同一最终路径（根 /api/x 与子应用 /x 挂到 /api）→ ROUTE_DUPLICATE_PATH', () => {
    const app = new Hono();
    const root = policed(app, table('root', 'GET /api/x'));
    root.get('/api/x', ok);
    const sub = policedSub(root, table('sub', 'GET /x'), () => new Hono());
    sub.get('/x', okToo);
    root.route('/api', sub);
    expect(failure(() => verifyRouteDeclarations(app)).code).toBe('ROUTE_DUPLICATE_PATH');
  });

  it('登记在 /a/* 的中间件又被注册到 /b/* → ROUTE_MIDDLEWARE_MISMATCH', () => {
    const app = new Hono();
    const root = policed(app, table('t', 'GET /a/x'));
    useMiddleware(root, '/a/*', passThrough, 'pass');
    rawRouter(app).use('/b/*', passThrough);
    root.get('/a/x', ok);
    expect(failure(() => verifyRouteDeclarations(app)).code).toBe('ROUTE_MIDDLEWARE_MISMATCH');
  });

  it('运行时自检：绕过校验的别名请求 → 500 ROUTE_POLICY_MISMATCH，处理函数不被调用', async () => {
    const app = new Hono();
    app.onError((error, c) => c.json({ code: error instanceof AppError ? error.code : 'OTHER' }, 500));
    let called = 0;
    policed(app, table('t', 'GET /a')).get('/a', (c) => {
      called += 1;
      return c.json({ ok: true });
    });
    rawRouter(app).get('/alias', lastHandler(app)); // 故意不跑 verifyRouteDeclarations，模拟绕过
    const res = await app.request('/alias');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ code: 'ROUTE_POLICY_MISMATCH' });
    expect(called).toBe(0);
    expect(ERROR_STATUS.ROUTE_POLICY_MISMATCH).toBe(500);
    expect((await app.request('/a')).status).toBe(200);
  });
});

describe('AC-PRM-FW-01 缺失声明（始终失败）', () => {
  it('经代理注册但登记表没有 → 注册当场 ROUTE_UNDECLARED', () => {
    const root = policed(new Hono(), table('t', 'GET /a'));
    expect(failure(() => root.get('/nope', ok)).code).toBe('ROUTE_UNDECLARED');
  });

  it('绕过代理在原生路由器注册，即使登记表里有同样的 METHOD path → ROUTE_UNDECLARED（按注册实例校验）', () => {
    const app = new Hono();
    policed(app, table('t', 'GET /a'));
    rawRouter(app).get('/a', ok);
    expect(failure(() => verifyRouteDeclarations(app)).code).toBe('ROUTE_UNDECLARED');
  });

  it('同一路径再注册一个不同的处理函数（第 6 轮绕过）→ ROUTE_UNDECLARED', () => {
    const app = new Hono();
    policed(app, table('t', 'GET /a')).get('/a', ok);
    rawRouter(app).get('/a', okToo);
    expect(failure(() => verifyRouteDeclarations(app)).code).toBe('ROUTE_UNDECLARED');
  });

  it('.all()：经代理 → ROUTE_POLICY_ALL_FORBIDDEN；原生 → ROUTE_MIDDLEWARE_UNREGISTERED', () => {
    const app = new Hono();
    const root = policed(app, table('t', 'GET /a'));
    expect(failure(() => root.all('/x', ok)).code).toBe('ROUTE_POLICY_ALL_FORBIDDEN');
    root.get('/a', ok);
    rawRouter(app).all('/x', ok);
    expect(failure(() => verifyRouteDeclarations(app)).code).toBe('ROUTE_MIDDLEWARE_UNREGISTERED');
  });

  it('多层 "*" 中间件：最内层子应用原生 use("*") 未经 useMiddleware → ROUTE_MIDDLEWARE_UNREGISTERED', () => {
    const app = new Hono();
    const root = policed(app, table('root'));
    const sub = policedSub(root, table('sub'), () => new Hono());
    const inner = policedSub(sub, table('inner', 'GET /leaf'), () => new Hono());
    rawRouter(inner).use('*', passThrough);
    inner.get('/leaf', ok);
    sub.route('/sub', inner);
    root.route('/api', sub);
    expect(failure(() => verifyRouteDeclarations(app)).code).toBe('ROUTE_MIDDLEWARE_UNREGISTERED');
  });

  it('多方法 .on(["GET","POST"]) 只声明 GET → POST 注册当场 ROUTE_UNDECLARED', () => {
    const root = policed(new Hono(), table('t', 'GET /x'));
    expect(failure(() => root.on(['GET', 'POST'], '/x', ok)).code).toBe('ROUTE_UNDECLARED');
  });

  it('HEAD 不能单独声明：登记表拒绝 "HEAD /x"；.on("HEAD") 注册 → ROUTE_UNDECLARED', () => {
    expect(() => defineTable('t', { 'HEAD /x': member })).toThrow(/METHOD/);
    const root = policed(new Hono(), table('t', 'GET /x'));
    expect(failure(() => root.on('HEAD', '/x', ok)).code).toBe('ROUTE_UNDECLARED');
  });

  it('两层 onError 的包装层不掩盖未声明路由 → ROUTE_UNDECLARED', () => {
    const app = new Hono();
    const root = policed(app, table('root'));
    const mid = policedSub(root, table('mid'), () => new Hono());
    mid.onError((_error, c) => c.text('mid', 500));
    const inner = policedSub(mid, table('inner', 'GET /ok'), () => new Hono());
    inner.onError((_error, c) => c.text('inner', 500));
    inner.get('/ok', ok);
    rawRouter(inner).get('/raw', okToo);
    mid.route('/mid', inner);
    root.route('/api', mid);
    const error = failure(() => verifyRouteDeclarations(app));
    expect(error.code).toBe('ROUTE_UNDECLARED');
    expect(error.message).toContain('GET /api/mid/raw');
  });

  it('一条路由带多个处理函数（内联中间件）→ ROUTE_POLICY_INLINE_HANDLERS', () => {
    const root = policed(new Hono(), table('t', 'GET /a'));
    expect(failure(() => root.get('/a', passThrough, ok)).code).toBe('ROUTE_POLICY_INLINE_HANDLERS');
  });

  it('校验后封闭：原生晚注册抛错且 GET /late 404；经代理晚注册因登记表没有键而 ROUTE_UNDECLARED', async () => {
    const app = new Hono();
    const root = policed(app, table('t', 'GET /a'));
    root.get('/a', ok);
    verifyRouteDeclarations(app);
    expect(() => rawRouter(app).get('/late', ok)).toThrow();
    expect(failure(() => root.get('/late', ok)).code).toBe('ROUTE_UNDECLARED');
    expect((await app.request('/late')).status).toBe(404);
    expect((await app.request('/a')).status).toBe(200);
  });
});

describe('AC-PRM-FW-01 初始化不可信（始终失败）', () => {
  it('登记表有键但没有对应注册 → ROUTE_DECLARATION_UNUSED', () => {
    const app = new Hono();
    policed(app, table('t', 'GET /a', 'GET /never')).get('/a', ok);
    expect(failure(() => verifyRouteDeclarations(app)).code).toBe('ROUTE_DECLARATION_UNUSED');
  });

  it('两个子表都声明 GET /x、只有一个注册 → 另一个子表的键 ROUTE_DECLARATION_UNUSED（已用键按登记表绑定）', () => {
    const app2 = new Hono();
    const root2 = policed(app2, table('root'));
    const one = policedSub(root2, table('one', 'GET /x'), () => new Hono());
    const two = policedSub(root2, table('two', 'GET /x', 'GET /y'), () => new Hono());
    one.get('/x', ok);
    two.get('/y', ok);
    root2.route('/a', one);
    root2.route('/b', two);
    const unused = failure(() => verifyRouteDeclarations(app2));
    expect(unused.code).toBe('ROUTE_DECLARATION_UNUSED');
    expect(unused.message).toContain('two');
  });

  it('子应用已声明但没有挂载 → ROUTE_DECLARATION_UNMOUNTED', () => {
    const app = new Hono();
    const root = policed(app, table('root'));
    policedSub(root, table('sub', 'GET /x'), () => new Hono()).get('/x', ok);
    expect(failure(() => verifyRouteDeclarations(app)).code).toBe('ROUTE_DECLARATION_UNMOUNTED');
  });

  it('同一路由器同键声明两次 → ROUTE_DUPLICATE_DECLARATION', () => {
    const root = policed(new Hono(), table('t', 'GET /a'));
    root.get('/a', ok);
    expect(failure(() => root.get('/a', okToo)).code).toBe('ROUTE_DUPLICATE_DECLARATION');
  });

  it('登记表键格式非法、合并表键重叠 → 定义时抛错', () => {
    expect(() => defineTable('t', { 'get /a': member })).toThrow(/METHOD/);
    expect(() => defineTable('t', { 'GET a': member })).toThrow(/METHOD/);
    expect(() => mergeTables('m', [table('a', 'GET /a'), table('b', 'GET /a')])).toThrow(/GET \/a/);
  });
});

describe('AC-PRM-FW-01 正例', () => {
  it('两层 onError：包装 depth=2 还原，verify 通过，请求与子应用错误处理照常', async () => {
    const app = new Hono();
    const root = policed(app, table('root'));
    const mid = policedSub(root, table('mid'), () => new Hono());
    mid.onError((_error, c) => c.text('mid', 500));
    const inner = policedSub(mid, table('inner', 'GET /ok', 'GET /boom'), () => new Hono());
    inner.onError((_error, c) => c.text('inner', 418));
    inner.get('/ok', ok);
    inner.get('/boom', () => {
      throw new Error('boom');
    });
    mid.route('/mid', inner);
    root.route('/api', mid);
    const manifest = verifyRouteDeclarations(app);
    expect(manifest.declared.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/mid/ok', 'GET /api/mid/boom']);
    expect((await app.request('/api/mid/ok')).status).toBe(200);
    expect((await app.request('/api/mid/boom')).status).toBe(418);
  });

  it('中间件按最终路径登记：顶层 "*" → /*；一层挂载 → /api/*；两层 → /api/sub/*', () => {
    const app = new Hono();
    const root = policed(app, table('root'));
    useMiddleware(root, '*', passThrough, 'mw-root');
    const sub = policedSub(root, table('sub'), () => new Hono());
    const subMiddleware = async (_c: Context, next: Next) => next();
    sub.use('*', subMiddleware);
    const inner = policedSub(sub, table('inner', 'GET /leaf'), () => new Hono());
    useMiddleware(inner, '*', async (_c, next) => next(), 'mw-inner');
    inner.get('/leaf', ok);
    sub.route('/sub', inner);
    mount(root, '/api', sub);
    const manifest = verifyRouteDeclarations(app);
    expect(manifest.middleware).toEqual([
      { label: 'mw-root', paths: ['/*'] },
      { label: 'subMiddleware', paths: ['/api/*'] },
      { label: 'mw-inner', paths: ['/api/sub/*'] },
    ]);
    expect(manifest.declared).toEqual([
      { key: 'GET /leaf', method: 'GET', path: '/api/sub/leaf', module: 'inner', policy: member },
    ]);
  });

  it('根与子应用复用同一个中间件函数、各自登记 "*"：两处最终路径都保留，不误报 MISMATCH', () => {
    const app = new Hono();
    const root = policed(app, table('root'));
    useMiddleware(root, '*', passThrough, 'shared');
    const sub = policedSub(root, table('sub', 'GET /leaf'), () => new Hono());
    useMiddleware(sub, '*', passThrough, 'shared');
    sub.get('/leaf', ok);
    mount(root, '/api', sub);
    const manifest = verifyRouteDeclarations(app);
    expect(manifest.middleware).toEqual([{ label: 'shared', paths: ['/*', '/api/*'] }]);
  });

  it('HEAD 命中 GET 声明：200、空体；运行时自检按有效方法 GET 核对', async () => {
    const app = new Hono();
    policed(app, table('t', 'GET /a')).get('/a', ok);
    verifyRouteDeclarations(app);
    const head = await app.request('/a', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(await (await app.request('/a')).json()).toEqual({ ok: true });
  });

  it('.on(["GET","POST"]) 两方法都声明 → 两条独立声明，各自可请求', async () => {
    const app = new Hono();
    policed(app, table('t', 'GET /x', 'POST /x')).on(['GET', 'POST'], '/x', ok);
    const manifest = verifyRouteDeclarations(app);
    expect(manifest.declared.map((r) => r.key)).toEqual(['GET /x', 'POST /x']);
    expect((await app.request('/x')).status).toBe(200);
    expect((await app.request('/x', { method: 'POST' })).status).toBe(200);
  });
});

describe('AC-PRM-FW-01 createApp 真实装配', () => {
  /**
   * 合并 main（DEC-333）后的运行时端点按登记表统计：附录 A 227 + DEC-303 补的 employment-preview + 平台回补 1 +
   * 审批 reject-previous / jump 2 + 人才标准 40 + 360 管理端 40 + 360 链接 8 + IDP 56 = 375；
   * 合并 #138（F-058 账号头像）后 + 头像 5 + 360 链接头像 1 = 381；合并 #146（F-066 IDP 转交）后 + 1 = 382；
   * 合并 #144（R3-T04 准备度字典）后 + 5 = 387；R3-T02 PR-A 任职资格配置 + 51 = 438；R3-T03 PR-B（360 管理端
   * + 27、待办作答 + 5、报告收件人链接 + 2）后 = 472；
   * DEC-361 种子回补命令 + 1 = 473；R3-T04 PR-B1（设置 2 + 分类 / 角色 / 字段目录各 5）+ 17 = 490；R3-T05 A1（继任记录读侧）+ 3 = 493；
   * F-060 报表 PNG / 报告 PDF（管理端 + 2、收件人链接 + 1）后 = 496；
   * R3-T04 PR-B4（九宫格 5 + 规则组 3）+ 8 = 504；
   * R3-T04 PR-B5（计算规则 5）+ 5 = 509；R3-T02 PR-B B1a 活动类型 + 5 = 514；B1b 活动周期 + 5、通用评分项 + 5 = 524；
   * B3 评审组 + 4（无删除，DEC-393⑤）、成员候选 + 1 = 529；B4 评价表 + 5 = 534；
   * R3-T04 PR-B2a（评价规则 / 模块等级各 5）+ 10 = 544；R3-T04 PR-B2b（字段映射 5）+ 5 = 549；
   * R3-T05 A2（继任记录写侧 4 + 候选 1）+ 5 = 554；
   * F-082 F082-5（改绑平台命令，总开关默认打开）+ 1 = 555；
   * R3-T02 B5 评定活动 + 5 = 560（PR 描述以此为准）。
   */
  const EXPECTED_BY_MODULE: Readonly<Record<string, number>> = {
    root: 1,
    platform: 9,
    'tenant-settings': 3,
    permission: 43,
    job: 14,
    establishment: 16,
    personnel: 18,
    contracts: 23,
    'self-service': 7,
    org: 14,
    employment: 46,
    approval: 34,
    audit: 4,
    talent: 40,
    survey360: 74,
    'survey360-link': 9,
    'survey360-report-link': 3,
    idp: 57,
    avatar: 5,
    'talent-review': 50,
    'talent-review-platform': 1,
    qualification: 51,
    evaluation: 30,
    succession: 8,
  };

  it('未声明的夹具路由 → createApp 抛 ROUTE_UNDECLARED，应用无法启动', () => {
    const error = failure(() => createApp({ db: testDb().db, tenantRoutes: [probeRoutes] }));
    expect(error.code).toBe('ROUTE_UNDECLARED');
    expect(error.message).toContain('/api/tenant/probes');
  });

  it('夹具路由带登记表 → 启动成功，清单包含它', () => {
    const app = createApp({ db: testDb().db, tenantRoutes: [probeRoutes], routePolicies: [PROBE_POLICIES] });
    const keys = routeManifest(app).declared.map((r) => `${r.method} ${r.path}`);
    expect(keys).toContain('GET /api/tenant/probes');
    expect(keys).toContain('DELETE /api/tenant/probes/:id');
  });

  it('全部 560 个端点已声明，按模块统计一致', () => {
    const manifest = routeManifest(createApp({ db: testDb().db }));
    const byModule: Record<string, number> = {};
    for (const route of manifest.declared) byModule[route.module] = (byModule[route.module] ?? 0) + 1;
    expect(byModule).toEqual(EXPECTED_BY_MODULE);
    expect(manifest.declared).toHaveLength(560);
    expect(manifest.declared.map((r) => `${r.method} ${r.path}`)).toContain(
      'POST /api/tenant/org/organizations/:id/employment-preview',
    );
    const fullPaths = manifest.declared.map((r) => `${r.method} ${r.path}`);
    expect(new Set(fullPaths).size).toBe(fullPaths.length);
  });

  it('7 条中间件按最终路径登记（根 3、租户 2、平台 2）', () => {
    const manifest = routeManifest(createApp({ db: testDb().db }));
    expect(manifest.middleware.map((m) => m.paths)).toEqual([
      ['/*'],
      ['/*'],
      ['/*'],
      ['/api/tenant/*'],
      ['/api/tenant/*'],
      ['/api/platform/*'],
      ['/api/platform/*'],
    ]);
  });

  it('HEAD 与 GET 状态一致：租户接口匿名都 401；/healthz 都 200 且 HEAD 空体', async () => {
    const api = tenantApi(testDb().db);
    expect((await api.request('HEAD', '/api/tenant/org/organizations')).status).toBe(401);
    expect((await api.request('GET', '/api/tenant/org/organizations')).status).toBe(401);
    const head = await api.request('HEAD', '/healthz');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect((await api.request('GET', '/healthz')).status).toBe(200);
  });
});
