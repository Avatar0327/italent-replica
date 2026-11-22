import { bootstrapTenantAdmin } from '@italent/api';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { contextPath, OFFERS, offerSigningWorld, taskPath } from './AC-ESIGN-F505-S4-support.js';
import { START } from './AC-ESIGN-F505-s2-support.js';
import { addMember, createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const db = useTestDb();

async function json(response: Response, status: number) {
  expect(response.status, await response.clone().text()).toBe(status);
  return response.json();
}

it('FE-01 正式授权器允许 Offer 编辑但隐藏 ID，核对列表动作与真实发起路由', async () => {
  const database = db().db;
  const w = await offerSigningWorld(database, 'S6_ID_CONTRACT');
  const sourceId = await w.offer({ name: 'ZZ_F505_ID_CONTRACT' });
  const pendingId = await w.offer({ name: 'ZZ_F505_PENDING', status: 'pending' });
  await w.offer({ name: 'ZZ_F505_APPROVING', status: 'pending', approvalStatus: 'approving', offerType: 'intern' });
  const template = await w.template();
  const api = tenantApi(database, { authorize: undefined, clock: () => START });
  const adminRecord = await bootstrapTenantAdmin(database, { tenantId: w.tenantId, userId: w.userId }, cmd());
  const seed = {
    db: database,
    tenant: w.session.tenant,
    admin: w.session.user,
    adminRecord,
    api,
    asAdmin: { tenant: w.tenantId, user: w.userId },
  };
  const member = await addMember(seed, 'ZZ_F505_HR');
  const profile = await createProfile(seed, 'ZZ_F505_EDITOR');
  const setFields = (idVisible: boolean) =>
    setObjectPermission(
      seed,
      profile,
      {
        dataOperations: { create: false, update: true, delete: false },
        fields: [
          { fieldCode: 'name', view: true, edit: true },
          { fieldCode: 'status', view: false, edit: false },
          { fieldCode: 'revision', view: false, edit: false },
          { fieldCode: 'id', view: idVisible, edit: false },
        ],
        buttons: [],
      },
      MODULE_OBJECTS.offer.code,
    );
  await json(await setFields(false), 200);
  await makeGrantable(seed, [profile.id]);
  await json(await grant(seed, member.id, profile.id), 201);
  await json(
    await api.request('PUT', `/api/tenant/permission/scopes/${member.id}/TenantBase`, {
      ...seed.asAdmin,
      ifMatch: 0,
      body: { kind: 'org_range', orgRanges: [{ orgId: w.from.id, includeDescendants: false }] },
    }),
    200,
  );

  const as = { tenant: w.tenantId, user: member.id };
  const list = (view = 'accepted') =>
    api.request('GET', `${OFFERS}?view=${view}`, as).then((response) => json(response, 200));
  const {
    items: [row],
  } = await list();
  expect(row.id, '带 sign 的行保留来源 ID').toBe(sourceId);
  expect(row.rowActions.menu).toContain('sign');
  expect(row).not.toHaveProperty('status');
  expect(row).not.toHaveProperty('revision');

  const context = await json(await api.request('GET', contextPath(row.id), as), 200);
  expect(context).toEqual({
    sourceId,
    revision: 1,
    canInitiate: true,
    items: [{ id: template.id, name: template.name }],
  });
  expect(
    await json(
      await api.request('POST', taskPath(row.id), {
        ...as,
        ifMatch: context.revision,
        body: { templateIds: [template.id] },
      }),
      201,
    ),
  ).toEqual({ sourceId, taskId: expect.any(String) });

  const {
    items: [pending],
  } = await list('unsubmitted');
  expect(pending.id).toBe(pendingId);
  expect(pending.rowActions.menu).toEqual(expect.arrayContaining(['edit', 'send']));
  const updated = await json(
    await api.request('PUT', `${OFFERS}/${pending.id}`, {
      ...as,
      ifMatch: 1,
      body: { name: 'ZZ_F505_UPDATED' },
    }),
    200,
  );
  expect(updated).toMatchObject({ name: 'ZZ_F505_UPDATED' });
  expect(updated).not.toHaveProperty('id');
  expect(updated).not.toHaveProperty('revision');

  const {
    items: [withoutActions],
  } = await list('approving');
  expect(withoutActions).toEqual({
    name: 'ZZ_F505_APPROVING',
    rowActions: { primary: [], menu: [] },
  });
  await json(await setFields(true), 200);
  const {
    items: [withVisibleId],
  } = await list('approving');
  expect(withVisibleId.id).toEqual(expect.any(String));
});
