/** Bounded real SQL on a large tenant; personnel scope remains a relational SQL predicate. */
import { randomUUID } from 'node:crypto';
import { sql, type Tx, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { listEmployees } from '../../apps/api/src/modules/employment/employees.js';
import { resolveDataScope } from '../../apps/api/src/modules/permission/scope-resolver.js';
import { scopeRows } from '../../apps/api/src/modules/permission/scope-hierarchy.js';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';
import { loginEmailOf } from './AC-EMP-support.js';

const database = useTestDb();
it('scope resolution + paginated list uses a fixed number of queries with thousands of records', async () => {
  const w = await seedPermissionWorld(database().db);
  const setup = tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00Z') });
  async function create(path: string, body: unknown, revision = 0) {
    const r = await setup.request('POST', `/api/tenant/${path}`, { ...w.asAdmin, ifMatch: revision, body });
    expect(r.status, await r.clone().text()).toBe(201);
    return (await r.json()) as { id: string; revision: number };
  }
  const org = await create('org/organizations', {
    name: '范围根',
    establishedOn: '2025-01-01',
    parents: { admin: { parentId: w.tenant.id } },
  });
  const employee = await create('employment/employees', { code: randomUUID(), name: '合成员工' });
  await create(
    `employment/employees/${employee.id}/businesses`,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-01-01',
      fields: { departmentId: org.id },
      loginEmail: loginEmailOf(employee.id),
    },
    employee.revision,
  );
  const user = await addMember(w, 'bounded-list');
  const profile = await createProfile(w, 'bounded-profile');
  await setObjectPermission(
    w,
    profile,
    {
      dataOperations: { create: false, update: false, delete: false },
      fields: ['id', 'code'].map((fieldCode) => ({ fieldCode, view: true, edit: false })),
      buttons: [],
    },
    MODULE_OBJECTS.employee.code,
  );
  await makeGrantable(w, [profile.id]);
  await grant(w, user.id, profile.id);
  const scopeResponse = await w.api.request('PUT', `/api/tenant/permission/scopes/${user.id}/TenantBase`, {
    ...w.asAdmin,
    ifMatch: 0,
    body: { kind: 'org_range', orgRanges: [{ orgId: org.id, includeDescendants: true }] },
  });
  expect(scopeResponse.status).toBe(200);

  await withTenant(w.db, w.tenant.id, async (tx) => {
    const tid = w.tenant.id;
    await tx.execute(sql`INSERT INTO org_objects(id,tenant_id)
      SELECT md5(${tid}||'org'||g)::uuid,${tid} FROM generate_series(1,2000) g`);
    await tx.execute(sql`INSERT INTO org_versions(id,tenant_id,org_id,version_no,start_date,code,name,full_name)
      SELECT md5(${tid}||'orgv'||g)::uuid,${tid},md5(${tid}||'org'||g)::uuid,1,'2025-01-01',
      'O'||g,'合成部门'||g,'范围根/合成部门'||g FROM generate_series(1,2000) g`);
    await tx.execute(sql`INSERT INTO org_hierarchy_links(tenant_id,version_id,dimension,parent_org_id)
      SELECT ${tid},md5(${tid}||'orgv'||g)::uuid,'admin',${org.id} FROM generate_series(1,2000) g`);
    // Copy only synthetic seed rows. Preserve every FK and version/timeline constraint.
    for (const table of [
      'employment_employees',
      'employment_cycles',
      'employment_business_objects',
      'employment_payload_versions',
      'employment_records',
      'employment_timeline',
    ] as const) {
      const tableSql = sql.identifier(table);
      const ownKey = table === 'employment_employees' ? sql`id` : sql`employee_id`;
      const idPrefix = {
        employment_employees: 'person',
        employment_cycles: 'staff',
        employment_business_objects: 'business',
        employment_payload_versions: 'payload',
        employment_records: 'business',
        employment_timeline: 'timeline',
      }[table];
      const generatedRows = table === 'employment_employees' ? 50000 : 2000;
      const patch = sql`jsonb_build_object('id',md5(${tid}||${idPrefix}||g)::uuid,'tenant_id',${tid}::uuid,
        'employee_id',md5(${tid}||'person'||g)::uuid,'business_id',md5(${tid}||'business'||g)::uuid,
        'payload_version_id',md5(${tid}||'payload'||g)::uuid,'staff_id',md5(${tid}||'staff'||g)::uuid,
        'record_id',md5(${tid}||'business'||g)::uuid,'code','E'||g,
        'department_id',md5(${tid}||'org'||(1 + ((g - 1) % 2000)))::uuid)`;
      await tx.execute(sql`INSERT INTO ${tableSql}
        SELECT (jsonb_populate_record(NULL::${tableSql},to_jsonb(sample)||${patch})).*
        FROM (SELECT * FROM ${tableSql} WHERE tenant_id=${tid} AND ${ownKey}=${employee.id} LIMIT 1) sample
        CROSS JOIN generate_series(1,${generatedRows}) g`);
    }
  });

  await withTenant(w.db, w.tenant.id, async (tx) => {
    let queryCount = 0;
    const counted = new Proxy(tx, {
      get(target, key, receiver) {
        if (key === 'execute')
          return (...args: Parameters<Tx['execute']>) => {
            queryCount++;
            return target.execute(...args);
          };
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const started = performance.now();
    const scope = await resolveDataScope(counted, {
      tenantId: w.tenant.id,
      userId: user.id,
      appCode: 'TenantBase',
      objectCode: MODULE_OBJECTS.employee.code,
      asOf: '2026-10-01',
    });
    expect(scope.orgIds).toHaveLength(2001);
    expect(scope.personIds).toEqual([]);
    expect(scope.terms?.[0]?.personQuery?.kind).toBe('organization');
    const rows = await listEmployees(counted, w.tenant.id, '2026-10-01', { limit: 50, offset: 0 }, {}, scope);
    expect(rows).toHaveLength(50);
    expect(queryCount).toBeLessThanOrEqual(8);
    expect(performance.now() - started).toBeLessThan(5000);
    const total = scopeRows<{ count: string }>(
      await tx.execute(sql`SELECT count(*)::text AS count
      FROM employment_employees WHERE tenant_id=${w.tenant.id}`),
    );
    expect(total[0]!.count).toBe('50001');
  });
  const api = tenantApi(w.db, { authorize: undefined, clock: () => new Date('2026-10-01T01:00:00Z') });
  const response = await api.request('GET', '/api/tenant/employment/employees', { user: user.id, tenant: w.tenant.id });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { items: Record<string, unknown>[]; hasDataPermission: boolean };
  expect(body.items).toHaveLength(50);
  expect(body.hasDataPermission).toBe(true);
  expect(body.items.every((row) => !('name' in row))).toBe(true);
}, 120000);
