/** B6b：真实授权器下复制按钮、对象权、范围与重放；DEC-436。 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { createOrg } from './AC-IDP-support.js';
import { seedPermissionWorld } from './AC-PRM-support.js';
import { templateBody, templateOperator, TR_BASE, TR_NOW, type TemplateView } from './AC-TR-template-support.js';
import { configBody } from './AC-TR-config-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
describe('AC-TR-template-copy 权限', () => {
  it('无对象 / copy 按钮 403、范围外 404；成功重放不新增，撤按钮或范围后不返回旧结果', async () => {
    const base = await seedPermissionWorld(testDb().db);
    const clock = () => TR_NOW;
    const setup = tenantApi(base.db, { clock });
    const world = { ...base, api: tenantApi(base.db, { authorize: undefined, clock }) };
    const orgId = await createOrg(setup, base.asAdmin, '复制范围');
    const post = await setup.request('POST', `${TR_BASE}/templates`, {
      ...base.asAdmin,
      ifMatch: 0,
      body: templateBody(orgId),
    });
    expect(post.status).toBe(201);
    const t = (await post.json()) as TemplateView;
    const list = async () => await (await setup.request('GET', `${TR_BASE}/templates`, base.asAdmin)).json();
    const before = await list();
    const denied = await templateOperator(world, { orgId, view: false });
    const noButton = await templateOperator(world, { orgId, omitButtons: ['copy'] });
    const outside = await templateOperator(world);
    for (const [operator, status] of [
      [denied, 403],
      [noButton, 403],
      [outside, 404],
    ] as const) {
      const response = await operator.request('POST', `/templates/${t.id}/copy`, {
        ifMatch: t.revision,
        body: { name: '无权复制' },
      });
      expect(response.status, await response.clone().text()).toBe(status);
      expect(await list()).toEqual(before);
    }
    const writer = await templateOperator(world, { orgId });
    const copy = () =>
      writer.request('POST', `/templates/${t.id}/copy`, {
        ifMatch: t.revision,
        idempotencyKey: 'copy-permissions',
        body: { name: '允许复制' },
      });
    const created = await copy();
    expect(created.status, await created.clone().text()).toBe(201);
    const view = await created.json();
    expect(await (await copy()).json()).toEqual(view);
    const after = await list();
    await writer.setButtons(true, ['copy']);
    expect((await copy()).status).toBe(403);
    await writer.setButtons(true);
    await writer.setOrg(null);
    expect((await copy()).status).toBe(404);
    expect(await list()).toEqual(after);
    for (const [method, body] of [
      ['PATCH', { enabled: false }],
      ['DELETE', undefined],
    ] as const) {
      expect((await denied.request(method, `/templates/${t.id}`, { ifMatch: t.revision, body })).status).toBe(403);
    }
    expect(await list()).toEqual(after);
  });
});

it('AC-TR-template-copy：原件清空模块后重放仍校验复制回执持有的目录引用', async () => {
  const base = await seedPermissionWorld(testDb().db);
  const clock = () => TR_NOW;
  const setup = tenantApi(base.db, { clock });
  const world = { ...base, api: tenantApi(base.db, { authorize: undefined, clock }) };
  const orgId = await createOrg(setup, base.asAdmin, '复制重放目录');
  const post = async (path: string, body: unknown) => {
    const response = await setup.request('POST', `${TR_BASE}${path}`, { ...base.asAdmin, ifMatch: 0, body });
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string; revision: number };
  };
  const field = await post('/fields', configBody('field'));
  const source = await post(
    '/templates',
    templateBody(orgId, {
      modules: [{ kind: 'info', name: '信息', fieldIds: [field.id] }],
    }),
  );
  const writer = await templateOperator(world, { orgId, references: 'seeAll' });
  const copy = () =>
    writer.request('POST', `/templates/${source.id}/copy`, {
      ifMatch: source.revision,
      idempotencyKey: 'copy-receipt-refs',
      body: { name: '保留引用的复制件' },
    });
  const created = await copy();
  expect(created.status).toBe(201);
  const duplicate = (await created.json()) as TemplateView;
  const before = await (await setup.request('GET', `${TR_BASE}/templates/${duplicate.id}`, base.asAdmin)).json();
  expect(
    (
      await setup.request('PATCH', `${TR_BASE}/templates/${source.id}`, {
        ...base.asAdmin,
        ifMatch: source.revision,
        body: { modules: [] },
      })
    ).status,
  ).toBe(200);
  await writer.setSeeAll('field', false);
  const denied = await copy();
  expect(denied.status, await denied.clone().text()).toBe(404);
  const after = await setup.request('GET', `${TR_BASE}/templates/${duplicate.id}`, base.asAdmin);
  expect(await after.json()).toEqual(before);
});
