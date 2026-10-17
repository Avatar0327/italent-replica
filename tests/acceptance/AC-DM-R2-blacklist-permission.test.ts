/**
 * AC-DM-R2（黑名单权限，真实授权器）：黑名单对象 TenantBase.Blacklist 没有组织字段，数据范围只认“看全部”；
 * DEC-415：新对象的看全部默认给组织员工的预置管理员（标准版系统管理员、人事管理员）；人事专员有对象权限但不预置
 * 看全部（给非管理员扩大范围须逐次问用户），所以列表为空、写入被拒。证件号 / 手机号 / 邮箱按字段查看权裁剪。
 */
import { randomUUID } from 'node:crypto';
import { grantMembership } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { newUser, provisioned, type ProvisionResult, seedOperator } from './support/platform-api.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const CLOCK = () => new Date('2026-10-01T04:00:00Z');
type As = { user: string; tenant: string };

describe('AC-DM-R2 黑名单权限（标准身份预置）', () => {
  let api: ReturnType<typeof tenantApi>;
  let result: ProvisionResult;
  let asAdmin: As;
  let asHr: As;
  let asSpecialist: As;
  let asStranger: As;
  let asNoIdentity: As;

  const call = (as: As, method: string, path: string, body?: unknown, ifMatch?: number) =>
    api.request(method, `/api/tenant/employment${path}`, { ...as, body, ifMatch });

  beforeAll(async () => {
    const { db } = testDb();
    api = tenantApi(db, { authorize: undefined, clock: CLOCK });
    const operator = await seedOperator(db);
    const admin = await newUser(db, 'bl-admin');
    result = await provisioned(api, operator, { firstAdminUserId: admin.id, exceptionAdminUserId: admin.id });
    asAdmin = { user: admin.id, tenant: result.tenant.id };
    const member = async (label: string) => {
      const user = await newUser(db, label);
      await grantMembership(db, { tenantId: result.tenant.id, userId: user.id, expectedRevision: 0 }, cmd());
      return { user: user.id, tenant: result.tenant.id };
    };
    const grantProfile = async (as: As, code: string) => {
      const profile = result.profiles.find((p) => p.code === code)!;
      const granted = await api.request('POST', '/api/tenant/permission/grants', {
        ...asAdmin,
        body: { userId: as.user, profileId: profile.id },
      });
      expect(granted.status, await granted.clone().text()).toBe(201);
    };
    asHr = await member('bl-hr');
    asSpecialist = await member('bl-specialist');
    asStranger = await member('bl-stranger');
    asNoIdentity = await member('bl-no-identity');
    await grantProfile(asHr, 'standard_hr_admin');
    await grantProfile(asSpecialist, 'standard_hr_specialist');
    // 只有任职记录查看权、没有黑名单对象的身份
    await grantProfile(asStranger, 'standard_manager');
  });

  it('对象登记：字段含证件号 / 手机号 / 邮箱，按钮 新增 / 编辑 / 移出 / 删除', () => {
    const object = MODULE_OBJECTS.blacklist;
    expect(object.code).toBe('TenantBase.Blacklist');
    expect(object.fields.map((f) => f.code)).toEqual(
      expect.arrayContaining(['name', 'idNumber', 'mobilePhone', 'email', 'reason', 'expiryDate', 'note']),
    );
    expect(object.buttons.map((b) => `${b.code}@${b.level}`).sort()).toEqual([
      'create@list',
      'delete@list',
      'remove@list',
      'update@list_row',
    ]);
  });

  it('标准版系统管理员与人事管理员预置看全部：可新增、可见全部；人事专员列表为空且写入被拒', async () => {
    const created = await call(
      asAdmin,
      'POST',
      '/blacklist',
      { name: '权限对象', mobilePhone: '13800000060', reason: 'other' },
      0,
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const entry = (await created.json()) as { id: string };
    for (const as of [asAdmin, asHr]) {
      const listed = await call(as, 'GET', '/blacklist');
      expect(listed.status, await listed.clone().text()).toBe(200);
      const page = (await listed.json()) as {
        items: { id: string; mobilePhone?: string }[];
        hasDataPermission: boolean;
      };
      expect(page).toMatchObject({ hasDataPermission: true, items: [{ id: entry.id, mobilePhone: '13800000060' }] });
    }
    const specialist = await call(asSpecialist, 'GET', '/blacklist');
    expect(specialist.status).toBe(200);
    expect(await specialist.json()).toMatchObject({ items: [], hasDataPermission: false });
    const denied = await call(
      asSpecialist,
      'POST',
      '/blacklist',
      { name: '专员新增', mobilePhone: '13800000061', reason: 'other' },
      0,
    );
    expect(denied.status).toBe(403);
    expect((await call(asSpecialist, 'PUT', `/blacklist/${entry.id}`, { note: '专员编辑' }, 1)).status).toBe(404);
    expect(
      (await call(asSpecialist, 'POST', '/blacklist/remove', { items: [{ id: entry.id, revision: 1 }] })).status,
    ).toBe(404);
  });

  it('选人员加黑：员工不在操作人的任职数据范围内与员工不存在同一个 404，不写入', async () => {
    const fixture = tenantApi(testDb().db, { clock: CLOCK });
    const created = await fixture.request('POST', '/api/tenant/employment/employees', {
      ...asAdmin,
      ifMatch: 0,
      body: { name: '范围外员工', code: `BL_${randomUUID()}` },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const missing = '00000000-0000-4000-8000-000000000000';
    for (const employeeId of [id, missing]) {
      const response = await call(asHr, 'POST', '/blacklist', { employeeId, reason: 'other' }, 0);
      expect(response.status).toBe(404);
      expect(((await response.json()) as { error: { message: string } }).error.message).toBe('员工不存在');
    }
    const listed = (await (await call(asHr, 'GET', '/blacklist')).json()) as { items: { employeeId: string }[] };
    expect(listed.items.map((item) => item.employeeId)).not.toContain(id);
  });

  it('没有黑名单对象权限：读写 403', async () => {
    for (const as of [asStranger, asNoIdentity]) {
      expect((await call(as, 'GET', '/blacklist')).status).toBe(403);
      const body = { name: '无权', mobilePhone: '13800000062', reason: 'other' };
      expect((await call(as, 'POST', '/blacklist', body, 0)).status).toBe(403);
    }
  });

  it('自动加黑规则是任职设置配置：管理员可读写，人事专员 403', async () => {
    expect((await call(asAdmin, 'GET', '/blacklist-rules')).status).toBe(200);
    expect((await call(asSpecialist, 'GET', '/blacklist-rules')).status).toBe(403);
  });
});
