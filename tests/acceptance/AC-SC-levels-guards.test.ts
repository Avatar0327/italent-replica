import { randomUUID } from 'node:crypto';
import { createApp } from '@italent/api';
import { SUCCESSION_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { addMember, createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { levelBody, levelKinds, levelsWorld } from './AC-SC-levels-support.js';
import { allowAll } from './support/tenant-api.js';
const testDb = useTestDb();
describe('AC-SC B2b 字段与请求边界', () => {
  let w: Awaited<ReturnType<typeof levelsWorld>>;
  beforeAll(async () => {
    w = await levelsWorld(testDb().db);
  });
  it.each(levelKinds.flatMap((kind) => ['首次', '直接重放', '失败回查'].map((mode) => ({ kind, mode }))))(
    'AC-SC $kind $mode：真实字段权裁掉规则和名称，撤看全部后拒绝重放',
    async ({ kind, mode }) => {
      const object = SUCCESSION_OBJECTS[kind === 'risk' ? 'riskLevel' : 'healthLevel'];
      const profile = await createProfile(w, `sc-levels-${randomUUID()}`, { apps: ['SuccessionAndDevelopment'] });
      expect(
        (
          await setObjectPermission(
            w,
            profile,
            {
              dataOperations: { create: true, update: true, delete: true },
              fields: object.fields.map((field) => ({
                fieldCode: field.code,
                view: !['name', 'rules', 'compileError'].includes(field.code),
                edit: !field.system,
              })),
              buttons: object.buttons.map((entry) => ({ buttonCode: entry.code, level: entry.level })),
            },
            object.code,
          )
        ).status,
      ).toBe(200);
      await makeGrantable(w, [profile.id]);
      const user = await addMember(w, '合成等级编辑者');
      expect((await grant(w, user.id, profile.id)).status).toBe(201);
      const scopePath = `/api/tenant/permission/profiles/${profile.id}/data-scopes/SuccessionAndDevelopment`;
      const scope = await w.api.request('PUT', scopePath, {
        ...w.asAdmin,
        ifMatch: 0,
        body: { targetKind: 'entity', targetCode: object.code, seeAll: true },
      });
      expect(scope.status).toBe(200);
      const saved = await w.createLevel(kind);
      const path = `/api/tenant/succession/${kind}-levels/${saved.id}`;
      const options = {
        user: user.id,
        tenant: w.tenant.id,
        ifMatch: 1,
        idempotencyKey: randomUUID(),
        body: { color: '#112233' },
      };
      if (mode === '直接重放') expect((await w.api.request('PUT', path, options)).status).toBe(200);
      const transaction = w.db.transaction.bind(w.db);
      let lost = false;
      const spy = vi.spyOn(w.db, 'transaction').mockImplementation(async (callback, config) => {
        const result = await transaction(callback, config);
        if (mode === '失败回查' && !lost && result && typeof result === 'object' && 'status' in result) {
          lost = true;
          throw new Error('合成确认丢失');
        }
        return result;
      });
      try {
        const response = await w.api.request('PUT', path, options);
        expect(response.status, await response.clone().text()).toBe(200);
        const view = await response.json();
        expect(view).toMatchObject({ id: saved.id, color: options.body.color, revision: 2 });
        for (const key of ['name', 'rules', 'compileError', 'compiledFormula']) expect(view).not.toHaveProperty(key);
        expect(lost).toBe(mode === '失败回查');
      } finally {
        spy.mockRestore();
      }
      expect(
        (
          await w.api.request('PUT', scopePath, {
            ...w.asAdmin,
            ifMatch: Number(scope.headers.get('etag')!.replaceAll('"', '')),
            body: { targetKind: 'entity', targetCode: object.code, seeAll: false },
          })
        ).status,
      ).toBe(200);
      expect((await w.api.request('PUT', path, options)).status).toBe(403);
      expect(await (await w.request('GET', `/${kind}-levels/${saved.id}`)).json()).toMatchObject({
        revision: 2,
        rules: saved.rules,
      });
    },
  );
  it.each(levelKinds.flatMap((kind) => ['POST', 'PUT'].map((method) => ({ kind, method }))))(
    'AC-SC $kind $method：规则保存放宽到 64KB，超限仍为 413（DEC-422）',
    async ({ kind, method }) => {
      const app = createApp({ db: w.db, authorize: allowAll, identity: { resolve: () => w.admin.id } });
      const saved = await w.createLevel(kind);
      const path = `/api/tenant/succession/${kind}-levels${method === 'PUT' ? `/${saved.id}` : ''}`;
      const body = JSON.stringify(method === 'POST' ? levelBody(kind) : { name: randomUUID() });
      for (const [size, status] of [
        [40 * 1024, method === 'POST' ? 201 : 200],
        [64 * 1024 + 1, 413],
      ]) {
        const response = await app.request(path, {
          method,
          body: ' '.repeat(size!) + body,
          headers: {
            'content-type': 'application/json',
            'x-tenant-id': w.tenant.id,
            'if-match': method === 'POST' ? '"0"' : '"1"',
            'idempotency-key': randomUUID(),
          },
        });
        expect(response.status, await response.clone().text()).toBe(status);
      }
    },
  );
});
