/**
 * F-474-7c 第 2 轮 P2-2：“导出已选”的 500 个对象 ID 走 GET 查询串（设计 §4.2），必须能通过实际 HTTP 入口。
 * 执行真实 server.ts 装配，拿它交给 @hono/node-server 的入口配置，再用真实适配器在临时端口起服务发请求；
 * 只屏蔽启动自检、数据库与身份（同 AC-EV-leave-consumer-server 的做法），不绕过 HTTP 解析层。
 */
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { useTestDb } from '@italent/testkit';
import { expect, it, vi } from 'vitest';
import type { serve as Serve } from '../../apps/api/node_modules/@hono/node-server/dist/index.mjs';
import { GRAPH, graphWorld } from './support/job-graph.js';
import { readXlsx } from './support/xlsx-read.js';

// 该依赖只装在 API 工作区；从根测试文件按裸包名 mock 会变成另一个虚拟模块。
const NODE_SERVER = '../../apps/api/node_modules/@hono/node-server/dist/index.mjs';
type ServeOptions = Parameters<typeof Serve>[0];

const startup = vi.hoisted(() => ({ serve: vi.fn((_options: unknown) => undefined) }));
vi.mock('../../apps/api/node_modules/@hono/node-server/dist/index.mjs', () => ({ serve: startup.serve }));
vi.mock('../../apps/api/src/database.js', () => ({ databaseFromEnv: async () => null, localPgliteDir: vi.fn() }));
vi.mock('../../apps/api/src/identity.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  identityResolverFromEnv: vi.fn(),
}));
vi.mock('../../apps/api/src/modules/survey360/export-runtime.js', () => ({ exportStartupCheck: vi.fn() }));
vi.mock('../../apps/api/src/modules/survey360/credential-config.js', () => ({
  checkCredentialConfigAtStartup: () => ({ kdf: {} }),
}));
vi.mock('../../apps/api/src/modules/survey360/credential-maintenance.js', () => ({
  assertNoKeyRollback: vi.fn(),
  startCredentialMaintenanceScheduler: vi.fn(),
}));
vi.mock('../../apps/api/src/modules/survey360/credentials.js', () => ({ dummyDigest: vi.fn() }));

const testDb = useTestDb();

it('AC-F474-JG-09 导出已选 500 个对象 ID：经 server.ts 的实际入口不报 431，进入导出处理并给出文件', async () => {
  await import('../../apps/api/src/server.js');
  expect(startup.serve).toHaveBeenCalledTimes(1);
  const entry = startup.serve.mock.calls[0]![0] as ServeOptions;
  const { serve } = await vi.importActual<{ serve: typeof Serve }>(NODE_SERVER);
  const w = await graphWorld(testDb().db);
  let reached = 0;
  // 处理函数：记下进入次数，按原路径转给带合成身份的租户应用（身份头由测试夹具签发）
  const server = serve({
    ...entry,
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request: Request) => {
      reached += 1;
      const url = new URL(request.url);
      return w.api.request(request.method, `${url.pathname}${url.search}`, w.as);
    },
  });
  try {
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    // 与前端同一编码（URLSearchParams，逗号写成 %2C）：约 19.5KB，超过 Node 默认 16KB 请求头上限
    const ids = Array.from({ length: 500 }, () => crypto.randomUUID()).join(',');
    const query = new URLSearchParams({ ids }).toString();
    expect(query.length).toBeGreaterThan(16 * 1024);
    const response = await fetch(`http://127.0.0.1:${port}${GRAPH}/issues/export?${query}`);
    expect(response.status).not.toBe(431);
    expect(reached).toBe(1);
    expect(response.status).toBe(200);
    // 随机 ID 都不在待确认记录里：只有表头一行
    const book = readXlsx(Buffer.from(await response.arrayBuffer()));
    expect(new Set([...book.cells.keys()].map((ref) => ref.slice(1)))).toEqual(new Set(['1']));
  } finally {
    await new Promise((done) => server.close(done));
  }
});
