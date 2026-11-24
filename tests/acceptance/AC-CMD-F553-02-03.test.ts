import { and, eq, offers, tenantMemberships, withTenant } from '@italent/db';
import { buttonResource } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { EMPLOYEE_OBJECT } from '../../apps/api/src/modules/employment/context.js';
import { publishOfferChange } from '../../apps/api/src/modules/offer/source-events.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { SCENES } from './AC-ESIGN-F505-s2-support.js';
import { json } from './AC-TRF-F481-s3a-support.js';
import { uniqueSuffix } from './support/unique.js';
import { expectHidden, resultWorld, SOURCE_OBJECT } from './AC-CMD-F553-support.js';

const db = useTestDb();

it.each([
  ['02', 'offer'],
  ['03', 'entry'],
] as const)('AC-CMD-F553-%s %s 撤销来源编辑权后回查不交出原回执', async (_ac, scene) => {
  const world = await resultWorld(db().db, scene);
  const response = await world.call({
    deny: ({ resource, action }) => resource === SOURCE_OBJECT[scene] && action === 'object.update',
  });
  await expectHidden(response, [403, 404]);
});

describe.each(SCENES)('AC-CMD-F553-02/03 %s 当前授权', (scene) => {
  it('有权时只返回来源和任务 ID，原命令可从 mine 读取最新任务', async () => {
    const w = await resultWorld(db().db, scene);
    const response = await w.call({
      deny: ({ resource }) => resource === 'TenantBase.ESignSettings' || resource === 'TenantBase.ESignRecord',
    });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await json(response)).toEqual(w.receipt);
    const { taskId } = w.receipt;
    const mine = await w.api.request('GET', `/api/tenant/esign/mine/${taskId}`, w.as);
    expect(await json(mine)).toMatchObject({
      id: taskId,
      scene,
      status: 'signing',
      files: [expect.objectContaining({ templateId: w.templateId })],
    });
  });

  it('静态模板的回执仅需要来源授权', async () => {
    const w = await resultWorld(db().db, scene, 'ZZ_F553_静态正文');
    const response = await w.call({
      deny: ({ resource }) => resource === EMPLOYEE_OBJECT,
      scopes: { [EMPLOYEE_OBJECT]: EMPTY_SCOPE },
      fields: { [EMPLOYEE_OBJECT]: [] },
    });
    expect(await json(response)).toEqual(w.receipt);
  });

  it('来源范围、员工范围、历史变量字段以及成员的撤权分别拒绝', async () => {
    const w = await resultWorld(db().db, scene);
    const otherDepartment = await w.session.org('ZZ_F553_范围外部门', { establishedOn: '2026-01-01' });
    const otherScope = {
      ...EMPTY_SCOPE,
      orgIds: [otherDepartment.id],
      terms: [{ dimension: 'organization', orgIds: [otherDepartment.id], personIds: [] }],
      hasDataPermission: true,
    } satisfies ModuleScope;
    await expectHidden(await w.call({ scopes: { [SOURCE_OBJECT[scene]]: otherScope } }), [404]);
    await expectHidden(await w.call({ scopes: { [EMPLOYEE_OBJECT]: otherScope } }), [403]);
    await expectHidden(
      await w.call({ deny: ({ action, resource }) => resource === EMPLOYEE_OBJECT && action === 'object.view' }),
      [403],
    );
    // 先改模板去掉变量，回查仍按任务保存的 name 字段验权。
    await json(
      await w.api.request('PATCH', `/api/tenant/esign/templates/${w.templateId}`, {
        ...w.as,
        ifMatch: 1,
        body: { body: 'ZZ_F553_新版静态模板' },
      }),
    );
    await expectHidden(await w.call({ fields: { [EMPLOYEE_OBJECT]: ['code'] } }), [403]);
    expect(await json(await w.call())).toEqual(w.receipt);
    await withTenant(w.db, w.tenantId, (tx) =>
      tx
        .update(tenantMemberships)
        .set({ status: 'revoked' })
        .where(and(eq(tenantMemberships.tenantId, w.tenantId), eq(tenantMemberships.userId, w.userId))),
    );
    await expectHidden(await w.call(), [403]);
  });
});

it('AC-CMD-F553-03 保留对象编辑权、单独撤销 Employment.Edit 按钮即拒绝', async () => {
  const w = await resultWorld(db().db, 'entry');
  expect(await json(await w.call())).toEqual(w.receipt);
  await expectHidden(
    await w.call({
      deny: ({ action, resource }) =>
        action === 'object.button' && resource === buttonResource(SOURCE_OBJECT.entry, 'Employment.Edit', 'detail'),
    }),
    [403],
  );
});

it.each(['删除', '改期'] as const)('AC-CMD-F553-03 入职来源%s后原命令回查 404', async (action) => {
  const w = await resultWorld(db().db, 'entry');
  expect(await json(await w.call())).toEqual(w.receipt);
  const path = `/pending-entries/${w.sourceId}`;
  const response =
    action === '删除'
      ? await w.session.request('DELETE', path, { ifMatch: w.entry.revision })
      : await w.session.request('POST', `${path}/postpone`, {
          ifMatch: w.entry.revision,
          body: { effectiveDate: '2026-11-20' },
        });
  const source = await json<{ id: string; status: string }>(response);
  if (action === '改期') expect(source.id).not.toBe(w.sourceId);
  else expect(source.status).toBe('deleted');
  await expectHidden(await w.call(), [404]);
});

it('AC-CMD-F553-02 Offer 物理删除后锚点和旧任务保留，回查仍为 404', async () => {
  const w = await resultWorld(db().db, 'offer');
  await withTenant(w.db, w.tenantId, async (tx) => {
    await publishOfferChange(
      tx,
      { ...w.asContext, commandId: uniqueSuffix() },
      { id: w.sourceId, status: 'accepted', revision: 1 },
      null,
      false,
    );
    await tx.delete(offers).where(and(eq(offers.tenantId, w.tenantId), eq(offers.id, w.sourceId)));
  });
  await expectHidden(await w.call(), [404]);
});
