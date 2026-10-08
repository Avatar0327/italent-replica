/**
 * DEC-281⑨⑩（`23` §7 ③；R1-T17 开通预置）：开通租户时预置“人才标准管理员（人才标准）”身份——人才标准应用的全部对象、
 * 全部功能；可见数据按管理单元控制，数据范围仍默认空，不预置看全部。唯一例外是没有组织字段的发展建议类型字典，
 * 按 DEC-121 同口径预置看全部（否则管理员无法维护下拉选项）；开通时同时预置样本类型“行动建议”（🟡 完整选项未取证）。
 */
import { grantMembership } from '@italent/db';
import { TALENT_APP, TALENT_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { BASE } from './AC-PRM-support.js';
import { newUser, provisioned, type ProvisionResult, seedOperator } from './support/platform-api.js';
import { cmd, tenantApi } from './support/tenant-api.js';
import { assignTalentMou, createMou, createOrg, TC_BASE, TC_NOW } from './AC-TC-support.js';

const testDb = useTestDb();
const clock = () => TC_NOW;

interface ProfileDetail {
  apps: string[];
  objects: {
    objectCode: string;
    dataOperations: { create: boolean; update: boolean; delete: boolean };
    fields: { fieldCode: string; view: boolean; edit: boolean }[];
    buttons: { buttonCode: string; level: string }[];
  }[];
}

describe('DEC-281⑩ 开通预置“人才标准管理员”身份', () => {
  let api: ReturnType<typeof tenantApi>;
  let fixture: ReturnType<typeof tenantApi>;
  let result: ProvisionResult;
  let asAdmin: { user: string; tenant: string };
  let profileId: string;

  beforeAll(async () => {
    const { db } = testDb();
    api = tenantApi(db, { authorize: undefined, clock });
    fixture = tenantApi(db, { clock });
    const operator = await seedOperator(db);
    const admin = await newUser(db, 'tc-preset-admin');
    result = await provisioned(api, operator, { firstAdminUserId: admin.id, exceptionAdminUserId: admin.id });
    asAdmin = { user: admin.id, tenant: result.tenant.id };
    profileId = result.profiles.find((profile) => profile.code === 'standard_talent_admin')!.id;
  });

  it('身份只带人才标准应用，六个对象全部字段可见、非系统字段可编辑、全部按钮与数据操作', async () => {
    const preset = result.profiles.find((profile) => profile.code === 'standard_talent_admin');
    expect(preset).toMatchObject({ name: '人才标准管理员（人才标准）' });
    const response = await api.request('GET', `${BASE}/profiles/${profileId}`, asAdmin);
    expect(response.status, await response.clone().text()).toBe(200);
    const detail = (await response.json()) as ProfileDetail;
    expect(detail.apps).toEqual([TALENT_APP]);
    const definitions = Object.values(TALENT_OBJECTS);
    expect(detail.objects.map((object) => object.objectCode).sort()).toEqual(definitions.map((d) => d.code).sort());
    for (const definition of definitions) {
      const object = detail.objects.find((candidate) => candidate.objectCode === definition.code)!;
      expect(object.dataOperations, definition.code).toEqual({ create: true, update: true, delete: true });
      for (const field of definition.fields) {
        expect(object.fields, `${definition.code}.${field.code}`).toContainEqual({
          fieldCode: field.code,
          view: true,
          edit: !field.system,
        });
      }
      expect(object.buttons.map((button) => button.buttonCode).sort()).toEqual(
        definition.buttons.map((button) => button.code).sort(),
      );
    }
  });

  it('数据范围不预置看全部（应用级、业务对象都为否）；只有发展建议类型字典预置看全部', async () => {
    const seeAll = async (query: string) => {
      const response = await api.request(
        'GET',
        `${BASE}/profiles/${profileId}/data-scopes/${TALENT_APP}${query}`,
        asAdmin,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as { seeAll: boolean }).seeAll;
    };
    expect(await seeAll('')).toBe(false);
    for (const definition of Object.values(TALENT_OBJECTS)) {
      const expected = definition.code === TALENT_OBJECTS.descriptionType.code;
      expect(await seeAll(`?targetKind=entity&targetCode=${definition.code}`), definition.code).toBe(expected);
    }
  });

  it('开通时预置样本类型“行动建议”；授予身份并选管理单元后，只看到管理单元内的数据', async () => {
    const { db } = testDb();
    const member = await newUser(db, 'tc-preset-member');
    await grantMembership(db, { tenantId: result.tenant.id, userId: member.id, expectedRevision: 0 }, cmd());
    const as = { user: member.id, tenant: result.tenant.id };
    const granted = await api.request('POST', `${BASE}/grants`, { ...asAdmin, body: { userId: member.id, profileId } });
    expect(granted.status, await granted.clone().text()).toBe(201);

    const options = await api.request('GET', `${TC_BASE}/candidates/description-types`, as);
    expect(options.status, await options.clone().text()).toBe(200);
    expect(((await options.json()) as { items: { name: string }[] }).items.map((item) => item.name)).toEqual([
      '行动建议',
    ]);
    const dictionary = await api.request('GET', `${TC_BASE}/description-types`, as);
    expect(((await dictionary.json()) as { items: { name: string }[] }).items.map((item) => item.name)).toEqual([
      '行动建议',
    ]);

    const inside = await createOrg(fixture, asAdmin, '预置范围内');
    const outside = await createOrg(fixture, asAdmin, '预置范围外');
    // 建数据的管理员授权管理单元含两个组织，新建时选其一（DEC-294 补充）
    await assignTalentMou(fixture, asAdmin, asAdmin.user, await createMou(fixture, asAdmin, [inside, outside]), 0);
    const create = async (orgId: string, name: string) => {
      const response = await fixture.request('POST', `${TC_BASE}/libraries`, {
        ...asAdmin,
        ifMatch: 0,
        body: { name, type: 'ability', ownerOrgId: orgId },
      });
      expect(response.status, await response.clone().text()).toBe(201);
      return ((await response.json()) as { id: string }).id;
    };
    const mine = await create(inside, '范围内的库');
    await create(outside, '范围外的库');
    // 授予后、未选管理单元：缺省为空
    const empty = await api.request('GET', `${TC_BASE}/libraries`, as);
    expect(await empty.json()).toMatchObject({ items: [], hasDataPermission: false });

    const mou = await api.request('POST', `${BASE}/mous`, {
      ...asAdmin,
      ifMatch: 0,
      body: { code: 'tc-preset', name: '人才标准单元', orgRanges: [{ orgId: inside, includeDescendants: true }] },
    });
    expect(mou.status, await mou.clone().text()).toBe(201);
    const assigned = await api.request('PUT', `${BASE}/scopes/${member.id}/${TALENT_APP}`, {
      ...asAdmin,
      ifMatch: 0,
      body: { kind: 'mou', mouId: ((await mou.json()) as { id: string }).id },
    });
    expect(assigned.status, await assigned.clone().text()).toBe(200);
    const scoped = await api.request('GET', `${TC_BASE}/libraries`, as);
    expect(((await scoped.json()) as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([mine]);
  });
});
