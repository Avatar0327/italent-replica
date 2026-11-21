import { createServer } from 'node:http';
import { createTestDb } from '../../../packages/testkit/src/test-db.js';
import { retirementCancelWorld } from '../../../tests/acceptance/AC-RT-cancel-support.js';
import { pinExitGate } from '../../../tests/acceptance/support/tenant-api.js';

export async function startRetirementBackend() {
  pinExitGate('enforce');
  const db = await createTestDb();
  try {
    const world = await retirementCancelWorld(db.db, 'fe-r2c3c', '2026-10-06', { capacity: false });
    const { tenant, user } = world.session;
    const simultaneous = await world.newcomer('合成同时返聘员工');
    await world.setExpectedRetirement('2026-10-26', simultaneous.id);
    const applying = await world.newcomer('合成提前返聘员工');
    await world.submittedRetire('2026-10-15', applying.id);
    const editable = await world.newcomer('合成编辑退休员工');
    await world.directRetire('2026-10-25', undefined, editable.id);
    const cancelled = await world.newcomer('合成已撤销退休员工');
    const retired = await world.directRetire('2026-10-25', undefined, cancelled.id);
    await world.retireCancelled(retired.id);
    const handover = await world.session.employee('合成交接员工');

    const server = createServer((req, res) => {
      void (async () => {
        const body: Buffer[] = [];
        for await (const chunk of req) body.push(chunk as Buffer);
        const requestBody = Buffer.concat(body).toString();
        const path = req.url!;
        const { origin, 'if-match': revision, 'idempotency-key': key } = req.headers;
        const options = {
          ...(requestBody ? { body: JSON.parse(requestBody) as unknown } : {}),
          ...(revision ? { ifMatch: revision.replaceAll('"', '') } : {}),
          headers: origin ? { origin } : {},
          idempotencyKey: typeof key === 'string' ? key : null,
        };
        const root = '/api/tenant/employment';
        const response = path.startsWith(`${root}/`)
          ? await world.session.request(req.method!, path.slice(root.length), options)
          : await world.api.request(req.method!, path, { ...options, tenant: tenant.id, user: user.id });
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      })().catch((error: unknown) => {
        console.error(error);
        res.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      manifest: {
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        tenantId: tenant.id,
        userId: user.id,
        simultaneous: simultaneous.id,
        applying: applying.id,
        handover: handover.id,
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
