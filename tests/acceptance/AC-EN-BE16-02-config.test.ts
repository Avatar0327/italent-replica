import { randomUUID } from 'node:crypto';
import { auditEvents, commandLedger, eq, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import type { Authorizer } from '../../apps/api/src/authorization.js';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { entryWorld } from './AC-EN-BE2a-support.js';
import { tenantApi, type RequestOptions } from './support/tenant-api.js';

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
    if (request.action === 'tenant.employment.configuration.write' || request.action === 'admin.other_settings')
      return rights.admin;
    if (request.resource === settings && request.action === 'object.view') return true;
    return (
      request.resource === settings &&
      (request.action === 'object.create' || (request.action === 'object.update' && rights.update)) &&
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
  return { ...w, tenant, rights, request, ledger };
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
