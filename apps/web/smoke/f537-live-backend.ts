import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createTestDb } from '../../../packages/testkit/src/test-db.js';
import {
  failWith500,
  selfTransferWorld,
  transferPath,
  withLedgerFault,
} from '../../../tests/acceptance/support/f537-rollback.js';

export async function startF537Backend() {
  const handle = await createTestDb();
  try {
    const fixture = await selfTransferWorld(handle.db);
    const normal = fixture.api();
    const rollback = fixture.api(withLedgerFault(handle.db, failWith500));
    const serve = async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      const api = req.url === transferPath && req.headers['x-smoke-rollback'] === 'yes' ? rollback : normal;
      const revision = req.headers['if-match'];
      const response = await api.request(req.method!, req.url!, {
        ...fixture.actor,
        ...(typeof revision === 'string' ? { ifMatch: revision.replaceAll('"', '') } : {}),
        idempotencyKey: typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : null,
        body: raw ? (JSON.parse(raw) as unknown) : undefined,
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    };
    const server = createServer((req, res) => {
      void serve(req, res).catch((error: unknown) => {
        console.error(error);
        res.writeHead(500);
        res.end();
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    return {
      manifest: {
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        actor: fixture.actor,
        first: fixture.first,
        second: fixture.second,
      },
      async close() {
        await new Promise<void>((done) => server.close(() => done()));
        await handle.close();
      },
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
