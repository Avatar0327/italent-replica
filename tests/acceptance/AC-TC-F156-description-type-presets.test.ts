/**
 * F-156（DEC-514② 修订 DEC-281④）：开通租户时预置原站 5 种发展建议类型，按原站下拉顺序
 * （UI3补 R3_任职资格 B4_02～06，UI3补2 复核）；配置页保留（复刻增强），预置类型与租户自建的一样可改名、停用。
 */
import { auditEvents, eq, grantMembership, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { BASE } from './AC-PRM-support.js';
import { newUser, provisioned, type ProvisionResult, seedOperator } from './support/platform-api.js';
import { cmd, tenantApi } from './support/tenant-api.js';
import { TC_BASE, TC_NOW } from './AC-TC-support.js';

const testDb = useTestDb();
const clock = () => TC_NOW;
const ORIGINAL_ORDER = ['误区行为', '反思问题', '原因探析和改进指引', '行动建议', '推荐阅读'];

interface TypeRow {
  id: string;
  name: string;
  enabled: boolean;
  displayOrder: number;
  revision: number;
}

describe('F-156 发展建议类型预置原站 5 种（DEC-514②）', () => {
  let api: ReturnType<typeof tenantApi>;
  let result: ProvisionResult;
  let as: { user: string; tenant: string };

  beforeAll(async () => {
    const { db } = testDb();
    api = tenantApi(db, { authorize: undefined, clock });
    const operator = await seedOperator(db);
    const admin = await newUser(db, 'tc-f156-admin');
    result = await provisioned(api, operator, { firstAdminUserId: admin.id, exceptionAdminUserId: admin.id });
    const asAdmin = { user: admin.id, tenant: result.tenant.id };
    // 预置的“人才标准管理员”身份对发展建议类型字典预置看全部（DEC-121），授予后即可读写字典
    const member = await newUser(db, 'tc-f156-member');
    await grantMembership(db, { tenantId: result.tenant.id, userId: member.id, expectedRevision: 0 }, cmd());
    const profileId = result.profiles.find((profile) => profile.code === 'standard_talent_admin')!.id;
    const granted = await api.request('POST', `${BASE}/grants`, { ...asAdmin, body: { userId: member.id, profileId } });
    expect(granted.status, await granted.clone().text()).toBe(201);
    as = { user: member.id, tenant: result.tenant.id };
  });

  const list = async (path: string) => {
    const response = await api.request('GET', `${TC_BASE}/${path}`, as);
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { items: TypeRow[] }).items;
  };

  it('新开通租户恰有 5 种发展建议类型：名称与顺序逐一同原站，全部启用，各写一条系统创建审计', async () => {
    const dictionary = await list('description-types');
    expect(dictionary.map((item) => item.name)).toEqual(ORIGINAL_ORDER);
    expect(dictionary.map((item) => item.displayOrder)).toEqual([1, 2, 3, 4, 5]);
    expect(dictionary.every((item) => item.enabled)).toBe(true);

    const options = await list('candidates/description-types');
    expect(options.map((item) => item.name)).toEqual(ORIGINAL_ORDER);

    const audits = await withTenant(testDb().db, result.tenant.id, (tx) =>
      tx
        .select({ objectId: auditEvents.objectId, action: auditEvents.action })
        .from(auditEvents)
        .where(eq(auditEvents.objectType, 'TalentCenter.DescriptionType')),
    );
    expect(audits.map((audit) => audit.objectId).sort()).toEqual(dictionary.map((item) => item.id).sort());
    for (const audit of audits) expect(audit.action).toMatch(/\.create$/);
  });

  it('预置类型与自建的一样可改名、停用：停用的不再出现在下拉，改名后下拉显示新名称，可再新建', async () => {
    const before = await list('description-types');
    const byName = (name: string) => {
      const row = before.find((item) => item.name === name);
      expect(row, `预置类型“${name}”`).toBeDefined();
      return row!;
    };
    const patch = async (row: TypeRow, body: Record<string, unknown>) => {
      const response = await api.request('PATCH', `${TC_BASE}/description-types/${row.id}`, {
        ...as,
        ifMatch: row.revision,
        body,
      });
      expect(response.status, await response.clone().text()).toBe(200);
    };
    await patch(byName('推荐阅读'), { enabled: false });
    await patch(byName('误区行为'), { name: '常见误区' });
    const created = await api.request('POST', `${TC_BASE}/description-types`, {
      ...as,
      ifMatch: 0,
      body: { name: '培训课程', displayOrder: 6 },
    });
    expect(created.status, await created.clone().text()).toBe(201);

    expect((await list('candidates/description-types')).map((item) => item.name)).toEqual([
      '常见误区',
      '反思问题',
      '原因探析和改进指引',
      '行动建议',
      '培训课程',
    ]);
    const after = await list('description-types');
    expect(after.find((item) => item.name === '推荐阅读')).toMatchObject({ enabled: false, displayOrder: 5 });
  });
});
