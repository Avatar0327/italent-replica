import { randomUUID } from 'node:crypto';
import { eq, permissionProfileButtons, permissionProfileObjects, seedGrantLedger, withTenant } from '@italent/db';
import { EMPLOYEE_SELF_SERVICE_CODE, objectCatalogDigest, QUALIFICATION_PAGES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { employeePageGranted } from '../../apps/api/src/modules/employee-self-service/page-permission.js';
import { approvalWorld, permissionAdmin } from './AC-APV-support.js';
import {
  addMember,
  BASE,
  createProfile,
  grant,
  makeGrantable,
  type PermissionWorld,
  type ProfileBody,
} from './AC-PRM-support.js';
import { provisionWorld, runBackfill, ledger } from './support/f061.js';
import { profileMenuGroups } from '../../apps/web/src/settings/page-permission-model.js';
import type { ProfileDetail } from '../../apps/web/src/settings/object-dialog-model.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const carrier = 'Qualification.Pages';
const button = { buttonCode: 'EmployeeDevelopmentChannel', level: 'app_page' };
const body = (buttons = [button]) => ({
  fields: [],
  buttons,
  dataOperations: { create: false, update: false, delete: false },
  catalogDigest: objectCatalogDigest(QUALIFICATION_PAGES),
});
const path = (p: ProfileBody) => `${BASE}/profiles/${p.id}`;
const objectPath = (p: ProfileBody) => `${path(p)}/objects/${carrier}`;
type Detail = ProfileBody & { apps: string[]; objects: { objectCode: string; buttons: (typeof button)[] }[] };
let admin: PermissionWorld;
let employee: ProfileBody;
let userId: string;
const read = async (p: ProfileBody) => {
  const r = await admin.api.request('GET', path(p), admin.asAdmin);
  expect(r.status).toBe(200);
  const detail = (await r.json()) as Detail;
  expect(r.headers.get('etag')).toBe(`"${detail.revision}"`);
  return detail;
};
const put = (p: ProfileBody, input: unknown, revision = p.revision, tail = '') =>
  admin.api.request('PUT', objectPath(p) + tail, { ...admin.asAdmin, ifMatch: revision, body: input });
const newProfile = () => createProfile(admin, `PGP-${uniqueSuffix()}`, { apps: ['Qualification'] });
const granted = () =>
  withTenant(admin.db, admin.tenant.id, (tx) =>
    employeePageGranted(tx, { tenantId: admin.tenant.id, userId }, 'EmployeeDevelopmentChannel'),
  );
const state = (p: ProfileBody) =>
  withTenant(admin.db, admin.tenant.id, async (tx) => ({
    buttons: await tx.select().from(permissionProfileButtons).where(eq(permissionProfileButtons.profileId, p.id)),
    objects: await tx.select().from(permissionProfileObjects).where(eq(permissionProfileObjects.profileId, p.id)),
    ledger: await tx.select().from(seedGrantLedger),
  }));

beforeAll(async () => {
  const world = await approvalWorld(database().db, 'pgp-f474');
  admin = await permissionAdmin(world);
  const department = await world.org('合成部门');
  userId = (await world.person('合成员工', department)).userId;
  employee = await createProfile(admin, EMPLOYEE_SELF_SERVICE_CODE, { apps: ['Qualification'] });
});

describe('AC-PGP-F474 页面权限真实 HTTP 与页面闸门', () => {
  it('AC-PGP-F474-08 员工缺载体默认授予，首次固化保留选择，显式清空后拒绝', async () => {
    expect((await read(employee)).objects).toEqual([]);
    expect(await granted()).toBe(true);
    expect((await put(employee, body())).status).toBe(200);
    expect(await granted()).toBe(true);
    employee = await read(employee);
    expect((await put(employee, body([]))).status).toBe(200);
    employee = await read(employee);
    expect(await granted()).toBe(false);
  });
  it('AC-PGP-F474-05～06 首次载体新增与删除，持有人即时生效，保留载体且不授业务对象', async () => {
    const p = await newProfile();
    await makeGrantable(admin, [p.id]);
    expect((await grant(admin, userId, p.id)).status).toBe(201);
    expect(await granted()).toBe(false);
    const before = await read(p);
    expect((await put(before, body())).status).toBe(200);
    expect(await granted()).toBe(true);
    const saved = await read(p);
    expect(saved.objects.map((o) => o.objectCode)).toEqual([carrier]);
    expect((await state(p)).buttons).toMatchObject([{ buttonCode: button.buttonCode, level: 'app_page' }]);
    expect((await put(saved, body([]))).status).toBe(200);
    expect(await granted()).toBe(false);
    const removed = await state(p);
    expect(removed.buttons).toEqual([]);
    expect(removed.objects).toHaveLength(1);
    const response = await admin.api.request('GET', '/api/tenant/self-service/development-channel', {
      tenant: admin.tenant.id,
      user: userId,
    });
    expect(response.status).toBe(403);
    const error = await response.json();
    expect(error.error.details).toEqual({
      reason: 'PAGE_PERMISSION_REQUIRED',
      app: 'Qualification',
      page: 'EmployeeDevelopmentChannel',
    });
    expect(JSON.stringify(error)).not.toContain(p.code);
    expect(JSON.stringify(error)).not.toContain(EMPLOYEE_SELF_SERVICE_CODE);
  });
  it.each(['create', 'update', 'delete'])('AC-PGP-F474-07 载体整对象及数据弹窗都拒绝 %s', async (operation) => {
    const p = await newProfile();
    expect((await put(p, body([]))).status).toBe(200);
    const current = await read(p);
    const before = await state(p);
    const input = { ...body(), dataOperations: { ...body().dataOperations, [operation]: true } };
    for (const tail of ['', '/data-operations']) {
      const response = await put(
        current,
        tail ? { dataOperations: input.dataOperations } : input,
        current.revision,
        tail,
      );
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('VALIDATION_FAILED');
    }
    expect(await read(p)).toEqual(current);
    expect(await state(p)).toEqual(before);
  });
  it('AC-PGP-F474-07 载体字段和错误层级被拒', async () => {
    const p = await newProfile();
    for (const patch of [
      { fields: [{ fieldCode: 'Name', view: true, edit: false }] },
      { buttons: [{ ...button, level: 'detail' }] },
    ])
      expect((await put(p, { ...body(), ...patch })).status).toBe(400);
    expect((await read(p)).objects).toEqual([]);
  });
  it.each([false, true])('AC-PGP-F474-09 目录过期（已有载体 %s）与 revision 冲突不改权限及台账', async (exists) => {
    const p = await newProfile();
    if (exists) expect((await put(p, body())).status).toBe(200);
    const current = await read(p);
    const before = await state(p);
    const catalog = await put(current, { ...body([]), catalogDigest: '0000000000000000' });
    expect(catalog.status).toBe(409);
    expect((await catalog.json()).error.code).toBe('CATALOG_CHANGED');
    const stale = await put(current, body([]), current.revision + 1);
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe('REVISION_CONFLICT');
    expect(await read(p)).toEqual(current);
    expect(await state(p)).toEqual(before);
  });
  it('AC-PGP-F474-09 必需请求头、严格 body、同键重放与异内容冲突', async () => {
    const p = await newProfile();
    for (const extra of [
      { body: { ...body(), expectedRevision: p.revision }, ifMatch: p.revision },
      { body: body() },
      { body: body(), ifMatch: p.revision, idempotencyKey: null },
    ])
      expect((await admin.api.request('PUT', objectPath(p), { ...admin.asAdmin, ...extra })).status).toBe(400);
    const request = { ...admin.asAdmin, ifMatch: p.revision, body: body(), idempotencyKey: randomUUID() };
    const first = await admin.api.request('PUT', objectPath(p), request);
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    const before = await state(p);
    expect(await (await admin.api.request('PUT', objectPath(p), request)).json()).toEqual(firstBody);
    expect(await state(p)).toEqual(before);
    expect((await admin.api.request('PUT', objectPath(p), { ...request, body: body([]) })).status).toBe(409);
  });
  it('AC-PGP-F474-10 缺应用保存拒绝，应用未被静默加入', async () => {
    const p = await createProfile(admin, `NoApp-${uniqueSuffix()}`);
    expect((await put(p, body())).status).toBe(400);
    expect((await read(p)).apps).toEqual(['TenantBase']);
    expect((await read(p)).objects).toEqual([]);
  });
  it('AC-PGP-F474-04、12 无 profile_manage 403，跨租户读写 404', async () => {
    const p = await newProfile();
    for (const method of ['GET', 'PUT']) {
      const response = await admin.api.request(method, method === 'GET' ? path(p) : objectPath(p), {
        tenant: admin.tenant.id,
        user: userId,
        ...(method === 'PUT' ? { ifMatch: p.revision, body: body() } : {}),
      });
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(p.code);
    }
    const other = await approvalWorld(database().db, 'pgp-other');
    const otherAdmin = await permissionAdmin(other);
    expect((await otherAdmin.api.request('GET', path(p), otherAdmin.asAdmin)).status).toBe(404);
    expect(
      (
        await otherAdmin.api.request('PUT', objectPath(p), {
          ...otherAdmin.asAdmin,
          ifMatch: p.revision,
          body: body(),
        })
      ).status,
    ).toBe(404);
    expect((await read(p)).objects).toEqual([]);
  });
  it('AC-PGP-F474-06 预置员工删除后补装两次仍为空，modified 台账保留', async () => {
    const w = await provisionWorld(database().db, 'pgp-backfill');
    const id = w.profileIds.get(EMPLOYEE_SELF_SERVICE_CODE)!;
    const detail = await (await w.api.request('GET', `${BASE}/profiles/${id}`, w.asAdmin)).json();
    expect(
      (
        await w.api.request('PUT', `${BASE}/profiles/${id}/objects/${carrier}`, {
          ...w.asAdmin,
          ifMatch: detail.revision,
          body: body([]),
        })
      ).status,
    ).toBe(200);
    expect([...(await ledger(w)).keys()]).toContain(`${EMPLOYEE_SELF_SERVICE_CODE}/${carrier}/@modified`);
    for (let i = 0; i < 2; i++) {
      await runBackfill(w);
      const latest = (await (await w.api.request('GET', `${BASE}/profiles/${id}`, w.asAdmin)).json()) as Detail;
      expect(latest.objects.find((o) => o.objectCode === carrier)?.buttons).toEqual([]);
    }
  });
  it('AC-PGP-F474-11 菜单组与真实 me-snapshot 入口集合一致，撤销对象查看后同时消失', async () => {
    const p = await newProfile();
    expect((await put(p, body())).status).toBe(200);
    const holder = await addMember(admin, '合成菜单用户');
    await makeGrantable(admin, [p.id]);
    expect((await grant(admin, holder.id, p.id)).status).toBe(201);
    const snapshot = async () => {
      const response = await admin.api.request('GET', `${BASE}/me/snapshot`, {
        tenant: admin.tenant.id,
        user: holder.id,
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as { apps: { app: string; entryObjects: string[] }[] };
      return result.apps.find((a) => a.app === 'qualification')!.entryObjects;
    };
    const detail = (await (await admin.api.request('GET', path(p), admin.asAdmin)).json()) as ProfileDetail;
    expect(profileMenuGroups(detail)[0]!.objects).toEqual(await snapshot());
    expect(await snapshot()).toEqual([carrier]);
    await withTenant(admin.db, admin.tenant.id, (tx) =>
      tx.delete(permissionProfileObjects).where(eq(permissionProfileObjects.profileId, p.id)),
    );
    const removed = (await (await admin.api.request('GET', path(p), admin.asAdmin)).json()) as ProfileDetail;
    expect(profileMenuGroups(removed)[0]!.objects).toEqual([]);
    expect(await snapshot()).toEqual([]);
  });
});
