/** FE-05 隔离库真实 HTTP 往返，复用导入验收世界与真实后台执行器。 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createTestDb } from '../../../packages/testkit/src/test-db.js';
import { importWorld } from '../../../tests/acceptance/AC-DM-30-support.js';
import { tenantApi, pinExitGate } from '../../../tests/acceptance/support/tenant-api.js';
import { uniqueSuffix } from '../../../tests/acceptance/support/unique.js';

export async function startImportBackend() {
  pinExitGate('enforce');
  const handle = await createTestDb();
  try {
    const world = await importWorld(handle.db, uniqueSuffix());
    const department = await world.dept('合成导入部门');
    const api = tenantApi(handle.db, { clock: () => new Date('2026-11-05T01:00:00Z') });
    const serve = async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url!, 'http://127.0.0.1');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      if (url.pathname === '/__smoke/idle') {
        await world.settle();
        res.end('{}');
        return;
      }
      const path = `${url.pathname}${url.search}`;
      const options = {
        body: raw ? (JSON.parse(raw) as unknown) : undefined,
        idempotencyKey: String(req.headers['idempotency-key'] ?? ''),
      };
      const response = url.pathname.startsWith('/api/tenant/employment/')
        ? await world.session.request(req.method!, path.replace('/api/tenant/employment', ''), options)
        : await api.request(req.method!, path, { ...options, user: world.session.user.id, tenant: world.tenantId });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    };
    const server = createServer((req, res) => {
      void serve(req, res).catch((error: unknown) => {
        res.writeHead(500);
        res.end(String(error));
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    return {
      manifest: {
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        departmentCode: department.code,
      },
      async close() {
        await world.settle();
        await new Promise<void>((done) => server.close(() => done()));
        await handle.close();
      },
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
