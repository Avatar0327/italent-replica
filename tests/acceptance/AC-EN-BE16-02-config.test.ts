import { randomUUID } from 'node:crypto';
import { bootstrapTenantAdmin } from '@italent/api';
import { auditEvents, commandLedger, eq, onboardingEntryCases, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import type { Authorizer } from '../../apps/api/src/authorization.js';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { matchEntryCollection } from '../../apps/api/src/modules/onboarding/collection-config-match.js';
import { addPending, entryWorld, portContext } from './AC-EN-BE2a-support.js';
import { cmd, seedTenantWithMember, tenantApi, type RequestOptions } from './support/tenant-api.js';

const testDb = useTestDb();
const settings = MODULE_OBJECTS.employmentSettings.code;
const now = new Date('2026-10-01T12:00:00Z');
const fields = ['collectionSettings', 'collectionTemplates', 'collectionRules'];
const base = '/api/tenant/onboarding';
const template = {
  name: 'ZZ_BE16_TEMPLATE',
  enabled: true,
  noticeTitle: 'ZZ_BE16_TITLE',
  noticeBody: '请填写入职信息，只可本人使用、不可转发',
  fields: [{ objectCode: 'TenantBase.EmployeeInformation', fieldCode: 'name', required: true, editable: true }],
};

async function world(label: string) {
  const { db } = testDb();
  const w = await entryWorld(db, label);
  const tenant = w.session.tenant.id;
  const user = w.session.user.id;
  const rights = { admin: true, update: true, orgIds: [w.org.id] };
  const authorize: Authorizer = (request) => {
    if (request.action === 'admin.audit_log') return true;
    if (request.action === 'tenant.employment.configuration.write' || request.action === 'admin.other_settings')
      return rights.admin;
    if (request.resource === settings && request.action === 'object.view') return true;
    return (
      request.resource === settings &&
      (request.action === 'object.create' ||
        (request.action === 'object.update' && (rights.update || !request.fields?.includes('collectionRules')))) &&
      !!request.fields?.every((field) => fields.includes(field))
    );
  };
  registerScopeProvider(authorize, {
    authorize: async (request) => authorize(request),
    scope: async () => ({ all: false, hasDataPermission: true, orgIds: rights.orgIds, personIds: [] }),
    fields: async () => new Set(fields),
  });
  const api = tenantApi(db, { authorize, clock: () => now });
  const request = (method: string, path: string, options: RequestOptions = {}) =>
    api.request(method, base + path, { tenant, user, ...options });
  const ledger = (id: string) =>
    withTenant(db, tenant, (tx) => tx.select().from(commandLedger).where(eq(commandLedger.commandId, id)));
  return { ...w, tenant, user, api, rights, request, ledger };
}

async function response<T>(res: Response, status: number) {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await res.json()) as T;
}

type Receipt = { id: string; revision: number; status: string };

it('AC-EN-BE16-02 自动采集默认开，关闭持久化并拒绝过期 revision', async () => {
  const w = await world('ZZ_BE16_SWITCH');
  const settings = '/collection-settings';
  expect(await response(await w.request('GET', settings), 200)).toMatchObject({ enabled: true, revision: 0 });
  await response(await w.request('PUT', settings, { ifMatch: 0, body: { enabled: false } }), 200);
  expect(await response(await w.request('GET', settings), 200)).toMatchObject({ enabled: false, revision: 1 });
  expect((await w.request('PUT', settings, { ifMatch: 0, body: { enabled: true } })).status).toBe(409);
});

it('AC-EN-BE16-02 DEC-979 租户管理员按字段更新权和当前组织范围归档，拒绝时无写入与成功台账', async () => {
  const w = await world('ZZ_BE16_ARCHIVE');
  const templates = '/collection-templates';
  const rules = '/collection-rules';
  const created = await response<Receipt>(await w.request('POST', templates, { ifMatch: 0, body: template }), 201);
  const ruleBody = { name: 'ZZ_BE16_RULE', enabled: true, priority: 20, templateId: created.id, orgIds: [w.org.id] };
  const rule = await response<Receipt>(await w.request('POST', rules, { ifMatch: 0, body: ruleBody }), 201);
  const path = `${rules}/${rule.id}`;
  for (const [override, status] of [
    [{ admin: false }, 403],
    [{ update: false }, 403],
    [{ orgIds: [] }, 404],
  ] as const) {
    Object.assign(w.rights, override);
    const idempotencyKey = randomUUID();
    const rejected = await w.request('DELETE', path, { ifMatch: rule.revision, idempotencyKey });
    expect(rejected.status, await rejected.clone().text()).toBe(status);
    expect(await w.ledger(idempotencyKey)).toEqual([]);
    Object.assign(w.rights, { admin: true, update: true, orgIds: [w.org.id] });
    expect(await response(await w.request('GET', path), 200)).toMatchObject({ revision: rule.revision, enabled: true });
  }
  const idempotencyKey = randomUUID();
  const archive = () => w.request('DELETE', path, { ifMatch: rule.revision, idempotencyKey });
  expect((await archive()).status).toBe(204);
  expect((await archive()).status).toBe(204);
  w.rights.orgIds = [];
  expect((await archive()).status).toBe(404);
  w.rights.orgIds = [w.org.id];
  expect((await w.request('GET', path)).status).toBe(404);
  expect(await response(await w.request('GET', rules), 200)).toMatchObject({ items: [] });
  expect(await w.ledger(idempotencyKey)).toHaveLength(1);
  expect((await w.request('DELETE', `${templates}/${created.id}`, { ifMatch: created.revision })).status).toBe(204);
  expect(await response(await w.request('GET', templates), 200)).toMatchObject({ items: [] });
  const audits = await withTenant(w.db, w.tenant, (tx) =>
    tx.select().from(auditEvents).where(eq(auditEvents.objectId, rule.id)),
  );
  expect(audits.map((row) => row.action).sort()).toEqual([
    'onboarding.collectionRules.archive',
    'onboarding.collectionRules.create',
  ]);
  const archiveAudit = audits.find((row) => row.action.endsWith('.archive'))!;
  expect(archiveAudit).toMatchObject({ objectType: 'onboarding-collection-config', commandId: idempotencyKey });
  w.rights.orgIds = [];
  const actor = { tenant: w.tenant, user: w.user };
  const log = await w.api.request('GET', `/api/tenant/audit/data-changes/${archiveAudit.id}`, actor);
  expect(log.status).toBe(404);
  const receipt = await w.api.request('GET', `/api/tenant/commands/${idempotencyKey}/result`, actor);
  expect(await response(receipt, 200)).toMatchObject({ httpStatus: 204, businessId: null, revision: null });
});

it('AC-EN-BE16-02 拒绝目录外字段、条件和越范围配置，列表先裁剪再分页', async () => {
  const w = await world('ZZ_BE16_ALLOWLIST');
  const other = await w.session.org('ZZ_BE16_OUTSIDE', { establishedOn: '2026-01-01' });
  const save = (path: string, body: object) => w.request('POST', path, { ifMatch: 0, body });
  expect(
    (
      await save('/collection-templates', {
        ...template,
        fields: [{ ...template.fields[0], fieldCode: 'ZZ_BE16_UNKNOWN' }],
      })
    ).status,
  ).toBe(400);
  const saved = await response<Receipt>(await save('/collection-templates', template), 201);
  const base = { name: 'ZZ_BE16_RULE', enabled: true, priority: 20, templateId: saved.id };
  const rules = '/collection-rules';
  expect((await save(rules, { ...base, orgIds: [other.id] })).status).toBe(404);
  expect(
    (
      await save(rules, {
        ...base,
        orgIds: [w.org.id],
        conditions: { items: [{ no: 1, field: 'ZZ_BE16_UNKNOWN', operator: 'eq', value: 'x' }], expression: '' },
      })
    ).status,
  ).toBe(400);
  w.rights.orgIds = [w.org.id, other.id];
  const outside = await response<Receipt>(await save(rules, { ...base, priority: 10, orgIds: [other.id] }), 201);
  const inside = await response<Receipt>(await save(rules, { ...base, orgIds: [w.org.id] }), 201);
  w.rights.orgIds = [w.org.id];
  expect((await w.request('GET', `${rules}/${outside.id}`)).status).toBe(404);
  expect(await response(await w.request('GET', `${rules}?pageSize=1`), 200)).toMatchObject({
    items: [{ id: inside.id }],
  });
});

it('AC-EN-BE16-02 匹配当前待入职行政树与白名单事实，优先级相等拒绝，归档与停用后回退', async () => {
  const w = await world('ZZ_BE16_MATCH');
  const child = await w.session.org('ZZ_BE16_CHILD', {
    establishedOn: '2026-01-01',
    parents: { admin: { parentId: w.org.id } },
  });
  const entry = await addPending({ ...w, org: child }, '2026-10-08', 'ZZ_BE16_MATCH');
  const [stage] = await withTenant(w.db, w.tenant, (tx) => tx.select().from(onboardingEntryCases));
  const ctx = portContext(w, entry.business.revision);
  const ref = {
    caseId: stage!.id,
    caseRevision: stage!.revision,
    employeeId: entry.employee.id,
    businessId: entry.recordId,
    businessRevision: entry.business.revision,
  };
  const match = (mode: 'auto' | 'manual' = 'manual') =>
    withTenant(w.db, w.tenant, (tx) => matchEntryCollection(tx, ctx, ref, mode));
  const rules = '/collection-rules';
  const templates = '/collection-templates';
  const saved = await response<Receipt>(await w.request('POST', templates, { ifMatch: 0, body: template }), 201);
  const highTemplate = await response<Receipt>(
    await w.request('POST', templates, {
      ifMatch: 0,
      body: { ...template, name: 'ZZ_BE16_HIGH_TEMPLATE' },
    }),
    201,
  );
  const body = { name: 'ZZ_BE16_PRIORITY', enabled: true, templateId: saved.id, orgIds: [w.org.id] };
  const addRule = async (extra: object) =>
    response<Receipt>(await w.request('POST', rules, { ifMatch: 0, body: { ...body, ...extra } }), 201);
  const condition = (value: string) => ({
    items: [{ no: 1, field: 'record.employType', operator: 'eq', value }],
    expression: '',
  });
  expect((await w.request('POST', rules, { ifMatch: 0, body: { ...body, priority: 20 } })).status).toBe(404);
  w.rights.orgIds = [w.org.id, child.id];
  await addRule({ priority: 1, conditions: condition('intern') });
  const low = await addRule({ priority: 50 });
  const high = await addRule({ priority: 10, templateId: highTemplate.id, conditions: condition('internal') });
  expect(await match()).toMatchObject({ status: 'matched', rule: { id: high.id }, fields: template.fields });
  const tie = await addRule({ priority: 10 });
  await expect(match()).rejects.toMatchObject({ details: { reason: 'COLLECTION_RULE_AMBIGUOUS' } });
  expect((await w.request('DELETE', `${rules}/${tie.id}`, { ifMatch: tie.revision })).status).toBe(204);
  expect(await match()).toMatchObject({ rule: { id: high.id } });

  w.rights.orgIds = [w.org.id];
  const blocked = randomUUID();
  expect(
    (
      await w.request('DELETE', `${templates}/${highTemplate.id}`, {
        ifMatch: highTemplate.revision,
        idempotencyKey: blocked,
      })
    ).status,
  ).toBe(404);
  expect(await w.ledger(blocked)).toEqual([]);
  w.rights.orgIds.push(child.id);
  expect(
    (await w.request('DELETE', `${templates}/${highTemplate.id}`, { ifMatch: highTemplate.revision })).status,
  ).toBe(204);
  expect(await match()).toMatchObject({ rule: { id: low.id } });

  const patched = await response<Receipt>(
    await w.request('PATCH', `${rules}/${low.id}`, {
      ifMatch: low.revision,
      body: { enabled: false },
    }),
    200,
  );
  expect(patched.revision).toBe(2);
  await expect(match()).rejects.toMatchObject({ details: { reason: 'COLLECTION_RULE_NOT_MATCHED' } });
  expect(await match('auto')).toEqual({ status: 'skipped', reason: 'COLLECTION_RULE_NOT_MATCHED' });
  await response(await w.request('PUT', '/collection-settings', { ifMatch: 0, body: { enabled: false } }), 200);
  expect(await match('auto')).toEqual({ status: 'skipped', reason: 'COLLECTION_AUTO_DISABLED' });
});

it('AC-EN-BE16-02 真实租户管理员具备字段更新权，可归档租户级采集模板', async () => {
  const { db } = testDb();
  const { tenant, user } = await seedTenantWithMember(db, 'ZZ_BE16_REAL_ADMIN');
  await bootstrapTenantAdmin(db, { tenantId: tenant.id, userId: user.id }, cmd());
  const api = tenantApi(db, { authorize: undefined, clock: () => now });
  const asAdmin = { tenant: tenant.id, user: user.id };
  const path = base + '/collection-templates';
  const saved = await response<Receipt>(
    await api.request('POST', path, { ...asAdmin, ifMatch: 0, body: template }),
    201,
  );
  const responseArchive = await api.request('DELETE', `${path}/${saved.id}`, {
    ...asAdmin,
    ifMatch: saved.revision,
  });
  expect(responseArchive.status, await responseArchive.clone().text()).toBe(204);
  expect(await response(await api.request('GET', path, asAdmin), 200)).toMatchObject({ items: [] });
});
