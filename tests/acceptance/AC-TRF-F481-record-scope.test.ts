/** F-481 S3b 第2轮 P2-1：真实授权器解析管理单元，不注入 scope/personQuery。 */
import { bootstrapTenantAdmin } from '@italent/api';
import { sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { addMember, createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { BASE, RECORD, json, recordsWorld } from './AC-TRF-F481-s3b-support.js';
import { rows, SIGN_AT } from './AC-TRF-F481-s2-support.js';
import { cmd, tenantApi, type RequestOptions } from './support/tenant-api.js';

const database = useTestDb();
it('AC-TRF-F481-12/13①/15/16/19 P2-1：普通 HR 仅有 O1 管理单元，真实解析范围贯穿四个入口', async () => {
  const w = await recordsWorld(database().db, 'real-management');
  const o1 = w.to;
  const o2 = await w.session.org('ZZ_F481_O2', { establishedOn: '2026-01-01' });
  const insideDone = await w.complete(w.task);
  const insidePending = await w.next();
  const outsidePerson = await w.hire('ZZ_F481_EMP_O2');
  const outsideContract = await w.contract(outsidePerson.employee.id);
  const outsideBusiness = await w.saved(
    await w.transfer(outsidePerson, {
      mode: 'direct',
      submit: false,
      fields: { departmentId: o2.id },
      linkage: {
        contract: { targetId: outsideContract.id, fields: { endDate: '2029-10-09' } },
        esign: { templateIds: [w.templates[0]!.id] },
      },
    }),
  );
  const outside = (await w.tasks()).find((t) => t.businessId === outsideBusiness.id)!;
  expect(outside.status).toBe('signing');
  const outsideDone = await w.complete(outside);

  // 被测请求不复用 recordsWorld 的 controlledApi；undefined 选择生产授权器。
  const api = tenantApi(w.db, { authorize: undefined, clock: () => new Date(SIGN_AT) });
  const seed = {
    db: w.db,
    tenant: w.session.tenant,
    admin: w.session.user,
    adminRecord: await bootstrapTenantAdmin(w.db, { tenantId: w.tenantId, userId: w.session.user.id }, cmd()),
    api,
    asAdmin: w.as,
  };
  const hr = await addMember(seed, 'ZZ_F481_HR');
  const profile = await createProfile(seed, 'ZZ_F481_RECORD_HR');
  const definition = MODULE_OBJECTS.eSignRecord;
  expect(
    (
      await setObjectPermission(
        seed,
        profile,
        {
          dataOperations: { create: false, update: false, delete: false },
          fields: definition.fields.map((f) => ({ fieldCode: f.code, view: true, edit: false })),
          buttons: definition.buttons.map((b) => ({ buttonCode: b.code, level: b.level })),
        },
        RECORD,
      )
    ).status,
  ).toBe(200);
  await makeGrantable(seed, [profile.id]);
  expect((await grant(seed, hr.id, profile.id)).status).toBe(201);
  const mou = await json(
    await api.request('POST', '/api/tenant/permission/mous', {
      ...w.as,
      ifMatch: 0,
      body: {
        code: 'ZZ_F481_O1_MOU',
        name: 'ZZ_F481_O1管理单元',
        orgRanges: [{ orgId: o1.id, includeDescendants: false }],
      },
    }),
    201,
  );
  await json(
    await api.request('PUT', `/api/tenant/permission/scopes/${hr.id}/TenantBase`, {
      ...w.as,
      ifMatch: 0,
      body: { kind: 'mou', mouId: mou.id },
    }),
  );
  await withTenant(w.db, w.tenantId, async (tx) => {
    expect(
      rows(
        await tx.execute(sql`SELECT id FROM permission_admins
      WHERE tenant_id=${w.tenantId} AND user_id=${hr.id} AND status='active'`),
      ),
    ).toEqual([]);
    expect(
      rows(
        await tx.execute(sql`SELECT profile_id FROM permission_identity_scopes
      WHERE tenant_id=${w.tenantId} AND profile_id=${profile.id} AND see_all`),
      ),
    ).toEqual([]);
  });
  const call = (method: string, path: string, options: RequestOptions = {}) =>
    api.request(method, `${BASE}${path}`, { ...options, tenant: w.tenantId, user: hr.id });
  const list = await json(await call('GET', '/records'));
  expect.soft(list.total, 'O1 管理单元应返回 2 条签署记录').toBe(2);
  expect.soft(list.items.map((t: { id: string }) => t.id).sort()).toEqual([insideDone.id, insidePending.id].sort());
  const noticesBefore = (await w.notices()).length;
  for (const action of ['remind', 'revoke']) {
    const result = await json(
      await call('POST', `/records/${action}`, {
        body: { items: [insidePending, outsideDone].map(({ id, revision }) => ({ id, revision })) },
      }),
    );
    expect.soft(result.items, `真实管理单元下 ${action} 的逐条回执`).toEqual([
      { id: insidePending.id, ok: true },
      { id: outsideDone.id, ok: false, code: 'NOT_FOUND' },
    ]);
  }
  const tasks = await w.tasks();
  expect.soft(tasks.find((t) => t.id === insidePending.id)?.status).toBe('revoked');
  expect.soft(tasks.find((t) => t.id === outsideDone.id)).toEqual(outsideDone);
  expect.soft((await w.notices()).length - noticesBefore).toBe(3);
  const download = await call('GET', `/records/files?ids=${insideDone.id}`);
  expect.soft(download.status, 'O1 已完成任务可下载').toBe(200);
  expect.soft(download.headers.get('content-type')).toBe('application/pdf');
  expect
    .soft(
      Buffer.from(await download.arrayBuffer())
        .subarray(0, 8)
        .toString(),
    )
    .toBe('%PDF-1.4');
  const denied = await call('GET', `/records/files?ids=${outsideDone.id}`);
  expect(await json(denied, 404)).toMatchObject({ error: { code: 'NOT_FOUND' } });
  expect.soft(await w.exports()).toHaveLength(1);
});
