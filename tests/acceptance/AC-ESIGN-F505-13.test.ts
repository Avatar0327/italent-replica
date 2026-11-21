import { randomUUID } from 'node:crypto';
import { bootstrapTenantAdmin } from '@italent/api';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { addMember, createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { controlledApi } from './AC-LNK-support.js';
import { json } from './AC-TRF-F481-s3a-support.js';
import { zipNames } from './AC-TRF-F481-s3b-support.js';
import { ESIGN, SCENES, START, sharedWorld, type Task } from './AC-ESIGN-F505-s2-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const db = useTestDb();
const definition = MODULE_OBJECTS.eSignRecord;
const fields = definition.fields.map(({ code }) => code);
const list = `${ESIGN}/records`;
const download = (ids: string[]) => `${list}/files?ids=${ids.join(',')}`;
type Listed = { items: { id: string; scene: string }[]; total: number };

it('AC-13 三场景记录、本人文件范围及有文件权无所有者权的 ZIP 命名', async () => {
  const w = await sharedWorld(db().db, 'files');
  const template = await w.template();
  const ids: string[] = [];
  for (const scene of SCENES) {
    const task = await w.fixture(scene, template);
    const ready = await json<Task>(await w.sign(w.employeeUser, task));
    await json(await w.sign(w.userId, ready));
    ids.push(task.id);
  }
  const transfer = await w.transferFixture(template);
  const ready = await json<Task>(await w.sign(w.employeeUser, transfer));
  await json(await w.sign(w.userId, ready));
  const rows = await json<Listed>(await w.call('GET', list));
  expect(rows.total).toBe(3);
  expect(rows.items.map((task) => task.scene).sort()).toEqual(['entry', 'offer', 'transfer']);
  const mine = await json<Listed>(await w.call('GET', '/mine?tab=done', { user: w.employeeUser }));
  expect(mine.items.map((task) => task.scene).sort()).toEqual(['entry', 'offer', 'transfer']);
  const call = (excluded: string) =>
    controlledApi(
      w.db,
      w.tenantId,
      w.userId,
      {
        fields: { [definition.code]: fields.filter((field) => field !== excluded) },
      },
      START.toISOString(),
    );
  const noFiles = call('files');
  const trimmed = await json<Listed>(await noFiles('GET', list));
  expect(trimmed.items).toHaveLength(3);
  for (const row of trimmed.items) expect(row).not.toHaveProperty('files');
  expect(JSON.stringify(trimmed)).not.toContain(template.name);
  const forbidden = await json(await noFiles('GET', download(ids)), 403);
  expect(forbidden).toMatchObject({ error: { code: 'FIELD_FORBIDDEN' } });
  expect(JSON.stringify(forbidden)).not.toContain(template.name);

  const zip = await call('owner')('GET', download(ids));
  expect(zip.headers.get('content-type')).toBe('application/zip');
  expect(zipNames(Buffer.from(await zip.arrayBuffer()))).toEqual(
    ids.map((id) => `${id.slice(0, 8)}_${template.name}.pdf`),
  );
  const outsider = await w.member();
  for (const id of ids) {
    const path = `/mine/${id}/files`;
    expect((await w.call('GET', path, { user: w.employeeUser })).headers.get('content-type')).toBe('application/pdf');
    const hidden = await json(await w.call('GET', path, { user: outsider.user.id }), 404);
    expect(await json(await w.call('GET', path, { tenant: outsider.tenant.id, user: outsider.user.id }), 404)).toEqual(
      hidden,
    );
    expect(await json(await w.call('GET', `/mine/${randomUUID()}/files`), 404)).toEqual(hidden);
  }
});

it('AC-13 普通 HR 的真实管理单元范围覆盖 Offer，混入范围外入职文件整批返回同一 404', async () => {
  const w = await sharedWorld(db().db, 'mou');
  const selected = await w.template();
  const inside = await w.fixture('offer', selected);
  const outside = await w.fixture('entry', selected, false, await w.hire('ZZ_F505_EMP_OUTSIDE', w.to.id));
  for (const task of [inside, outside]) {
    const next = await json<Task>(await w.sign(task.employeeSignerUserId!, task));
    await json(await w.sign(w.userId, next));
  }
  const api = tenantApi(w.db, { authorize: undefined, clock: () => START });
  const world = {
    db: w.db,
    tenant: w.session.tenant,
    admin: w.session.user,
    api,
    asAdmin: w.as,
    adminRecord: await bootstrapTenantAdmin(w.db, { tenantId: w.tenantId, userId: w.userId }, cmd()),
  };
  const hr = await addMember(world, 'ZZ_F505_HR');
  const profile = await createProfile(world, 'ZZ_F505_ESIGN_HR');
  expect(
    (
      await setObjectPermission(
        world,
        profile,
        {
          dataOperations: { create: false, update: false, delete: false },
          fields: fields.map((fieldCode) => ({ fieldCode, view: true, edit: false })),
          buttons: definition.buttons.map(({ code: buttonCode, level }) => ({ buttonCode, level })),
        },
        definition.code,
      )
    ).status,
  ).toBe(200);
  await makeGrantable(world, [profile.id]);
  expect((await grant(world, hr.id, profile.id)).status).toBe(201);
  const mou = await json<{ id: string }>(
    await api.request('POST', '/api/tenant/permission/mous', {
      ...w.as,
      ifMatch: 0,
      body: {
        code: 'ZZ_F505_MOU',
        name: 'ZZ_F505_管理单元',
        orgRanges: [{ orgId: w.from.id, includeDescendants: false }],
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
  const get = (path: string) => api.request('GET', path, { tenant: w.tenantId, user: hr.id });
  expect(await json<Listed>(await get(list))).toMatchObject({ total: 1, items: [{ id: inside.id, scene: 'offer' }] });
  expect((await get(download([inside.id]))).headers.get('content-type')).toBe('application/pdf');
  const invisible = await json(await get(download([outside.id])), 404);
  expect(await json(await get(download([inside.id, outside.id])), 404)).toEqual(invisible);
  expect(await json(await get(download([inside.id, randomUUID()])), 404)).toEqual(invisible);
});
