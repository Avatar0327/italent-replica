/**
 * F-326 F2a 浏览器集成专用：全新隔离数据库、合成数据、真实矩阵路由（Hono + 授权引擎）；不连接开发库。
 * 预置：合成 HR 持 matrix_admin 身份；一条被已发布流程引用的启用矩阵、一条无引用的草稿矩阵；
 * 矩阵与流程都经真实 HTTP 入口创建（同 S4 夹具）。
 * 请求身份由冒烟转发头 x-f2a-user 指定：合成 HR（矩阵管理员）或合成员工（无企业管理员身份）；其余一律拒绝。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { permissionAdmins, withTenant } from '@italent/db';
import { createTestDb } from '../../../packages/testkit/src/test-db.js';
import {
  MATRICES,
  counter,
  matrix,
  matrixSource,
  s4World,
  type S4World,
} from '../../../tests/acceptance/AC-APV-F326-S4-support.js';

// 只转发业务头；浏览器的来源类头不进测试应用，身份按 x-f2a-user 在夹具用户中选取后重新签名
const USER_HEADER = 'x-f2a-user';
const SKIPPED = new Set([
  'host',
  'connection',
  'content-length',
  'content-type',
  'cookie',
  'origin',
  'referer',
  USER_HEADER,
]);
const forwarded = (key: string) => !SKIPPED.has(key) && !key.startsWith('sec-');

async function bodyOf(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as unknown) : undefined;
}

/** 真实企业管理员身份：快照的企业设置菜单由 permission_admins 推出（matrix_admin 持有「流程矩阵」）。 */
export const grantMatrixAdmin = (w: S4World) =>
  withTenant(w.db, w.tenant.id, (tx) =>
    tx.insert(permissionAdmins).values({ tenantId: w.tenant.id, userId: w.hr.id, role: 'matrix_admin' }),
  );

async function seed(w: S4World) {
  await grantMatrixAdmin(w);
  const used = await matrix(w, { rows: [{ cond: [], role: [w.head.userId] }] });
  const renamed = await w.json<{ code: string; revision: number }>(
    await w.request(w.hr.id, 'PATCH', `${MATRICES}/${used.id}`, {
      body: { name: '合成被引用矩阵', revision: used.revision },
    }),
  );
  const process = await w.publishedProcess({
    approvalType: 'personnel_change',
    isFallback: true,
    conditions: { items: [] },
    nodes: [counter([matrixSource(used, used.roleId)], { key: 'n1', name: '合成矩阵节点' })],
  });
  const idle = await w.json<{ id: string; code: string }>(
    await w.request(w.hr.id, 'POST', MATRICES, { body: { code: 'F2A_IDLE', name: '合成空闲矩阵' } }),
    201,
  );
  return { used: { id: used.id, code: renamed.code }, idle, process: process.code };
}

function handler(w: S4World) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    const headers = Object.fromEntries(
      Object.entries(req.headers).flatMap(([key, value]) =>
        forwarded(key) && typeof value === 'string' ? [[key, value]] : [],
      ),
    );
    const body = await bodyOf(req);
    const user = req.headers[USER_HEADER];
    if (user !== w.hr.id && user !== w.subject.userId) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('F2a test backend: unknown synthetic user');
    }
    const response = await w.request(user, req.method!, `${url.pathname}${url.search}`, {
      headers,
      body,
      idempotencyKey: null,
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}

/** F2b 复用本后端，换自己的预置（seedWith）；返回值并入 manifest。 */
export async function startMatrixBackend(seedWith: (w: S4World) => Promise<object> = seed, label = 'f2a-browser') {
  const handle = await createTestDb();
  try {
    const w = await s4World(handle.db, label);
    const seeded = await seedWith(w);
    const serve = handler(w);
    const server = createServer((req, res) => {
      serve(req, res).catch((error: unknown) => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`F2a test backend failed: ${String(error)}`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      manifest: {
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        tenant: w.tenant.id,
        user: w.hr.id,
        outsider: w.subject.userId,
        ...seeded,
      },
      async close() {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await handle.close();
      },
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
