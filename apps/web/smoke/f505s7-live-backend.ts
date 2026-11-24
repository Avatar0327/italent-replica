import { createServer, type IncomingMessage } from 'node:http';
import { createTestDb } from '../../../packages/testkit/src/test-db.js';
import { s7World } from '../../../tests/acceptance/AC-ESIGN-F505-S7-support.js';

async function forward(w: Awaited<ReturnType<typeof s7World>>, req: IncomingMessage, path: string) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString();
  const match = req.headers['if-match'];
  const key = req.headers['idempotency-key'];
  return w.call(req.method!, path, {
    user: req.headers['x-f505-actor'] === 'employee' ? w.employee : w.initiator,
    ...(typeof match === 'string' ? { ifMatch: match.replaceAll('"', '') } : {}),
    ...(typeof key === 'string' ? { idempotencyKey: key } : {}),
    ...(body ? { body: JSON.parse(body) } : {}),
  });
}

export async function startSourceSigningBackend() {
  const db = await createTestDb();
  try {
    const worlds = { offer: await s7World(db.db, 'offer'), entry: await s7World(db.db, 'entry') };
    const server = createServer(async (req, res) => {
      try {
        const match = /^\/(offer|entry)(\/api\/tenant\/.*)$/.exec(req.url ?? '');
        if (!match) {
          res.writeHead(404).end();
          return;
        }
        const world = match[1] === 'offer' ? worlds.offer : worlds.entry;
        const result = await forward(world, req, match[2]!);
        res.writeHead(result.status, Object.fromEntries(result.headers)).end(Buffer.from(await result.arrayBuffer()));
      } catch (error) {
        console.error(error);
        res.writeHead(500).end();
      }
    });
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('签署冒烟后端未监听');
    const manifest = (w: (typeof worlds)['offer']) => ({
      id: w.id,
      name: w.name,
      tenantId: w.tenantId,
      initiator: w.initiator,
      employee: w.employee,
      template: { id: w.template.id, name: w.template.name },
      sourcePath: w.sourcePath,
    });
    return {
      manifest: {
        url: `http://127.0.0.1:${address.port}`,
        offer: manifest(worlds.offer),
        entry: manifest(worlds.entry),
      },
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
