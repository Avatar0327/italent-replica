/**
 * F-474-2a #6：职级「所属资源集合」与「薪资上限 / 中位 / 下限」（R1a §2.8、§3.6；DEC-778④ 沿用 DEC-339①）。
 * - 资源集合 = 创建人在职务体系应用（TenantBase）里的授权管理单元：一个自动填，多个由新建请求选一个，列表只读；
 *   没有授权管理单元时拒绝新建（与人才标准 / 任职资格同口径，403 NO_MANAGEMENT_UNIT），不落对象 / 版本 / 成功审计；
 * - 薪资三值按版本链保存，规格未验证数值关系，因此不校验 下限 ≤ 中位 ≤ 上限；
 * - 字段权限：无查看权的薪资字段列表与详情都不返回，无编辑权的整单拒绝。
 */
import { sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMou, createOrg, talentWorld, TC_PERMISSION_PATH } from './AC-TC-support.js';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  setObjectPermission,
  type PermissionWorld,
} from './AC-PRM-support.js';
import { grantJobUnit } from './support/job-unit.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const LEVELS = '/api/tenant/job/levels';
const ASOF = '?asOf=2026-10-07';
const APP = 'TenantBase';

type World = Awaited<ReturnType<typeof talentWorld>>;
interface Level {
  id: string;
  revision: number;
  level?: number;
  ownerOrgId?: string | null;
  salaryUpper?: number | null;
  salaryMid?: number | null;
  salaryLower?: number | null;
}

describe('AC-JOB-F474-2a-03 职级资源集合 / 薪资区间', () => {
  let w: World;
  let orgA: string;
  let orgB: string;
  let revision = 0;

  /** 换成员在职务体系应用的授权管理单元；null 撤掉授权。 */
  async function setUnits(orgIds: readonly string[] | null) {
    const mouId = orgIds ? await createMou(w.api, w.as, orgIds, '职务体系') : null;
    const response = await w.api.request('PUT', `${TC_PERMISSION_PATH}/scopes/${w.as.user}/${APP}`, {
      ...w.as,
      ifMatch: revision,
      body: mouId ? { kind: 'mou', mouId } : { kind: 'default' },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    revision = ((await response.json()) as { revision: number }).revision;
  }

  const createLevel = (extra: Record<string, unknown> = {}) =>
    w.api.request('POST', LEVELS, {
      ...w.as,
      ifMatch: 0,
      body: { name: `职级${uniqueSuffix()}`, level: 1, startDate: '2026-01-01', ...extra },
    });
  const read = async (id: string) =>
    (await (await w.api.request('GET', `${LEVELS}/${id}${ASOF}`, w.as)).json()) as Level;
  /** 职级对象、版本、成功审计的行数（拒绝新建时三者都不得增加）。 */
  const levelRows = () =>
    withTenant(testDb().db, w.tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT
        (SELECT count(*)::int FROM job_level_objects) AS objects,
        (SELECT count(*)::int FROM job_level_versions) AS versions,
        (SELECT count(*)::int FROM audit_events WHERE action = 'job.create' AND object_type = 'levels') AS audits`);
      return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows)[0];
    });

  beforeAll(async () => {
    w = await talentWorld(testDb().db, 'f4742lvl');
    orgA = w.orgId;
    orgB = await createOrg(w.api, w.as, '第二个管理单元');
  });

  describe('资源集合（DEC-339①）', () => {
    it('只有一个授权管理单元：自动填写，详情与列表都返回', async () => {
      await setUnits([orgA]);
      const created = await createLevel();
      expect(created.status, await created.clone().text()).toBe(201);
      const level = (await created.json()) as Level;
      expect((await read(level.id)).ownerOrgId).toBe(orgA);
      const list = (await (await w.api.request('GET', `${LEVELS}${ASOF}`, w.as)).json()) as { items: Level[] };
      expect(list.items.find((item) => item.id === level.id)?.ownerOrgId).toBe(orgA);
    });

    it('有多个授权管理单元：不选 400；选其一保存；选了不属于自己的单元 404', async () => {
      await setUnits([orgA, orgB]);
      const missing = await createLevel();
      expect(missing.status).toBe(400);
      expect(JSON.stringify(await missing.json())).toContain('MANAGEMENT_UNIT_REQUIRED');
      const chosen = await createLevel({ ownerOrgId: orgB });
      expect(chosen.status, await chosen.clone().text()).toBe(201);
      expect((await read(((await chosen.json()) as Level).id)).ownerOrgId).toBe(orgB);
      const foreign = await createLevel({ ownerOrgId: '00000000-0000-4000-8000-0000000000cc' });
      expect(foreign.status).toBe(404);
    });

    it('候选接口只列创建人自己的授权管理单元', async () => {
      const candidates = async () => {
        const response = await w.api.request('GET', '/api/tenant/job/candidates/resource-sets', w.as);
        expect(response.status, await response.clone().text()).toBe(200);
        return ((await response.json()) as { items: { id: string }[] }).items.map((item) => item.id).sort();
      };
      await setUnits([orgA, orgB]);
      expect(await candidates()).toEqual([orgA, orgB].sort());
      await setUnits([orgB]);
      expect(await candidates()).toEqual([orgB]);
      await setUnits(null);
      expect(await candidates()).toEqual([]);
    });

    it('没有授权管理单元：拒绝新建（403 NO_MANAGEMENT_UNIT），对象 / 版本 / 成功审计都不落库；硬塞一个单元 404', async () => {
      await setUnits(null);
      const before = await levelRows();
      const denied = await createLevel();
      expect(denied.status, await denied.clone().text()).toBe(403);
      expect(JSON.stringify(await denied.json())).toContain('NO_MANAGEMENT_UNIT');
      expect(await levelRows()).toEqual(before);
      expect((await createLevel({ ownerOrgId: orgA })).status).toBe(404);
      expect(await levelRows()).toEqual(before);
    });

    it('授权单元 ID 大小写不敏感：大写形式照样保存为同一个单元；真正范围外的仍 404', async () => {
      await setUnits([orgA, orgB]);
      const upper = await createLevel({ ownerOrgId: orgB.toUpperCase() });
      expect(upper.status, await upper.clone().text()).toBe(201);
      expect((await read(((await upper.json()) as Level).id)).ownerOrgId).toBe(orgB);
      const foreign = '00000000-0000-4000-8000-0000000000CC';
      expect((await createLevel({ ownerOrgId: foreign })).status).toBe(404);
    });

    it('列表只读：修改请求不接受 ownerOrgId；改其他字段后新版本沿用原资源集合', async () => {
      await setUnits([orgA]);
      const level = (await (await createLevel()).json()) as Level;
      const send = (body: Record<string, unknown>) =>
        w.api.request('PATCH', `${LEVELS}/${level.id}`, {
          ...w.as,
          ifMatch: level.revision,
          body: { effectiveDate: '2026-10-07', ...body },
        });
      expect((await send({ ownerOrgId: orgA })).status).toBe(400);
      const renamed = await send({ name: `改名${uniqueSuffix()}` });
      expect(renamed.status, await renamed.clone().text()).toBe(200);
      expect((await read(level.id)).ownerOrgId).toBe(orgA);
    });
  });

  describe('导入（原站编码映射）', () => {
    interface Receipt {
      status: string;
      reason?: string;
      objectId?: string;
    }
    const importRow = async (row: Record<string, unknown>): Promise<Receipt> => {
      const response = await w.api.request('POST', '/api/tenant/job/import', {
        ...w.as,
        ifMatch: 0,
        body: { kind: 'levels', rows: [{ name: `导入${uniqueSuffix()}`, level: 1, startDate: '2026-01-01', ...row }] },
      });
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as { results: Receipt[] }).results[0]!;
    };

    it('多单元用户首次创建 → 同归属（含大写写法）重导更新成功 → 改归属逐行拒绝且不改资源集合', async () => {
      await setUnits([orgA, orgB]);
      const source = `LV${uniqueSuffix()}`;
      const code = `IC${uniqueSuffix()}`;
      const created = await importRow({ sourceCode: source, code, ownerOrgId: orgB });
      expect(created.status).toBe('created');
      const same = await importRow({ sourceCode: source, code, ownerOrgId: orgB, expectedRevision: 1, level: 2 });
      expect(same.status, JSON.stringify(same)).toBe('updated');
      const upper = await importRow({
        sourceCode: source,
        code,
        ownerOrgId: orgB.toUpperCase(),
        expectedRevision: 2,
        level: 3,
      });
      expect(upper.status, JSON.stringify(upper)).toBe('updated');
      const moved = await importRow({ sourceCode: source, code, ownerOrgId: orgA, expectedRevision: 3, level: 4 });
      expect(moved.status).toBe('conflict');
      expect(moved.reason).toBe('RESOURCE_SET_IMMUTABLE');
      const level = await read(created.objectId!);
      expect(level).toMatchObject({ ownerOrgId: orgB, level: 3 });
    });

    // 归属创建后不可改：显式清空（null）与改成别的归属一样整行拒绝，不得只改业务字段（审查 P2-2 第 2 轮）。
    it.each([
      ['清空为 null', null],
      ['改成另一归属', 'ORG_B'],
    ])(
      '导入更新%s → 该行 conflict 且原因 RESOURCE_SET_IMMUTABLE，revision、业务值、版本数都不变',
      async (_name, value) => {
        await setUnits([orgA, orgB]);
        const source = `LV${uniqueSuffix()}`;
        const code = `IC${uniqueSuffix()}`;
        const created = await importRow({ sourceCode: source, code, ownerOrgId: orgA, level: 7 });
        expect(created.status).toBe('created');
        const before = await read(created.objectId!);
        const versionsBefore = await levelRows();
        const attempt = await importRow({
          sourceCode: source,
          code,
          ownerOrgId: value === 'ORG_B' ? orgB : value,
          expectedRevision: before.revision,
          level: 99,
        });
        expect(attempt).toMatchObject({ status: 'conflict', reason: 'RESOURCE_SET_IMMUTABLE' });
        const after = await read(created.objectId!);
        expect(after).toMatchObject({ revision: before.revision, level: 7, ownerOrgId: orgA });
        expect(await levelRows()).toEqual(versionsBefore);
      },
    );

    it('更新时归属写成空串 → 请求校验整体 400，revision、业务值、版本数都不变', async () => {
      await setUnits([orgA, orgB]);
      const source = `LV${uniqueSuffix()}`;
      const code = `IC${uniqueSuffix()}`;
      const created = await importRow({ sourceCode: source, code, ownerOrgId: orgA, level: 7 });
      const before = await read(created.objectId!);
      const versionsBefore = await levelRows();
      const response = await w.api.request('POST', '/api/tenant/job/import', {
        ...w.as,
        ifMatch: 0,
        body: {
          kind: 'levels',
          rows: [{ sourceCode: source, code, name: '空串', ownerOrgId: '', expectedRevision: 1, level: 99 }],
        },
      });
      expect(response.status).toBe(400);
      expect(await read(created.objectId!)).toMatchObject({ revision: before.revision, level: 7, ownerOrgId: orgA });
      expect(await levelRows()).toEqual(versionsBefore);
    });

    it('缺归属的多单元用户首次创建仍须选择（不取消必选校验）；更新不带归属照常成功', async () => {
      await setUnits([orgA, orgB]);
      const source = `LV${uniqueSuffix()}`;
      const code = `IC${uniqueSuffix()}`;
      expect((await importRow({ sourceCode: source, code })).status).toBe('conflict');
      const created = await importRow({ sourceCode: source, code, ownerOrgId: orgA });
      expect(created.status).toBe('created');
      const updated = await importRow({ sourceCode: source, code, expectedRevision: 1, level: 5 });
      expect(updated.status, JSON.stringify(updated)).toBe('updated');
    });
  });

  describe('薪资上限 / 中位 / 下限', () => {
    beforeAll(() => setUnits([orgA]));

    it('新建保存，详情与列表返回数值；修改按生效日期追加版本，旧时点仍是旧值，可清空', async () => {
      const created = await createLevel({ salaryUpper: 30000, salaryMid: 22000.5, salaryLower: 15000 });
      expect(created.status, await created.clone().text()).toBe(201);
      let level = (await created.json()) as Level;
      expect(await read(level.id)).toMatchObject({ salaryUpper: 30000, salaryMid: 22000.5, salaryLower: 15000 });
      const patch = await w.api.request('PATCH', `${LEVELS}/${level.id}`, {
        ...w.as,
        ifMatch: level.revision,
        body: { effectiveDate: '2026-12-01', salaryMid: null },
      });
      expect(patch.status, await patch.clone().text()).toBe(200);
      level = (await patch.json()) as Level;
      const later = (await (await w.api.request('GET', `${LEVELS}/${level.id}?asOf=2026-12-01`, w.as)).json()) as Level;
      expect(later).toMatchObject({ salaryUpper: 30000, salaryMid: null, salaryLower: 15000 });
      expect((await read(level.id)).salaryMid).toBe(22000.5);
    });

    it('规格未验证数值关系，不校验 下限 ≤ 中位 ≤ 上限', async () => {
      const created = await createLevel({ salaryUpper: 100, salaryMid: 500, salaryLower: 900 });
      expect(created.status, await created.clone().text()).toBe(201);
    });

    it('非数值 400', async () => {
      expect((await createLevel({ salaryUpper: '三万' })).status).toBe(400);
    });
  });

  it('字段目录登记了资源集合与三个薪资字段', () => {
    const codes = MODULE_OBJECTS.jobLevel.fields.map((field) => field.code);
    expect(codes).toEqual(expect.arrayContaining(['ownerOrgId', 'salaryUpper', 'salaryMid', 'salaryLower']));
  });
});

describe('AC-JOB-F474-2a-04 职级薪资字段权限', () => {
  let world: PermissionWorld;
  let level: Level;
  const TODAY = '2026-10-01';

  async function actor(options: { hidden?: readonly string[]; editable?: readonly string[] }) {
    const definition = MODULE_OBJECTS.jobLevel;
    const profile = await createProfile(world, `salary-${uniqueSuffix()}`);
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
    const user = await addMember(world, 'salary-actor');
    expect((await grant(world, user.id, profile.id)).status).toBe(201);
    const all = await world.api.request('PUT', `/api/tenant/permission/profiles/${profile.id}/data-scopes/TenantBase`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { targetKind: 'app', targetCode: '', seeAll: true },
    });
    expect(all.status, await all.clone().text()).toBe(200);
    return { user: user.id, tenant: world.tenant.id };
  }

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    const clock = () => new Date(`${TODAY}T12:00:00Z`);
    const admin = tenantApi(world.db, { clock });
    world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock }) };
    // 新建职级需要创建人有职务体系授权管理单元（没有则 403 NO_MANAGEMENT_UNIT）
    await grantJobUnit(
      (method, path, init) => admin.request(method, path, { ...world.asAdmin, ...init }),
      world.asAdmin.user,
      world.tenant.id,
    );
    const created = await admin.request('POST', LEVELS, {
      ...world.asAdmin,
      ifMatch: 0,
      body: {
        name: '合成职级',
        level: 1,
        startDate: '2026-01-01',
        salaryUpper: 30000,
        salaryMid: 20000,
        salaryLower: 10000,
      },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    level = (await created.json()) as Level;
  });

  it('无查看权的薪资字段列表与详情都不返回，其余字段照常', async () => {
    const as = await actor({ hidden: ['salaryUpper', 'salaryMid', 'salaryLower'] });
    const read = await world.api.request('GET', `${LEVELS}/${level.id}?asOf=${TODAY}`, as);
    expect(read.status).toBe(200);
    const body = (await read.json()) as Record<string, unknown>;
    for (const field of ['salaryUpper', 'salaryMid', 'salaryLower']) expect(body).not.toHaveProperty(field);
    expect(body).toHaveProperty('level');
    const list = await world.api.request('GET', `${LEVELS}?asOf=${TODAY}`, as);
    for (const row of ((await list.json()) as { items: Record<string, unknown>[] }).items) {
      expect(row).not.toHaveProperty('salaryUpper');
    }
  });

  it('有查看权的薪资字段返回数值；无编辑权的字段整单拒绝', async () => {
    const as = await actor({ editable: ['name', 'effectiveDate'] });
    const read = await world.api.request('GET', `${LEVELS}/${level.id}?asOf=${TODAY}`, as);
    expect(await read.json()).toMatchObject({ salaryUpper: 30000, salaryMid: 20000, salaryLower: 10000 });
    const denied = await world.api.request('PATCH', `${LEVELS}/${level.id}`, {
      ...as,
      ifMatch: level.revision,
      body: { effectiveDate: '2026-12-01', salaryUpper: 99999 },
    });
    expect(denied.status).toBe(403);
  });
});
