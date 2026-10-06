import { randomUUID } from 'node:crypto';
import { type Authorizer } from '@italent/api';
import { sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { orgPeopleWorld, resultRows } from './AC-ORG-people-support.js';
import { tenantApi } from './support/tenant-api.js';
const database = useTestDb();

it.each([false, true])('AC-ORG-28 当前可见则联动，撤权后幂等重放拒绝（导入=%s）', async (viaImport) => {
  const db = database().db;
  const w = await orgPeopleWorld(db, 'org28visible');
  const inside = await w.org('当前可见');
  const outside = await w.org('未来部门');
  const person = await w.hire('可见员工', { departmentId: inside.id });
  await w.business(
    person.id,
    { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-05', fields: { departmentId: outside.id } },
    person.revision,
  );
  let employmentScope: ModuleScope = {
    all: false,
    hasDataPermission: true,
    orgIds: [inside.id],
    personIds: [],
    terms: [
      {
        dimension: 'organization',
        orgIds: [inside.id],
        personIds: [],
        personQuery: { kind: 'organization', tenantId: w.tenant.id, asOf: '2026-10-01' },
      },
    ],
  };
  const authorize: Authorizer = () => true;
  registerScopeProvider(authorize, {
    scope: async (query) =>
      query.objectCode === 'TenantBase.EmploymentRecord'
        ? employmentScope
        : { all: true, hasDataPermission: true, orgIds: [], personIds: [] },
    authorize: async () => true,
    fields: async () => new Set(MODULE_OBJECTS.organization.fields.map((f) => f.code)),
  });
  const api = tenantApi(db, { authorize, clock: () => new Date('2026-10-01T01:00:00Z') });
  const key = randomUUID();
  const send = () =>
    api.request(
      viaImport ? 'POST' : 'PATCH',
      viaImport ? '/api/tenant/org/import' : `/api/tenant/org/organizations/${outside.id}`,
      {
        user: w.user.id,
        tenant: w.tenant.id,
        ifMatch: viaImport ? 0 : outside.revision,
        idempotencyKey: key,
        body: viaImport
          ? {
              rows: [
                {
                  sourceCode: outside.id,
                  orgId: outside.id,
                  code: outside.code,
                  name: '可见联动成功',
                  parentId: w.tenant.id,
                  expectedRevision: outside.revision,
                  startDate: '2026-10-08',
                  addEmployment: true,
                },
              ],
            }
          : { name: '可见联动成功', effectiveDate: '2026-10-08', addEmployment: true },
      },
    );
  const saved = await send();
  expect(saved.status, await saved.clone().text()).toBe(200);
  expect(await w.records(person.id)).toHaveLength(3);
  employmentScope = { all: false, hasDataPermission: false, orgIds: [], personIds: [] };
  const replay = await send();
  expect(replay.status).toBe(404);
  expect(await replay.json()).toMatchObject({ error: { code: 'LINKED_RECORD_OUT_OF_SCOPE' } });
  expect(await w.records(person.id)).toHaveLength(3);
});

it.each([false, true])('AC-ORG-28 任一员工不可见则组织及所有联动整单回滚（导入=%s）', async (viaImport) => {
  const db = database().db;
  const w = await orgPeopleWorld(db, 'org28rollback');
  const root = await w.org('主部门');
  const child = await w.org('下级部门', root.id);
  const a = await w.hire('员工甲', { departmentId: root.id });
  const b = await w.hire('员工乙', { departmentId: child.id });
  const visibleDepartment = a.id < b.id ? root.id : child.id;
  const authorize: Authorizer = () => true;
  registerScopeProvider(authorize, {
    scope: async (query) => ({
      all: query.objectCode !== 'TenantBase.EmploymentRecord',
      hasDataPermission: true,
      orgIds: [visibleDepartment],
      personIds: [],
      terms: [
        {
          dimension: 'organization',
          orgIds: [visibleDepartment],
          personIds: [],
        },
      ],
    }),
    authorize: async () => true,
    fields: async () => new Set(MODULE_OBJECTS.organization.fields.map((f) => f.code)),
  });
  const api = tenantApi(db, { authorize, clock: () => new Date('2026-10-01T01:00:00Z') });
  const key = randomUUID();
  const response = await api.request(
    viaImport ? 'POST' : 'PATCH',
    viaImport ? '/api/tenant/org/import' : `/api/tenant/org/organizations/${root.id}`,
    {
      user: w.user.id,
      tenant: w.tenant.id,
      ifMatch: viaImport ? 0 : root.revision,
      idempotencyKey: key,
      body: viaImport
        ? {
            rows: [
              {
                sourceCode: root.id,
                orgId: root.id,
                code: root.code,
                name: '不应保存',
                parentId: w.tenant.id,
                expectedRevision: root.revision,
                startDate: '2026-10-08',
                addEmployment: true,
              },
            ],
          }
        : { name: '不应保存', effectiveDate: '2026-10-08', addEmployment: true },
    },
  );
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ error: { code: 'LINKED_RECORD_OUT_OF_SCOPE' } });
  expect(await w.records(a.id)).toHaveLength(1);
  expect(await w.records(b.id)).toHaveLength(1);
  expect((await w.orgsAt('2026-10-08')).get(root.id)).toMatchObject({ name: root.name, revision: root.revision });
  await withTenant(db, w.tenant.id, async (tx) => {
    expect(
      resultRows(
        await tx.execute(sql`SELECT id FROM audit_events
      WHERE tenant_id=${w.tenant.id} AND command_id=${key}`),
      ),
    ).toEqual([]);
    expect(
      resultRows(
        await tx.execute(sql`SELECT id FROM employment_outbox
      WHERE tenant_id=${w.tenant.id} AND command_id=${key}`),
      ),
    ).toEqual([]);
  });
});
