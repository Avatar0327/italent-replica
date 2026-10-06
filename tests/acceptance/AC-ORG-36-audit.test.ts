import { activationWorld } from './AC-TRF-activation-support.js';
import { tenantApi } from './support/tenant-api.js';
/** DEC-216：任职逐条审计与联动汇总按当前范围、字段查看权裁剪。 */
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import type { Authorizer } from '@italent/api';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import type { ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { auditApi, SOURCE_HEADERS } from './AC-AUD-support.js';
import { orgPeopleWorld } from './AC-ORG-people-support.js';
import { randomUUID } from 'node:crypto';

const database = useTestDb();
it.each([false, true])(
  'AC-ORG-36 联动审计有权可见、范围外不可见、隐藏字段与总人数不泄露（导入=%s）',
  async (viaImport) => {
    const db = database().db;
    const w = await orgPeopleWorld(db, `org36${viaImport}`);
    const org = await w.org('审计组织');
    const child = await w.org('审计下级', org.id);
    const a = await w.hire('可见员工', { departmentId: org.id, place: '保密地点甲' });
    const b = await w.hire('隐藏员工', { departmentId: child.id, place: '保密地点乙' });
    const key = randomUUID();
    const saved = await w.call(viaImport ? 'POST' : 'PATCH', viaImport ? 'org/import' : `org/organizations/${org.id}`, {
      ifMatch: viaImport ? 0 : 1,
      idempotencyKey: key,
      headers: SOURCE_HEADERS,
      body: viaImport
        ? {
            rows: [
              {
                sourceCode: org.id,
                orgId: org.id,
                code: org.code,
                name: '审计新名',
                parentId: w.tenant.id,
                expectedRevision: 1,
                startDate: '2026-10-09',
                addEmployment: true,
              },
            ],
          }
        : { name: '审计新名', effectiveDate: '2026-10-09', addEmployment: true },
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const ra = (await w.records(a.id, '2026-10-09')).find((r) => r.isCurrent)!;
    const rb = (await w.records(b.id, '2026-10-09')).find((r) => r.isCurrent)!;
    let scope: ModuleScope = {
      all: false,
      hasDataPermission: true,
      personIds: [a.id],
      orgIds: [],
      terms: [{ dimension: 'management', personIds: [a.id], orgIds: [] }],
    };
    let fields = new Set(['departmentId', 'effectiveDate']);
    const authorize: Authorizer = () => true;
    registerScopeProvider(authorize, {
      scope: async (query) =>
        query.objectCode === 'TenantBase.EmploymentRecord'
          ? scope
          : { all: true, hasDataPermission: true, personIds: [], orgIds: [] },
      authorize: async () => true,
      fields: async (_tenant, _user, objectCode) =>
        objectCode === 'TenantBase.EmploymentRecord'
          ? fields
          : new Set(['name', 'startDate', 'employeeCount', 'effectiveDate']),
    });
    const viewer = auditApi(db, '2026-10-01T01:00:00Z', { authorize });
    const as = { user: w.user.id, tenant: w.tenant.id };
    const all = auditApi(db, '2026-10-01T01:00:00Z');
    const allRows = (await all.dataChanges(as, { limit: '100' })).items.filter((r) => r.commandId === key);
    const summary = allRows.find((r) => r.action === 'org.employment.adjusted')!;
    expect(summary).toBeDefined();
    expect((await all.dataChange(as, summary.id)).after).toMatchObject({ employeeCount: 2 });
    const rows = (await viewer.dataChanges(as, { limit: '100' })).items.filter((r) => r.commandId === key);
    expect(rows.some((r) => r.objectId === ra.id && r.action === 'employment.record.create')).toBe(true);
    expect(rows.some((r) => r.objectId === rb.id)).toBe(false);
    const record = rows.find((r) => r.objectId === ra.id && r.action === 'employment.record.create')!;
    const detail = await viewer.dataChange(as, record.id);
    expect(detail).toMatchObject({ traceId: 'trace-aud-01', after: { departmentId: org.id } });
    expect(JSON.stringify(detail)).not.toContain('保密地点');
    expect(detail.changes.some((c) => c.field === 'place')).toBe(false);
    const hidden = allRows.find((r) => r.objectId === rb.id && r.action === 'employment.record.create')!;
    expect((await viewer.get(`/data-changes/${hidden.id}`, as)).status).toBe(404);
    expect((await viewer.dataChanges(as, { objectId: ra.id, field: 'place' })).items).toEqual([]);
    const limitedSummary = await viewer.dataChange(as, summary.id);
    expect(limitedSummary.after).toMatchObject({ employeeCount: 1 });
    expect(JSON.stringify(limitedSummary)).not.toContain(rb.id);
    scope = { all: false, hasDataPermission: false, personIds: [], orgIds: [] };
    expect((await viewer.get(`/data-changes/${summary.id}`, as)).status).toBe(404);
    expect((await viewer.get(`/data-changes/${record.id}`, as)).status).toBe(404);
    scope = { all: true, hasDataPermission: true, personIds: [], orgIds: [] };
    fields = new Set();
    expect((await viewer.get(`/data-changes/${record.id}`, as)).status).toBe(404);
    expect((await viewer.get(`/data-changes/${summary.id}`, as)).status).toBe(404);
  },
);

it('AC-ORG-36 迟到重建的任职审计沿用当前范围并隐藏地点字段', async () => {
  const w = await activationWorld(database().db, 'org36late');
  const person = await w.hired();
  await w.session.business(
    person.employee.id,
    {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-10-05',
      fields: { departmentId: w.to.id, place: '保密调入地点' },
    },
    person.hire.employeeRevision,
  );
  const api = tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00Z') });
  const as = { user: w.session.user.id, tenant: w.session.tenant.id };
  const response = await api.request('PATCH', `/api/tenant/org/organizations/${w.to.id}`, {
    ...as,
    ifMatch: 1,
    body: { name: '迟到审计更名', effectiveDate: '2026-10-09', addEmployment: true },
  });
  expect(response.status).toBe(200);
  expect(await w.runScheduler('2026-10-10T01:00:00Z')).toMatchObject({ failed: [], errors: [] });
  let scope: ModuleScope = {
    all: false,
    hasDataPermission: true,
    personIds: [person.employee.id],
    orgIds: [],
    terms: [{ dimension: 'management', personIds: [person.employee.id], orgIds: [] }],
  };
  const authorize: Authorizer = () => true;
  registerScopeProvider(authorize, {
    scope: async () => scope,
    authorize: async () => true,
    fields: async () => new Set(['departmentId']),
  });
  const audit = auditApi(w.db, '2026-10-10T01:00:00Z', { authorize });
  const rows = (await audit.dataChanges(as, { objectType: 'employment-record', limit: '100' })).items;
  const event = rows.find((row) => row.action === 'employment.org-adjustment.rebased')!;
  expect(event).toBeDefined();
  const detail = await audit.dataChange(as, event.id);
  expect(detail).toMatchObject({ before: { departmentId: w.to.id }, after: { departmentId: w.from.id } });
  expect(JSON.stringify(detail)).not.toContain('保密调入地点');
  expect(JSON.stringify(detail)).not.toContain('原地点');
  expect(detail.changes.every((change) => change.field === 'departmentId')).toBe(true);
  scope = { all: false, hasDataPermission: false, personIds: [], orgIds: [] };
  expect((await audit.get(`/data-changes/${event.id}`, as)).status).toBe(404);
});
