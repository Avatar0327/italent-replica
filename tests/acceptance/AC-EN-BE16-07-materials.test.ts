import { randomUUID } from 'node:crypto';
import { and, auditEvents, eq, onboardingMaterialItems, sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import type { Authorizer } from '../../apps/api/src/authorization.js';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { addPending, entryAction, entryWorld } from './AC-EN-BE2a-support.js';
import { tenantApi, type RequestOptions } from './support/tenant-api.js';

const testDb = useTestDb();
const settings = MODULE_OBJECTS.employmentSettings.code;
const record = MODULE_OBJECTS.employmentRecord.code;
const material = MODULE_OBJECTS.onboardingMaterial.code;
const now = new Date('2026-10-01T12:00:00Z');

async function world(label: string) {
  const { db } = testDb();
  const w = await entryWorld(db, label);
  const tenant = w.session.tenant.id;
  const user = w.session.user.id;
  const rights = {
    admin: true,
    edit: true,
    material: true,
    settingsOrgs: [w.org.id],
    entryOrgs: [w.org.id],
    materialOrgs: [w.org.id],
    entryFields: new Set(['id', 'materialStatus']),
    materialFields: new Set(['id', 'definitionId', 'status', 'required', 'allowSupplement', 'revision']),
  };
  const authorize: Authorizer = ({ action, resource, fields }) => {
    if (action === 'admin.other_settings' || action === 'tenant.employment.configuration.write') return rights.admin;
    if (resource === settings)
      return (
        (action === 'object.view' || action === 'object.create' || (action === 'object.update' && rights.edit)) &&
        fields?.includes('materialRules') === true
      );
    return action === 'object.view' && (resource === record || (resource === material && rights.material));
  };
  registerScopeProvider(authorize, {
    authorize: async (request) => authorize(request),
    scope: async ({ objectCode }) => {
      const orgIds =
        objectCode === settings
          ? rights.settingsOrgs
          : objectCode === material
            ? rights.materialOrgs
            : rights.entryOrgs;
      return {
        all: false,
        hasDataPermission: orgIds.length > 0,
        orgIds,
        personIds: [],
        terms: [{ dimension: 'organization', orgIds, personIds: [] }],
      };
    },
    fields: async (_tenant, _user, code) =>
      code === settings ? new Set(['materialRules']) : code === material ? rights.materialFields : rights.entryFields,
  });
  const api = tenantApi(db, { authorize, clock: () => now });
  const request = (method: string, path: string, options: RequestOptions = {}) =>
    api.request(method, '/api/tenant' + path, { tenant, user, ...options });
  const rules = '/onboarding/material-rules';
  const list = (id: string) => request('GET', `/onboarding/entries/${id}/materials`);
  const entries = (query = '') => request('GET', '/employment/pending-entries?view=all' + query);
  return { ...w, tenant, rights, request, rules, list, entries };
}

async function json<T>(res: Response, status: number): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await res.json()) as T;
}

type Receipt = { id: string; revision: number; status: string };
type Rule = Receipt & { items: { id: string; name: string; required: boolean; allowSupplement: boolean }[] };
type Item = { id: string; definitionId: string; status: string; required: boolean; allowSupplement: boolean };
const definition = (name: string, required: boolean) => ({ name, required, allowSupplement: true });

it('AC-EN-BE16-07 按 DEC-983 归档并在命令重放时重新检查编辑权和组织范围', async () => {
  const w = await world('ZZ_BE16_MATERIAL_CONFIG');
  const body = { name: 'ZZ_BE16_RULE', orgIds: [w.org.id], priority: 10, items: [definition('ZZ_BE16_ITEM', true)] };
  w.rights.admin = false;
  await json(await w.request('POST', w.rules, { ifMatch: 0, body }), 403);
  w.rights.admin = true;
  await json(await w.request('POST', w.rules, { ifMatch: 0, body: { ...body, remindAfterHire: true } }), 400);
  await json(await w.request('POST', w.rules, { ifMatch: 0, body: { ...body, orgIds: [randomUUID()] } }), 404);
  const created = await json<Receipt>(await w.request('POST', w.rules, { ifMatch: 0, body }), 201);
  await json(await w.request('POST', w.rules, { ifMatch: 0, body }), 409);
  const path = w.rules + '/' + created.id;
  const orgIds = w.rights.settingsOrgs;
  w.rights.settingsOrgs = [];
  expect(await json(await w.request('GET', w.rules), 200)).toEqual({ items: [] });
  await json(await w.request('GET', path), 404);
  await json(await w.request('PATCH', path, { ifMatch: 1, body: { name: 'ZZ_BE16_HIDDEN' } }), 404);
  w.rights.settingsOrgs = orgIds;
  const saved = await json<Receipt>(
    await w.request('PATCH', path, { ifMatch: 1, body: { name: 'ZZ_BE16_UPDATED' } }),
    200,
  );
  await json(await w.request('DELETE', path, { ifMatch: 1 }), 409);
  const commandId = randomUUID();
  const archive = { ifMatch: saved.revision, idempotencyKey: commandId };
  expect((await w.request('DELETE', path, archive)).status).toBe(204);
  expect((await w.request('DELETE', path, archive)).status).toBe(204);
  w.rights.edit = false;
  await json(await w.request('DELETE', path, archive), 403);
  w.rights.edit = true;
  w.rights.settingsOrgs = [];
  await json(await w.request('DELETE', path, archive), 404);
  w.rights.settingsOrgs = orgIds;
  await json(await w.request('GET', path), 404);
  const audit = await withTenant(w.db, w.tenant, (tx) =>
    tx.select().from(auditEvents).where(eq(auditEvents.commandId, commandId)),
  );
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ action: 'onboarding.materialRules.archive', objectId: created.id });
});

it('AC-EN-BE16-07 同一阶段清单取优先规则、冻结定义并投影六态，范围和字段独立裁剪', async () => {
  const w = await world('ZZ_BE16_MATERIAL_LIST');
  const pending = (name: string) => addPending(w, '2026-10-10', name);
  const none = await pending('ZZ_BE16_NO_MATERIALS');
  const base = { name: 'ZZ_BE16_RULE', orgIds: [w.org.id], priority: 20 };
  const optional = await json<Receipt>(
    await w.request('POST', w.rules, { ifMatch: 0, body: { ...base, items: [definition('ZZ_BE16_OPT', false)] } }),
    201,
  );
  const optionalEntry = await pending('ZZ_BE16_NO_REQUIRED');
  const required = await json<Receipt>(
    await w.request('POST', w.rules, {
      ifMatch: 0,
      body: { ...base, priority: 10, items: [definition('ZZ_BE16_FIRST', true), definition('ZZ_BE16_SECOND', true)] },
    }),
    201,
  );
  const target = await pending('ZZ_BE16_REQUIRED');
  const path = w.rules + '/' + required.id;
  const config = await json<Rule>(await w.request('GET', path), 200);
  const status = async (id: string) => {
    const { items } = await json<{ items: { id: string; materialStatus?: string }[] }>(await w.entries(), 200);
    return items.find((item) => item.id === id)?.materialStatus;
  };
  expect(await status(none.recordId)).toBe('no_materials');
  expect(await status(optionalEntry.recordId)).toBe('no_required');
  expect(await status(target.recordId)).toBe('pending');
  const { items } = await json<{ items: Item[] }>(await w.list(target.recordId), 200);
  expect(items).toHaveLength(2);
  expect(items).toEqual(
    config.items.map(({ id }) =>
      expect.objectContaining({ definitionId: id, status: 'pending', required: true, allowSupplement: true }),
    ),
  );

  // 材料办理由 16a-4b 交付。这里经租户事务造真实投影状态。
  async function setStatus(id: string, next: 'submitted' | 'received') {
    await withTenant(w.db, w.tenant, (tx) =>
      tx
        .update(onboardingMaterialItems)
        .set({ status: next, submittedAt: now, receivedAt: next === 'received' ? now : null })
        .where(and(eq(onboardingMaterialItems.tenantId, w.tenant), eq(onboardingMaterialItems.id, id))),
    );
  }
  await setStatus(items[0]!.id, 'submitted');
  expect(await status(target.recordId)).toBe('partial');
  await setStatus(items[1]!.id, 'submitted');
  expect(await status(target.recordId)).toBe('submitted');
  await setStatus(items[0]!.id, 'received');
  await setStatus(items[1]!.id, 'received');
  expect(await status(target.recordId)).toBe('received');
  const filtered = await json<{ items: { id: string }[] }>(
    await w.entries('&materialStatus=received&sortBy=materialStatus&pageSize=1'),
    200,
  );
  expect(filtered.items.map(({ id }) => id)).toEqual([target.recordId]);
  await json(
    await w.request('PATCH', path, {
      ifMatch: config.revision,
      body: { items: config.items.map((item) => ({ ...item, required: false, allowSupplement: false })) },
    }),
    200,
  );
  expect(await status(target.recordId)).toBe('received');
  expect((await w.request('DELETE', w.rules + '/' + optional.id, { ifMatch: 1 })).status).toBe(204);
  expect(await status(optionalEntry.recordId)).toBe('no_required');
  expect((await entryAction(w, target.recordId, 'postpone', { effectiveDate: '2026-10-20' })).status).toBe(200);
  await json(await w.list(target.recordId), 404);
  const { items: moved } = await json<{ items: { id: string; materialStatus?: string }[] }>(await w.entries(), 200);
  const newId = moved.find((item) => item.materialStatus === 'received')!.id;
  expect((await json<{ items: Item[] }>(await w.list(newId), 200)).items.map((item) => item.id)).toEqual(
    items.map((item) => item.id),
  );
  w.rights.materialFields.delete('required');
  const trimmed = await json<{ items: Item[] }>(await w.list(newId), 200);
  expect(trimmed.items[0]).not.toHaveProperty('required');
  expect(await status(newId)).toBeUndefined();
  await json(await w.entries('&materialStatus=received'), 403);
  w.rights.materialFields.add('required');
  w.rights.materialOrgs = [];
  await json(await w.list(newId), 404);
  expect(await status(newId)).toBeUndefined();
  w.rights.materialOrgs = [w.org.id];
  w.rights.entryOrgs = [];
  await json(await w.list(newId), 404);
  expect(await json(await w.list(newId), 404)).toEqual(await json(await w.list(randomUUID()), 404));
  w.rights.entryOrgs = [w.org.id];
  const outside = await world('ZZ_BE16_OTHER_TENANT');
  await json(await outside.list(newId), 404);
  const foreignRows = await withTenant(w.db, outside.tenant, (tx) =>
    tx.execute(sql`SELECT id FROM onboarding_material_items WHERE id = ${items[0]!.id}`),
  );
  expect(Array.isArray(foreignRows) ? foreignRows : (foreignRows as { rows: unknown[] }).rows).toEqual([]);
  w.rights.material = false;
  await json(await w.list(newId), 403);
  expect(await status(newId)).toBeUndefined();
});
