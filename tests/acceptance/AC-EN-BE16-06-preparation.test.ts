import { randomUUID } from 'node:crypto';
import { and, commandLedger, eq, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import type { Authorizer } from '../../apps/api/src/authorization.js';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { entryWorld } from './AC-EN-BE2a-support.js';
import { tenantApi, type RequestOptions } from './support/tenant-api.js';

const testDb = useTestDb();
const now = new Date('2026-10-01T12:00:00Z');
const items = '/preparation-items';
const rules = '/preparation-rules';
const item = {
  category: 'other',
  code: 'ZZ_BE16_PREPARATION',
  name: 'ZZ_BE16_PREPARATION',
  fields: [{ code: 'remark', label: '办理说明', required: true }],
};
type Receipt = { id: string; revision: number; status: string };

async function world(label: string) {
  const { db } = testDb();
  const w = await entryWorld(db, label);
  const tenant = w.session.tenant.id;
  const user = w.session.user.id;
  const rights = { admin: true, fields: new Set(['preparationItems', 'preparationRules']), orgs: [w.org.id] };
  const settings = MODULE_OBJECTS.employmentSettings.code;
  const authorize: Authorizer = (req) => {
    if (req.action === 'admin.other_settings' || req.action === 'tenant.employment.configuration.write')
      return rights.admin;
    return req.resource === settings && (req.fields ?? []).every((field) => rights.fields.has(field));
  };
  registerScopeProvider(authorize, {
    authorize: async (req) => authorize(req),
    scope: async () => ({ all: false, hasDataPermission: true, orgIds: rights.orgs, personIds: [] }),
    fields: async () => rights.fields,
  });
  const api = tenantApi(db, { authorize, clock: () => now });
  const request = (method: string, path: string, options: RequestOptions = {}) =>
    api.request(method, '/api/tenant/onboarding' + path, { tenant, user, ...options });
  const create = (path: string, body: object) => request('POST', path, { ifMatch: 0, body });
  const ledger = (id: string) =>
    withTenant(db, tenant, (tx) =>
      tx
        .select()
        .from(commandLedger)
        .where(and(eq(commandLedger.tenantId, tenant), eq(commandLedger.commandId, id))),
    );
  return { ...w, tenant, user, request, create, rights, ledger };
}

async function response<T>(res: Response, status: number) {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await res.json()) as T;
}

it('AC-EN-BE16-06 A40 目录不收办理人，使用配置字段权和版本保护目录', async () => {
  const w = await world('ZZ_BE16_PREP_ITEMS');
  expect((await w.create(items, { ...item, assignees: [{ kind: 'member', id: w.user }] })).status).toBe(400);
  const row = await response<Receipt>(await w.create(items, item), 201);
  const path = items + '/' + row.id;
  expect(await response(await w.request('GET', path), 200)).toMatchObject(item);
  expect((await w.create(items, item)).status).toBe(409);
  const key = randomUUID();
  const edit = () =>
    w.request('PATCH', path, { ifMatch: row.revision, idempotencyKey: key, body: { name: 'ZZ_BE16_V2' } });
  const saved = await response<Receipt>(await edit(), 200);
  expect(await response(await edit(), 200)).toEqual(saved);
  w.rights.fields.delete('preparationItems');
  expect((await edit()).status).toBe(403);
  w.rights.fields.add('preparationItems');
  w.rights.admin = false;
  expect((await w.request('GET', path)).status).toBe(403);
  expect((await edit()).status).toBe(403);
  w.rights.admin = true;
  expect((await w.request('DELETE', path, { ifMatch: row.revision })).status).toBe(409);
  expect((await w.request('DELETE', path, { ifMatch: saved.revision })).status).toBe(204);
  expect((await w.request('GET', path)).status).toBe(404);
});

it('AC-EN-BE16-06 A41 独立保存发起催办参数和办理人，范围先于分页且拒绝越权重放', async () => {
  const w = await world('ZZ_BE16_PREP_RULES');
  const outside = await w.session.org('ZZ_BE16_OUTSIDE', { establishedOn: '2026-01-01' });
  const row = await response<Receipt>(await w.create(items, item), 201);
  const body = {
    itemId: row.id,
    name: 'ZZ_BE16_RULE',
    priority: 10,
    orgIds: [w.org.id],
    startDaysBefore: 3,
    remindDaysBefore: 2,
    assignees: [{ kind: 'member', id: w.user }, { kind: 'department_head' }],
  };
  expect((await w.create(rules, { ...body, orgIds: [outside.id] })).status).toBe(404);
  expect((await w.create(rules, { ...body, assignees: [{ kind: 'member', id: randomUUID() }] })).status).toBe(404);
  w.rights.orgs.push(outside.id);
  const hidden = await response<Receipt>(await w.create(rules, { ...body, orgIds: [outside.id] }), 201);
  const key = randomUUID();
  const save = () => w.request('POST', rules, { ifMatch: 0, idempotencyKey: key, body });
  const shown = await response<Receipt>(await save(), 201);
  w.rights.orgs = [w.org.id];
  expect(await response(await w.request('GET', rules + '?pageSize=1'), 200)).toMatchObject({
    items: [{ id: shown.id }],
  });
  expect((await w.request('GET', rules + '/' + hidden.id)).status).toBe(404);
  expect(await response(await w.request('GET', rules + '/' + shown.id), 200)).toMatchObject(body);
  w.rights.orgs = [];
  expect((await save()).status).toBe(404);
  expect(await w.ledger(key)).toHaveLength(1);
  expect((await w.request('GET', '/my/preparations')).status).toBe(404);
  expect((await w.request('POST', '/entries/' + randomUUID() + '/preparations/start')).status).toBe(404);
});
