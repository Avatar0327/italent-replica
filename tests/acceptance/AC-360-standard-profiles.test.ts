/**
 * R3-T03 基础契约（拆自 #107，DEC-297③ / DEC-309②）：360 标准身份的安装与平台回补。
 * - DEC-280①：开通租户即下发三类内置 360 身份（应用 Survey360）；按钮差别：全部活动、编辑他人套卷、精细化权限只给
 *   系统管理员，一般管理员另无同步；由企业管理员在“用户授权”里授予后生效。
 * - DEC-289③：存量租户回补只补缺失编码；执行两次结果不变；租户手工建过同编码身份保留不动并标 CODE_TAKEN；只认平台
 *   运营身份（租户管理员 403），租户不存在 404；同一命令 ID 重放返回原结果，平台运营身份撤销后再重放 403。
 * 本段不含 360 业务路由：授出是否生效用权限模块的“本人对象权限”接口验证（360 路由的功能权限也按它判定）。
 */
import { randomUUID } from 'node:crypto';
import { bootstrapTenantAdmin } from '@italent/api';
import { createUser, grantMembership, revokePlatformOperator } from '@italent/db';
import { survey360 } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { newUser, PLATFORM, provisioned, seedOperator } from './support/platform-api.js';
import { cmd, seedTenantWithMember, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const { activity, questionnaire, person, settings } = survey360.SURVEY360_OBJECTS;

type Api = ReturnType<typeof tenantApi>;
interface Caller {
  readonly user: string;
  readonly tenant: string;
}
interface ProfileItem {
  id: string;
  code: string;
  apps: string[];
}
interface BackfillResult {
  installed: string[];
  skipped: { code: string; reason: string }[];
}

async function profiles(api: Api, as: Caller): Promise<ProfileItem[]> {
  const listed = await api.request('GET', '/api/tenant/permission/profiles', as);
  expect(listed.status).toBe(200);
  return ((await listed.json()) as { items: ProfileItem[] }).items;
}

/** 本人在该对象上可执行的按钮编码；没有该对象的功能权限时返回状态码。 */
async function buttons(api: Api, as: Caller, objectCode: string): Promise<string[] | number> {
  const res = await api.request('GET', `/api/tenant/permission/me/objects/${objectCode}`, as);
  if (res.status !== 200) return res.status;
  return ((await res.json()) as { buttons: { buttonCode: string }[] }).buttons.map((b) => b.buttonCode).sort();
}

/** 企业管理员把某个身份授给一名新成员，返回该成员的调用身份。 */
async function holderOf(api: Api, admin: Caller, profileId: string, label: string): Promise<Caller> {
  const { db } = testDb();
  const user = await createUser(db, { email: `${label}-${randomUUID()}@example.com`, displayName: label }, cmd());
  await grantMembership(db, { tenantId: admin.tenant, userId: user.id, expectedRevision: 0 }, cmd());
  const granted = await api.request('POST', '/api/tenant/permission/grants', {
    ...admin,
    body: { userId: user.id, profileId },
  });
  expect(granted.status, await granted.clone().text()).toBe(201);
  return { user: user.id, tenant: admin.tenant };
}

describe('DEC-280① 三类内置 360 身份随开通下发，由企业管理员在用户授权里授予', () => {
  it('开通即有三个 360 标准身份（应用 Survey360）；按钮差别只在全部活动、编辑他人套卷、精细化权限与同步', async () => {
    const { db } = testDb();
    const api = tenantApi(db, { authorize: undefined });
    const operator = await seedOperator(db, 'ops-360-std');
    const admin = await newUser(db, 'first-admin-360-std');
    const exception = await newUser(db, 'exception-admin-360-std');
    const result = await provisioned(api, operator, {
      firstAdminUserId: admin.id,
      exceptionAdminUserId: exception.id,
      licenses: [{ licenseType: 'core_hr', quota: 10 }],
    });
    const asAdmin = { user: admin.id, tenant: result.tenant.id };
    const items = await profiles(api, asAdmin);
    const of = (code: string) => items.find((p) => p.code === code)!;
    for (const code of ['standard_360_system_admin', 'standard_360_advanced_admin', 'standard_360_general_admin'])
      expect(of(code).apps).toEqual([survey360.SURVEY360_APP]);

    // 首位租户管理员没有 360 身份：360 对象没有功能权限，360 身份要另行授予
    expect(await buttons(api, asAdmin, activity.code)).toBe(403);

    const system = await holderOf(api, asAdmin, of('standard_360_system_admin').id, 'sys-360-std');
    const advanced = await holderOf(api, asAdmin, of('standard_360_advanced_admin').id, 'adv-360-std');
    const general = await holderOf(api, asAdmin, of('standard_360_general_admin').id, 'gen-360-std');
    expect(await buttons(api, system, activity.code)).toContain('viewAll');
    expect(await buttons(api, advanced, activity.code)).not.toContain('viewAll');
    expect(await buttons(api, advanced, activity.code)).toContain('update');
    expect(await buttons(api, general, activity.code)).not.toContain('viewAll');
    expect(await buttons(api, system, questionnaire.code)).toContain('editOthers');
    expect(await buttons(api, advanced, questionnaire.code)).not.toContain('editOthers');
    expect(await buttons(api, advanced, person.code)).toContain('sync');
    expect(await buttons(api, general, person.code)).not.toContain('sync');
    expect(await buttons(api, system, settings.code)).toContain('finePermission');
    expect(await buttons(api, advanced, settings.code)).not.toContain('finePermission');
  });
});

describe('DEC-289③ 存量租户回补 360 标准身份', () => {
  it('补装缺失的标准身份；执行两次结果不变；手工同编码身份保留并标 CODE_TAKEN；回补后可授出并生效', async () => {
    const { db } = testDb();
    const api = tenantApi(db, { authorize: undefined });
    const operator = await seedOperator(db, 'ops-289');
    // 存量租户：开通早于 360 标准身份（这里直接建租户，不经平台开通，库里没有任何标准身份）
    const { tenant, user: admin } = await seedTenantWithMember(db, 'd289d');
    await bootstrapTenantAdmin(db, { tenantId: tenant.id, userId: admin.id }, cmd());
    const asAdmin = { user: admin.id, tenant: tenant.id };
    const manual = await api.request('POST', '/api/tenant/permission/profiles', {
      ...asAdmin,
      body: { code: 'standard_360_general_admin', name: '租户手工建的同编码', apps: ['Survey360'], licenseType: null },
    });
    expect(manual.status).toBe(201);
    const manualProfile = (await manual.json()) as { id: string; revision: number };

    const backfill = () =>
      api.request('POST', `${PLATFORM}/tenants/${tenant.id}/standard-profiles/backfill`, {
        user: operator.id,
        body: {},
      });
    const denied = await api.request('POST', `${PLATFORM}/tenants/${tenant.id}/standard-profiles/backfill`, {
      user: admin.id,
      body: {},
    });
    expect(denied.status).toBe(403);

    const first = await backfill();
    expect(first.status, await first.clone().text()).toBe(200);
    const result = (await first.json()) as BackfillResult;
    expect(result.installed).toEqual(
      expect.arrayContaining(['standard_360_system_admin', 'standard_360_advanced_admin', 'standard_org_system_admin']),
    );
    expect(result.installed).not.toContain('standard_360_general_admin');
    expect(result.skipped).toEqual([{ code: 'standard_360_general_admin', reason: 'CODE_TAKEN' }]);

    const state = async () => {
      const details = [];
      for (const p of await profiles(api, asAdmin))
        details.push(await (await api.request('GET', `/api/tenant/permission/profiles/${p.id}`, asAdmin)).json());
      return details;
    };
    const afterFirst = await state();

    const second = await backfill();
    expect(second.status).toBe(200);
    const again = (await second.json()) as BackfillResult;
    expect(again.installed).toEqual([]);
    expect(again.skipped).toContainEqual({ code: 'standard_360_general_admin', reason: 'CODE_TAKEN' });
    expect(
      again.skipped
        .filter((x) => x.reason === 'ALREADY_INSTALLED')
        .map((x) => x.code)
        .sort(),
    ).toEqual([...result.installed].sort());
    expect(await state()).toEqual(afterFirst);
    const kept = (await (
      await api.request('GET', `/api/tenant/permission/profiles/${manualProfile.id}`, asAdmin)
    ).json()) as {
      source: string;
      revision: number;
      objects: unknown[];
    };
    expect(kept).toMatchObject({ source: 'custom', revision: manualProfile.revision, objects: [] });

    // 回补的身份已在租户管理员的可授权范围内：企业管理员在“用户授权”里授出后即生效
    const advanced = (await profiles(api, asAdmin)).find((p) => p.code === 'standard_360_advanced_admin')!;
    const member = await holderOf(api, asAdmin, advanced.id, 'adv-289');
    const granted = await buttons(api, member, activity.code);
    expect(granted).toContain('update');
    expect(granted).not.toContain('viewAll');
  });

  it('租户不存在 404；同一命令 ID 重放返回原结果；平台运营身份撤销后用原幂等键重放 403', async () => {
    const { db } = testDb();
    const api = tenantApi(db, { authorize: undefined });
    const operator = await seedOperator(db, 'ops-289-replay');
    const { tenant, user } = await seedTenantWithMember(db, 'd289-replay');
    await bootstrapTenantAdmin(db, { tenantId: tenant.id, userId: user.id }, cmd());
    const missing = await api.request('POST', `${PLATFORM}/tenants/${randomUUID()}/standard-profiles/backfill`, {
      user: operator.id,
      body: {},
    });
    expect(missing.status).toBe(404);

    const key = randomUUID();
    const send = () =>
      api.request('POST', `${PLATFORM}/tenants/${tenant.id}/standard-profiles/backfill`, {
        user: operator.id,
        idempotencyKey: key,
        body: {},
      });
    const first = await send();
    expect(first.status, await first.clone().text()).toBe(200);
    const original = (await first.json()) as BackfillResult;
    expect(original.installed).toContain('standard_360_system_admin');
    const replay = await send();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(original);

    await revokePlatformOperator(db, { userId: operator.id, expectedRevision: 1 }, cmd());
    expect((await send()).status).toBe(403);
  });
});
