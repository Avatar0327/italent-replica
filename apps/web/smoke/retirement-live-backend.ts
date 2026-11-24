import { bootstrapTenantAdmin } from '@italent/api';
import { MODULE_OBJECTS, PERSONNEL_OBJECT, PERSONNEL_OBJECTS } from '@italent/domain';
import { createServer } from 'node:http';
import { createTestDb } from '../../../packages/testkit/src/test-db.js';
import { retirementCancelWorld } from '../../../tests/acceptance/AC-RT-cancel-support.js';
import { createProfile, grant, makeGrantable, setObjectPermission } from '../../../tests/acceptance/AC-PRM-support.js';
import { cmd, pinExitGate } from '../../../tests/acceptance/support/tenant-api.js';
import { retirementObjectGrant } from '../src/retirement/retirement-permission.test-support.js';

async function grantRetirementPermissions(world: Awaited<ReturnType<typeof retirementCancelWorld>>) {
  const {
    db,
    api,
    session: { tenant, user },
  } = world;
  const asAdmin = { tenant: tenant.id, user: user.id };
  const adminRecord = await bootstrapTenantAdmin(db, { tenantId: tenant.id, userId: user.id }, cmd());
  const permissions = { db, api, tenant, admin: user, adminRecord, asAdmin };
  const profile = await createProfile(permissions, 'retirement-browser');
  const personnel = PERSONNEL_OBJECTS.find(({ code }) => code === PERSONNEL_OBJECT)!;
  for (const definition of [MODULE_OBJECTS.employmentRecord, personnel]) {
    const response = await setObjectPermission(
      permissions,
      profile,
      retirementObjectGrant(definition),
      definition.code,
    );
    if (!response.ok) throw new Error(`合成授权配置失败 ${await response.text()}`);
  }
  await makeGrantable(permissions, [profile.id]);
  const assigned = await grant(permissions, user.id, profile.id);
  if (!assigned.ok) throw new Error(`合成授权授予失败 ${await assigned.text()}`);
}

export async function startRetirementBackend() {
  pinExitGate('enforce');
  const db = await createTestDb();
  try {
    const world = await retirementCancelWorld(db.db, 'fe-r2c3c', '2026-10-06', { capacity: false });
    const { tenant, user } = world.session;
    await grantRetirementPermissions(world);
    const simultaneous = await world.newcomer('合成同时返聘员工');
    await world.setExpectedRetirement('2026-10-26', simultaneous.id);
    const plain = await world.newcomer('合成取消同时返聘员工');
    await world.setExpectedRetirement('2026-10-26', plain.id);
    const applying = await world.newcomer('合成提前返聘员工');
    await world.submittedRetire('2026-10-15', applying.id);
    const editable = await world.newcomer('合成编辑退休员工');
    await world.directRetire('2026-10-25', undefined, editable.id);
    const dutyOwner = await world.peer('ZZ_F538_退休编辑员工');
    const dutySubordinate = await world.subordinateOf(dutyOwner.id, 'ZZ_F538_下属');
    const dutyBefore = await world.peer('ZZ_F538_原接收人');
    const dutyReceiver = await world.peer('ZZ_F538_新接收人');
    await world.directRetire(
      '2026-10-25',
      world.dutyPlan([{ employeeId: dutySubordinate.id, receiverId: dutyBefore.id }]),
      dutyOwner.id,
    );
    const cancelled = await world.newcomer('合成已撤销退休员工');
    const retired = await world.directRetire('2026-10-25', undefined, cancelled.id);
    await world.retireCancelled(retired.id);
    const handover = await world.session.employee('合成交接员工');
    const closing = await world.session.org('合成将停用返聘部门', { establishedOn: '2026-01-01' });
    const disabled = await world.disable(closing, '2026-10-24');
    if (disabled.status !== 200) throw new Error(`合成停用部门失败 ${await disabled.text()}`);
    const target = await world.session.org('合成返聘部门', { establishedOn: '2026-01-01' });

    const server = createServer((req, res) => {
      void (async () => {
        const body: Buffer[] = [];
        for await (const chunk of req) body.push(chunk as Buffer);
        const requestBody = Buffer.concat(body).toString();
        const path = req.url!;
        const { 'if-match': revision, 'idempotency-key': key } = req.headers;
        const options = {
          ...(requestBody ? { body: JSON.parse(requestBody) as unknown } : {}),
          ...(revision ? { ifMatch: revision.replaceAll('"', '') } : {}),
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
        plain: plain.id,
        applying: applying.id,
        handover: handover.id,
        dutySubordinate: dutySubordinate.id,
        dutyReceiver: dutyReceiver.id,
        closing: closing.id,
        target: target.id,
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
