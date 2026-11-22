import { createServer } from 'node:http';
import { createTestDb } from '../../../packages/testkit/src/test-db.js';
import { offerSigningWorld } from '../../../tests/acceptance/AC-ESIGN-F505-S4-support.js';

export async function startOfferSignBackend() {
  const db = await createTestDb();
  try {
    const w = await offerSigningWorld(db.db, 'S6_SMOKE');
    const name = 'ZZ_F505_冒烟Offer';
    const sourceId = await w.offer({ name });
    const template = await w.template();
    const call = w.access();
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks).toString();
        const match = req.headers['if-match'];
        const key = req.headers['idempotency-key'];
        const result = await call(req.method!, req.url!, {
          ...(match ? { ifMatch: Number(match) } : {}),
          ...(typeof key === 'string' ? { key } : {}),
          ...(body ? { body: JSON.parse(body) } : {}),
        });
        const headers = Object.fromEntries(result.headers);
        res.writeHead(result.status, headers).end(Buffer.from(await result.arrayBuffer()));
      } catch (error) {
        console.error(error);
        res.writeHead(500).end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject).listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('冒烟后端未监听');
    return {
      manifest: { url: `http://127.0.0.1:${address.port}`, name, sourceId, template },
      async close() {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        await db.close();
      },
    };
  } catch (error) {
    await db.close();
    throw error;
  }
}
