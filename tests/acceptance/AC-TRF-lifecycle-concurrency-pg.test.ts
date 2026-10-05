/** F-008：调动草稿编辑等待员工锁后，必须重新检查源员工权限；真实 PostgreSQL 强制交错。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { createEmploymentBusiness } from '../../apps/api/src/modules/employment/write-service.js';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import { loginEmailOf } from './AC-EMP-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const now = new Date('2026-10-01T01:00:00.000Z');
const rows = <T>(value: unknown) => (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];

async function world(db: Db) {
  const original = await seedPermissionWorld(db);
  const api = tenantApi(db, { authorize: undefined, clock: () => now });
  const w = { ...original, api };
  const setup = tenantApi(db, { clock: () => now });
  const create = async (path: string, body: object, revision = 0) => {
    const response = await setup.request('POST', `/api/tenant/${path}`, {
      ...w.asAdmin,
      ifMatch: revision,
      body,
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string; revision: number; employeeRevision: number };
  };
  const org = (name: string) =>
    create('org/organizations', {
      name,
      startDate: '2025-01-01',
      parents: { admin: { parentId: w.tenant.id } },
    });
  const inside = await org('生命周期范围内部门');
  const outside = await org('生命周期范围外部门');
  const employee = await create('employment/employees', { name: '合成交错员工', code: `TRF_${randomUUID()}` });
  const hire = await create(
    `employment/employees/${employee.id}/businesses`,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-01-01',
      loginEmail: loginEmailOf(employee.id),
      fields: { departmentId: inside.id },
    },
    employee.revision,
  );
  const user = await addMember(w, 'lifecycle-hr');
  const profile = await createProfile(w, `LIFECYCLE_${randomUUID()}`);
  const definition = MODULE_OBJECTS.employmentRecord;
  const permission = await setObjectPermission(
    w,
    profile,
    {
      dataOperations: { create: true, update: true, delete: false },
      fields: definition.fields.map((field) => ({ fieldCode: field.code, view: true, edit: !field.system })),
      buttons: ['Transfer.Hr', 'Employment.Edit'].map((buttonCode) => ({ buttonCode, level: 'detail' })),
    },
    definition.code,
  );
  expect(permission.status).toBe(200);
  await makeGrantable(w, [profile.id]);
  expect((await grant(w, user.id, profile.id)).status).toBe(201);
  const scope = await api.request('PUT', `/api/tenant/permission/scopes/${user.id}/TenantBase`, {
    ...w.asAdmin,
    ifMatch: 0,
    body: { kind: 'org_range', orgRanges: [{ orgId: inside.id, includeDescendants: false }] },
  });
  expect(scope.status).toBe(200);
  return { ...w, employee, hire, outside, actor: { user: user.id, tenant: w.tenant.id } };
}

async function waitForEmployeeLock(db: Db) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const [row] = rows<{ n: number }>(
      await db.execute(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND query ILIKE '%employment_employees%'
    `),
    );
    if (row?.n === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('调动编辑未进入员工锁等待');
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-TRF 生命周期真 PG 交错', () => {
  it('PATCH等待员工锁期间员工已迁出源范围，放行后404且不追加草稿版本', async () => {
    const w = await world(testDb().db);
    const created = await w.api.request('POST', `/api/tenant/employment/transfers/employees/${w.employee.id}`, {
      ...w.actor,
      ifMatch: w.hire.employeeRevision,
      body: {
        initiator: 'hr',
        transferTypeCode: 'cross_department',
        mode: 'application',
        effectiveDate: '2026-11-01',
        fields: { departmentId: w.outside.id },
      },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const draft = (await created.json()) as { id: string; revision: number; employeeRevision: number };
    const [pending] = await withTenant(w.db, w.tenant.id, async (barrier) => {
      await barrier.execute(sql`SELECT id FROM employment_employees
        WHERE tenant_id=${w.tenant.id} AND id=${w.employee.id}::uuid FOR UPDATE`);
      const patch = w.api.request('PATCH', `/api/tenant/employment/businesses/${draft.id}`, {
        ...w.actor,
        ifMatch: draft.revision,
        body: { fields: { remarks: '不得在迁出后写入' } },
      });
      await waitForEmployeeLock(w.db);
      // 同一事务持有员工锁，先完成独立直接调动；不联动草稿，确保被测PATCH仍持有正确业务revision。
      await createEmploymentBusiness(
        barrier,
        {
          tenantId: w.tenant.id,
          userId: w.admin.id,
          timezone: w.tenant.timezone,
          now,
          commandId: randomUUID(),
          expectedRevision: draft.employeeRevision,
        },
        w.employee.id,
        {
          kind: 'transfer',
          mode: 'direct',
          effectiveDate: '2026-10-01',
          fields: { departmentId: w.outside.id },
        },
        { forwardUpdate: false },
      );
      return [patch];
    });
    const response = await pending!;
    expect(response.status, await response.clone().text()).toBe(404);
    const versions = await withTenant(w.db, w.tenant.id, async (tx) =>
      rows<{ n: number }>(
        await tx.execute(sql`
      SELECT count(*)::int AS n FROM employment_payload_versions
      WHERE tenant_id=${w.tenant.id} AND business_id=${draft.id}::uuid
    `),
      ),
    );
    expect(versions[0]?.n).toBe(1);
  });
});
