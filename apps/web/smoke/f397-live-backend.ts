/** 隔离数据库 + F-076 合成凭据；业务请求直达真实 Hono 门户，不伪造作答回执。 */
import { createServer } from 'node:http';
import { createTestDb } from '../../../packages/testkit/src/test-db.js';
import { issuedScene, minutes, wrongPassword } from '../../../tests/acceptance/AC-360-F076-portal-support.js';
import { resetCredentialConfig } from '../../../tests/acceptance/AC-360-F076-support.js';

export async function startPortalBackend() {
  const db = await createTestDb();
  try {
    const { w, s, creds } = await issuedScene(db.db, 'F397');
    const cred = creds.get(s.person.P1.id)!;
    w.setNow(new Date().toISOString());
    const started = Date.now();
    const server = createServer((req, res) => {
      void (async () => {
        if (req.url === '/__smoke/expire') {
          w.setNow(new Date(started + 8 * 3_600_000 + 1000).toISOString());
          res.writeHead(204).end();
          return;
        }
        if (req.url === '/__smoke/reset-clock') {
          w.setNow(new Date().toISOString());
          res.writeHead(204).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const headers = new Headers();
        for (const key of ['content-type', 'x-tenant-id', 'x-survey360-session', 'idempotency-key', 'if-match']) {
          const value = req.headers[key];
          if (typeof value === 'string') headers.set(key, value);
        }
        const response = await w.api.app.request(
          req.url!,
          {
            method: req.method!,
            headers,
            ...(['GET', 'HEAD'].includes(req.method!) ? {} : { body: Buffer.concat(chunks).toString() }),
          },
          { incoming: { socket: { remoteAddress: '198.51.100.7' } } },
        );
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      })().catch(() => {
        res.writeHead(500).end('合成后端请求失败');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      // 仅通过父子进程 IPC 传递合成凭据，不写日志或清单文件。
      manifest: {
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        tenantId: w.tenantId,
        serial: cred.serial,
        password: cred.password,
        wrong: wrongPassword(cred),
      },
      async close() {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        w.setNow(minutes(0));
        resetCredentialConfig();
        await db.close();
      },
    };
  } catch (error) {
    await db.close();
    throw error;
  }
}
