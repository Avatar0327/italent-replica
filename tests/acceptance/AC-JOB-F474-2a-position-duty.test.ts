/** F-474-2a #4：职位「职责描述 / 任职要求」（R1a §2.10、§3.8、§3.9）——版本链保存、统一文本上限、字段权限裁剪。 */
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  setObjectPermission,
  type PermissionWorld,
} from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const TODAY = '2026-10-01';
const LATER = '2026-10-15';
const POSITIONS = '/api/tenant/job/positions';

describe('AC-JOB-F474-2a-01 职位职责 / 要求', () => {
  let world: PermissionWorld;
  // 管理员造数与读写走默认放行装配；字段权限用例才走真实授权器（world.api）。
  let admin: ReturnType<typeof tenantApi>;
  let position: { id: string; revision: number };

  const detail = async (as: object, asOf = TODAY, api = admin) =>
    api.request('GET', `${POSITIONS}/${position.id}?asOf=${asOf}`, as);

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    const clock = () => new Date(`${TODAY}T12:00:00Z`);
    world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock }) };
    admin = tenantApi(world.db, { clock });
    const post = await admin.request('POST', '/api/tenant/job/posts', {
      ...world.asAdmin,
      ifMatch: 0,
      body: { name: '合成职务', code: `P${uniqueSuffix()}`, startDate: '2026-01-01' },
    });
    const org = await admin.request('POST', '/api/tenant/org/organizations', {
      ...world.asAdmin,
      ifMatch: 0,
      body: { name: '合成组织', establishedOn: '2026-01-01', parents: { admin: { parentId: world.tenant.id } } },
    });
    const created = await admin.request('POST', POSITIONS, {
      ...world.asAdmin,
      ifMatch: 0,
      body: {
        name: '合成职位',
        orgId: ((await org.json()) as { id: string }).id,
        postId: ((await post.json()) as { id: string }).id,
        startDate: '2026-01-01',
        responsibilities: '负责合成事务',
        requirements: '三年以上合成经验',
      },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    position = (await created.json()) as { id: string; revision: number };
  });

  it('新建保存后详情、列表都返回职责与要求', async () => {
    const response = await detail(world.asAdmin);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ responsibilities: '负责合成事务', requirements: '三年以上合成经验' });
    const list = await admin.request('GET', `${POSITIONS}?asOf=${TODAY}`, world.asAdmin);
    const items = ((await list.json()) as { items: Record<string, unknown>[] }).items;
    expect(items[0]).toMatchObject({ responsibilities: '负责合成事务', requirements: '三年以上合成经验' });
  });

  it('修改按生效日期追加版本，早于生效日的时点仍是旧值', async () => {
    const patch = await admin.request('PATCH', `${POSITIONS}/${position.id}`, {
      ...world.asAdmin,
      ifMatch: position.revision,
      body: { effectiveDate: LATER, responsibilities: '新的职责', requirements: null },
    });
    expect(patch.status, await patch.clone().text()).toBe(200);
    position = (await patch.json()) as { id: string; revision: number };
    expect(await (await detail(world.asAdmin, LATER)).json()).toMatchObject({
      responsibilities: '新的职责',
      requirements: null,
    });
    expect(await (await detail(world.asAdmin, TODAY)).json()).toMatchObject({
      responsibilities: '负责合成事务',
      requirements: '三年以上合成经验',
    });
  });

  it('沿用系统统一文本上限 4000：超限 400，恰好 4000 通过', async () => {
    const send = (text: string) =>
      admin.request('PATCH', `${POSITIONS}/${position.id}`, {
        ...world.asAdmin,
        ifMatch: position.revision,
        body: { effectiveDate: '2026-11-01', requirements: text },
      });
    expect((await send('长'.repeat(4001))).status).toBe(400);
    const ok = await send('长'.repeat(4000));
    expect(ok.status, await ok.clone().text()).toBe(200);
    position = (await ok.json()) as { id: string; revision: number };
  });

  it('职责与要求都不是必填：缺省创建的职位返回 null', async () => {
    const bare = await admin.request('POST', POSITIONS, {
      ...world.asAdmin,
      ifMatch: 0,
      body: {
        name: '无说明职位',
        orgId: ((await (await detail(world.asAdmin)).json()) as { orgId: string }).orgId,
        postId: ((await (await detail(world.asAdmin)).json()) as { postId: string }).postId,
        startDate: '2026-01-01',
      },
    });
    expect(bare.status, await bare.clone().text()).toBe(201);
    const id = ((await bare.json()) as { id: string }).id;
    const read = await admin.request('GET', `${POSITIONS}/${id}?asOf=${TODAY}`, world.asAdmin);
    expect(await read.json()).toMatchObject({ responsibilities: null, requirements: null });
  });

  it('字段目录登记了两个字段', () => {
    const codes = MODULE_OBJECTS.jobPosition.fields.map((field) => field.code);
    expect(codes).toEqual(expect.arrayContaining(['responsibilities', 'requirements']));
  });

  describe('字段权限', () => {
    async function actor(options: { hidden?: readonly string[]; editable?: readonly string[] }) {
      const definition = MODULE_OBJECTS.jobPosition;
      const profile = await createProfile(world, `duty-${uniqueSuffix()}`);
      const permission = await setObjectPermission(
        world,
        profile,
        {
          dataOperations: { create: true, update: true, delete: false },
          fields: definition.fields.map((field) => ({
            fieldCode: field.code,
            view: !options.hidden?.includes(field.code),
            edit:
              !field.system &&
              !options.hidden?.includes(field.code) &&
              (options.editable === undefined || options.editable.includes(field.code)),
          })),
          buttons: [],
        },
        definition.code,
      );
      expect(permission.status, await permission.clone().text()).toBe(200);
      await makeGrantable(world, [profile.id]);
      const user = await addMember(world, 'duty-actor');
      expect((await grant(world, user.id, profile.id)).status).toBe(201);
      const all = await world.api.request(
        'PUT',
        `/api/tenant/permission/profiles/${profile.id}/data-scopes/TenantBase`,
        { ...world.asAdmin, ifMatch: 0, body: { targetKind: 'app', targetCode: '', seeAll: true } },
      );
      expect(all.status, await all.clone().text()).toBe(200);
      return { user: user.id, tenant: world.tenant.id };
    }

    it('无查看权的字段列表与详情都不返回', async () => {
      const as = await actor({ hidden: ['responsibilities'] });
      const read = await detail(as, TODAY, world.api);
      expect(read.status).toBe(200);
      const body = (await read.json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty('responsibilities');
      expect(body).toHaveProperty('requirements');
      const list = await world.api.request('GET', `${POSITIONS}?asOf=${TODAY}`, as);
      for (const row of ((await list.json()) as { items: Record<string, unknown>[] }).items) {
        expect(row).not.toHaveProperty('responsibilities');
      }
    });

    it('无编辑权的字段整单拒绝；有编辑权可改', async () => {
      const as = await actor({ editable: ['requirements', 'effectiveDate'] });
      const denied = await world.api.request('PATCH', `${POSITIONS}/${position.id}`, {
        ...as,
        ifMatch: position.revision,
        body: { effectiveDate: '2026-12-01', responsibilities: '越权修改' },
      });
      expect(denied.status).toBe(403);
      const allowed = await world.api.request('PATCH', `${POSITIONS}/${position.id}`, {
        ...as,
        ifMatch: position.revision,
        body: { effectiveDate: '2026-12-01', requirements: '获准修改' },
      });
      expect(allowed.status, await allowed.clone().text()).toBe(200);
    });
  });
});
