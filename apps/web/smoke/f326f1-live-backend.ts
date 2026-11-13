/**
 * F-326 F1 浏览器集成专用：全新隔离数据库、合成数据、真实审批路由与真实权限快照；不连接开发库。
 * 复用 S4 验收夹具：HR 是租户管理员（持有「流程矩阵」菜单），near 是普通成员（无菜单）。
 * 种子：一个启用的公共人员变量，被一个兜底流程草稿的会签节点引用（停用前确认要看到这条引用）。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  s4World,
  saveNodes,
  transferNodes,
  variable,
  varSource,
  type S4World,
} from '../../../tests/acceptance/AC-APV-F326-S4-support.js';
import { createTestDb } from '../../../packages/testkit/src/test-db.js';

// 只转发业务头；浏览器的来源类头不进测试应用，身份由 x-smoke-user 重新签名
const SKIPPED = new Set(['host', 'connection', 'content-length', 'content-type', 'cookie', 'origin', 'referer']);
const forwarded = (key: string) => !SKIPPED.has(key) && !key.startsWith('sec-') && key !== 'x-smoke-user';

async function bodyOf(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as unknown) : undefined;
}

async function seed(db: Parameters<typeof s4World>[0]) {
  const w = await s4World(db, 'F1');
  const referenced = await variable(w, { codeSuffix: 'SmokeRef', name: '合成被引用变量' });
  const saved = await saveNodes(w, transferNodes([varSource('public_variable', referenced.id)]));
  if (saved.status !== 201) throw new Error(`process save failed ${saved.status}: ${await saved.text()}`);
  return { w, referenced };
}

function handler(w: S4World) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    const body = await bodyOf(req);
    const headers = Object.fromEntries(
      Object.entries(req.headers).flatMap(([key, value]) =>
        forwarded(key) && typeof value === 'string' ? [[key, value]] : [],
      ),
    );
    const user = String(req.headers['x-smoke-user'] ?? '');
    const response = await w.request(user, req.method!, `${url.pathname}${url.search}`, {
      headers,
      body,
      idempotencyKey: null,
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}

export async function startVariablesBackend() {
  const handle = await createTestDb();
  try {
    const { w, referenced } = await seed(handle.db);
    const serve = handler(w);
    const server = createServer((req, res) => {
      serve(req, res).catch((error: unknown) => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`F326F1 test backend failed: ${String(error)}`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      manifest: {
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        tenant: w.tenant.id,
        admin: w.hr.id,
        member: w.near.userId,
        referenced: { id: referenced.id, code: referenced.code },
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
