import { PERSONNEL_OBJECT } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { createPermissionAuthorizer } from '../../apps/api/src/modules/permission/authorizer.js';
import { BASE, createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { memberWithAdminRole } from './AC-PRM-users-support.js';
import { f516World, F516_NOW, type F516Row } from './AC-PRM-F516-support.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const contactEmail = 'Hidden.Contact@example.com';
const cases = ['对象无权', '邮箱字段无权', '人员范围外', '有权且范围内'] as const;
describe('AC-PRM-F516 联系邮箱列与混合搜索使用相同的人员权限', () => {
  let w: Awaited<ReturnType<typeof f516World>>;
  let target: Awaited<ReturnType<typeof w.person>>;
  let loginEmail: string;
  let api: ReturnType<typeof tenantApi>;
  const readers = new Map<string, { user: string; tenant: string }>();
  beforeAll(async () => {
    w = await f516World(database().db);
    target = await w.person('邮箱回归合成员工', '13000000001', contactEmail);
    const inside = await w.hr.org('邮箱回归范围内');
    const outside = await w.hr.org('邮箱回归范围外');
    expect((await w.hr.hire(target, inside)).status).toBe(201);
    loginEmail = (await w.page('/users')).items.find((row) => row.userId === target.userId)!.email as string;
    expect(loginEmail).not.toBe(contactEmail);
    const authorize = createPermissionAuthorizer(w.db, undefined, () => F516_NOW);
    api = tenantApi(w.db, { authorize, clock: () => F516_NOW });
    for (const kind of cases) {
      const reader = await memberWithAdminRole(w, 'user_admin', kind);
      readers.set(kind, reader.as);
      if (kind !== '对象无权') {
        const profile = await createProfile(w, `F516_${uniqueSuffix()}`);
        const permission = await setObjectPermission(
          w,
          profile,
          {
            dataOperations: { create: false, update: false, delete: false },
            fields: ['name', ...(kind === '邮箱字段无权' ? [] : ['email'])].map((fieldCode) => ({
              fieldCode,
              view: true,
              edit: false,
            })),
            buttons: [],
          },
          PERSONNEL_OBJECT,
        );
        expect(permission.status, await permission.clone().text()).toBe(200);
        await makeGrantable(w, [profile.id]);
        expect((await grant(w, reader.user.id, profile.id)).status).toBe(201);
        const scope = await w.api.request('PUT', `${BASE}/scopes/${reader.user.id}/TenantBase`, {
          ...w.asAdmin,
          ifMatch: 0,
          body: {
            kind: 'org_range',
            orgRanges: [{ orgId: kind === '人员范围外' ? outside : inside, includeDescendants: false }],
          },
        });
        expect(scope.status, await scope.clone().text()).toBe(200);
      }
      expect(
        await authorize({
          tenantId: w.tenant.id,
          userId: reader.user.id,
          action: 'object.view',
          resource: PERSONNEL_OBJECT,
        }),
      ).toBe(kind !== '对象无权');
    }
  });

  it.each(cases)('%s：列值、搜索与分页总数不泄露隐藏邮箱，账号搜索保持可用', async (kind) => {
    const as = readers.get(kind)!;
    const visible = kind === '有权且范围内';
    async function page(query = '') {
      const response = await api.request('GET', `${BASE}/users${query}`, as);
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()) as { items: F516Row[]; total: number };
    }
    const all = await page();
    const row = all.items.find((item) => item.userId === target.userId)!;
    expect(row).toBeDefined();
    expect.soft(row.contactEmail ?? null).toBe(visible ? contactEmail : null);
    expect(all.total).toBe(all.items.length);
    for (const offset of [0, 1]) {
      const matched = await page(`?q=hIdDeN.cOnTaCt&limit=1&offset=${offset}`);
      expect.soft(matched.total).toBe(visible ? 1 : 0);
      expect.soft(matched.items.map((item) => item.userId)).toEqual(visible && offset === 0 ? [target.userId] : []);
    }
    for (const q of ['邮箱回归合成', loginEmail]) {
      const matched = await page(`?${new URLSearchParams({ q })}`);
      expect(matched.total).toBe(1);
      expect(matched.items.map((item) => item.userId)).toEqual([target.userId]);
      expect.soft(matched.items[0]!.contactEmail ?? null).toBe(visible ? contactEmail : null);
    }
    const filtered = await api.request('GET', `${BASE}/users?contactEmail=hidden.contact`, as);
    if (kind === '对象无权' || kind === '邮箱字段无权') {
      expect(filtered.status).toBe(403);
    } else {
      expect(filtered.status).toBe(200);
      const body = (await filtered.json()) as { items: F516Row[]; total: number };
      expect(body.total).toBe(visible ? 1 : 0);
      expect(body.items.map((item) => item.userId)).toEqual(visible ? [target.userId] : []);
    }
  });

  /** DEC-901：详情与列表同口径，人员对象查看 + 邮箱字段 + 数据范围缺一，都不披露档案联系邮箱。 */
  it.each(cases)('%s：用户详情的联系邮箱与列表口径一致', async (kind) => {
    const response = await api.request('GET', `${BASE}/users/${target.userId}`, readers.get(kind)!);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as F516Row;
    expect(body.userId).toBe(target.userId);
    expect(body.email).toBe(loginEmail);
    expect(body.contactEmail ?? null).toBe(kind === '有权且范围内' ? contactEmail : null);
  });
});
