import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { installMissingSeeds } from '../../../apps/api/src/seeds/index.js';
import { createTestDb } from '../../../packages/testkit/src/test-db.js';
import {
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  setObjectPermission,
} from '../../../tests/acceptance/AC-PRM-support.js';
import { cmd, tenantApi } from '../../../tests/acceptance/support/tenant-api.js';

const clock = () => new Date('2026-11-20T12:00:00Z');

async function json(response: Response) {
  if (!response.ok) throw new Error(`退休设置夹具失败 ${response.status} ${await response.text()}`);
  return response.json();
}

async function seed(db: Awaited<ReturnType<typeof createTestDb>>['db']) {
  const world = await seedPermissionWorld(db);
  const reader = await createProfile(world, 'retirement-settings-reader');
  await json(
    await setObjectPermission(
      world,
      reader,
      {
        dataOperations: { create: false, update: false, delete: false },
        fields: [{ fieldCode: 'effectiveDate', view: true, edit: false }],
        buttons: [],
      },
      MODULE_OBJECTS.employmentRecord.code,
    ),
  );
  await makeGrantable(world, [reader.id]);
  await json(await grant(world, world.admin.id, reader.id));
  await withTenant(db, world.tenant.id, (tx) =>
    installMissingSeeds(
      tx,
      { ...cmd(), tenantId: world.tenant.id, now: clock() },
      { modules: ['employment-retirement'] },
    ),
  );
  const fixture = tenantApi(db, { clock });
  const organization = (await json(
    await fixture.request('POST', '/api/tenant/org/organizations', {
      ...world.asAdmin,
      ifMatch: 0,
      body: { name: '合成退休设置部门', parents: { admin: { parentId: world.tenant.id } } },
    }),
  )) as { id: string; name: string };
  return { world, organization };
}

export async function startRetirementSettingsBackend() {
  const handle = await createTestDb();
  try {
    const { world, organization } = await seed(handle.db);
    const serve = async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const part of req) chunks.push(part as Buffer);
      const body = Buffer.concat(chunks).toString();
      const ifMatch = req.headers['if-match'];
      const response = await world.api.request(req.method!, req.url!, {
        ...world.asAdmin,
        ifMatch: typeof ifMatch === 'string' ? ifMatch.replaceAll('"', '') : undefined,
        idempotencyKey: typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : null,
        body: body ? (JSON.parse(body) as unknown) : undefined,
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    };
    const server = createServer((req, res) => {
      void serve(req, res).catch((error: unknown) => {
        res.writeHead(500);
        res.end(String(error));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      manifest: { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, organization },
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
