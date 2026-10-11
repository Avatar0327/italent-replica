/** B6b：真实授权器下复制按钮、对象权、范围与重放；DEC-436。 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { createOrg } from './AC-IDP-support.js';
import { seedPermissionWorld } from './AC-PRM-support.js';
import { templateBody, templateOperator, TR_BASE, TR_NOW, type TemplateView } from './AC-TR-template-support.js';
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
