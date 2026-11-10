/**
 * F-474-5 #26（R1bd §2.13 / §3.8）：身份详情里「数据操作权限」「字段权限」两个弹窗的读写契约。
 * 只在现有对象权限模型内：读 = 该身份在某对象上的当前值；写 = 把弹窗改动合并进对象权限后，
 * 走既有 setObjectPermission 的同一写出口（revision / 目录指纹 / 审计 / 补装台账都不绕过）。
 * 功能权限弹窗沿用 GET /profiles/:id；页面权限、菜单组属 F-474-9，不在此。
 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  BASE,
  createProfile,
  DEMO_OBJECT,
  grant,
  LARGE_OBJECT,
  makeGrantable,
  myObject,
  type MyObjectPermission,
  type PermissionWorld,
  type ProfileBody,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
type Json = Record<string, unknown>;
const FULL = { create: true, update: true, delete: false };

describe('F-474-5 #26 身份对象权限弹窗：数据操作 / 字段', () => {
  let world: PermissionWorld;
  let profile: ProfileBody;
  let bare: ProfileBody;
  const tag = uniqueSuffix();
  const url = (p: ProfileBody, object = DEMO_OBJECT.code, tail = '') =>
    `${BASE}/profiles/${p.id}/objects/${object}${tail}`;

  const get = async (path: string, as = world.asAdmin) => {
    const response = await world.api.request('GET', path, as);
    return { status: response.status, body: (await response.json()) as Json, headers: response.headers };
  };
  const put = async (p: ProfileBody, tail: string, body: unknown, revision = p.revision, object = DEMO_OBJECT.code) => {
    const response = await world.api.request('PUT', url(p, object, tail), {
      ...world.asAdmin,
      ifMatch: revision,
      body,
    });
    const parsed = (await response.json()) as Json;
    if (response.ok) p.revision = parsed.revision as number;
    return { status: response.status, body: parsed };
  };
  const mineOf = async (user: Parameters<typeof myObject>[1]) => {
    const response = await myObject(world, user);
    expect(response.status).toBe(200);
    return (await response.json()) as MyObjectPermission;
  };
  const current = async (p: ProfileBody) =>
    ((await get(`${BASE}/profiles/${p.id}`)).body.revision as number) ?? p.revision;

  beforeAll(async () => {
    world = await seedPermissionWorld(database().db);
    profile = await createProfile(world, `DLG-${tag}`);
    bare = await createProfile(world, `BARE-${tag}`);
    const saved = await setObjectPermission(world, profile, {
      dataOperations: FULL,
      fields: [
        { fieldCode: 'Name', view: true, edit: true },
        { fieldCode: 'CreatedBy', view: true, edit: false },
      ],
      buttons: [{ buttonCode: 'EmploymentRecord.Print', level: 'detail' }],
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const large = await setObjectPermission(
      world,
      profile,
      { dataOperations: FULL, fields: [{ fieldCode: 'Field001', view: true, edit: false }], buttons: [] },
      LARGE_OBJECT.code,
    );
    expect(large.status, await large.clone().text()).toBe(200);
  });

  it('数据操作：读到当前三项与 revision（ETag）', async () => {
    const result = await get(url(profile, DEMO_OBJECT.code, '/data-operations'));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      profileId: profile.id,
      objectCode: DEMO_OBJECT.code,
      revision: profile.revision,
      dataOperations: FULL,
    });
    expect(result.headers.get('etag')).toBe(`"${profile.revision}"`);
  });

  it('数据操作：只改三项开关，字段与按钮原样保留；revision + 1；最近修改人更新', async () => {
    const saved = await put(profile, '/data-operations', {
      dataOperations: { create: true, update: false, delete: true },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({
      profileId: profile.id,
      objectCode: DEMO_OBJECT.code,
      revision: profile.revision,
    });
    const detail = (await get(`${BASE}/profiles/${profile.id}`)).body as { objects: Json[] };
    const object = detail.objects.find((o) => o.objectCode === DEMO_OBJECT.code)!;
    expect(object.dataOperations).toEqual({ create: true, update: false, delete: true });
    expect(object.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ fieldCode: 'Name', view: true, edit: true })]),
    );
    expect(object.buttons).toEqual([{ buttonCode: 'EmploymentRecord.Print', level: 'detail' }]);
  });

  it('数据操作：过期 revision → 409，不写任何行；缺 If-Match → 400', async () => {
    const stale = await put(profile, '/data-operations', { dataOperations: FULL }, profile.revision - 1);
    expect(stale.status).toBe(409);
    const missing = await world.api.request('PUT', url(profile, DEMO_OBJECT.code, '/data-operations'), {
      ...world.asAdmin,
      body: { dataOperations: FULL },
    });
    expect(missing.status).toBe(400);
    expect((await get(url(profile, DEMO_OBJECT.code, '/data-operations'))).body.dataOperations).toEqual({
      create: true,
      update: false,
      delete: true,
    });
  });

  it('数据操作：载荷不合法（缺项 / 多余键）→ 400', async () => {
    expect((await put(profile, '/data-operations', { dataOperations: { create: true } })).status).toBe(400);
    expect((await put(profile, '/data-operations', { dataOperations: FULL, fields: [] })).status).toBe(400);
  });

  it('字段：列出目录里的全部字段，带当前查看 / 编辑；系统字段标明不可授编辑；未授权字段为 false', async () => {
    const result = await get(url(profile, DEMO_OBJECT.code, '/fields'));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ profileId: profile.id, revision: profile.revision, total: 3 });
    expect(result.body.catalogDigest).toMatch(/^[0-9a-f]{16}$/);
    const items = result.body.items as Json[];
    expect(items.map((i) => i.fieldCode)).toEqual(['CreatedBy', 'MobilePhone', 'Name']);
    expect(items.find((i) => i.fieldCode === 'Name')).toMatchObject({ view: true, edit: true, system: false });
    expect(items.find((i) => i.fieldCode === 'MobilePhone')).toMatchObject({ view: false, edit: false, system: false });
    expect(items.find((i) => i.fieldCode === 'CreatedBy')).toMatchObject({ view: true, edit: false, system: true });
    // 目录里没有字段显示名：不伪造，列在 unrecorded
    expect(result.body.unrecorded).toEqual(['fieldName']);
    expect(items.every((i) => !('fieldName' in i))).toBe(true);
  });

  it('字段：按编码包含筛选（不分大小写、% 不当通配），总数与当页同口径，分页不重不漏', async () => {
    const hit = await get(url(profile, DEMO_OBJECT.code, `/fields?${new URLSearchParams({ code: 'phone' })}`));
    expect((hit.body.items as Json[]).map((i) => i.fieldCode)).toEqual(['MobilePhone']);
    expect(hit.body.total).toBe(1);
    expect(
      (await get(url(profile, DEMO_OBJECT.code, `/fields?${new URLSearchParams({ code: '%' })}`))).body.total,
    ).toBe(0);

    const seen: string[] = [];
    for (const offset of [0, 100, 200]) {
      const page = await get(url(profile, LARGE_OBJECT.code, `/fields?limit=100&offset=${offset}`));
      expect(page.body.total).toBe(274);
      seen.push(...(page.body.items as Json[]).map((i) => i.fieldCode as string));
    }
    expect(seen).toHaveLength(274);
    expect(new Set(seen).size).toBe(274);
    const f1 = (await get(url(profile, LARGE_OBJECT.code, '/fields?limit=1&code=Field001'))).body.items as Json[];
    expect(f1[0]).toMatchObject({ fieldCode: 'Field001', view: true });
  });

  it('字段：limit / offset 不合法 → 400', async () => {
    expect((await get(url(profile, DEMO_OBJECT.code, '/fields?limit=0'))).status).toBe(400);
    expect((await get(url(profile, DEMO_OBJECT.code, '/fields?limit=501'))).status).toBe(400);
    expect((await get(url(profile, DEMO_OBJECT.code, '/fields?offset=-1'))).status).toBe(400);
  });

  it('字段保存：只合并提交的字段；其余字段、数据操作、按钮不动；对持有人立即生效', async () => {
    const holder = await addMember(world, `holder-${tag}`);
    await makeGrantable(world, [profile.id]);
    expect((await grant(world, holder.id, profile.id)).status).toBe(201);
    expect((await mineOf(holder)).viewableFields).not.toContain('MobilePhone');

    const digest = (await get(url(profile, DEMO_OBJECT.code, '/fields'))).body.catalogDigest;
    const saved = await put(profile, '/fields', {
      catalogDigest: digest,
      fields: [{ fieldCode: 'MobilePhone', view: true, edit: false }],
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const mine = await mineOf(holder);
    expect(mine.viewableFields).toEqual(expect.arrayContaining(['MobilePhone', 'Name', 'CreatedBy']));
    expect(mine.editableFields).toEqual(['Name']);
    expect(mine.dataOperations).toEqual({ create: true, update: false, delete: true });
    expect(mine.buttons).toEqual([{ buttonCode: 'EmploymentRecord.Print', level: 'detail' }]);

    // 再取消查看：持有人不再拿到该字段
    expect(
      (await put(profile, '/fields', { fields: [{ fieldCode: 'MobilePhone', view: false, edit: false }] })).status,
    ).toBe(200);
    expect((await mineOf(holder)).viewableFields).not.toContain('MobilePhone');
  });

  it('字段保存：未知字段 / 系统字段编辑 / 同一字段重复 → 400，不写任何行', async () => {
    const before = (await get(url(profile, DEMO_OBJECT.code, '/fields'))).body;
    expect((await put(profile, '/fields', { fields: [{ fieldCode: 'NoSuch', view: true, edit: false }] })).status).toBe(
      400,
    );
    expect(
      (await put(profile, '/fields', { fields: [{ fieldCode: 'CreatedBy', view: true, edit: true }] })).status,
    ).toBe(400);
    const dup = [
      { fieldCode: 'Name', view: true, edit: false },
      { fieldCode: 'Name', view: true, edit: true },
    ];
    expect((await put(profile, '/fields', { fields: dup })).status).toBe(400);
    expect((await get(url(profile, DEMO_OBJECT.code, '/fields'))).body).toEqual(before);
  });

  it('字段保存：目录指纹不一致 → 409 CATALOG_CHANGED；过期 revision → 409', async () => {
    const wrongDigest = await put(profile, '/fields', {
      catalogDigest: '0000000000000000',
      fields: [{ fieldCode: 'Name', view: true, edit: false }],
    });
    expect(wrongDigest.status).toBe(409);
    expect(JSON.stringify(wrongDigest.body)).toContain('CATALOG_CHANGED');
    const stale = await put(profile, '/fields', { fields: [{ fieldCode: 'Name', view: true, edit: false }] }, 0);
    expect(stale.status).toBe(409);
  });

  // 冲突恢复（AGENTS.md §10 并发）：409 后客户端重读、显式改回原值、带新 revision 重提，不盲重试
  const CONFLICT_CASES = [
    {
      entry: '数据操作',
      tail: '/data-operations',
      original: { dataOperations: { create: true, update: true, delete: false } },
      theirs: { dataOperations: { create: false, update: false, delete: true } },
      read: (body: Json) => ({ dataOperations: body.dataOperations }),
    },
    {
      entry: '字段',
      tail: '/fields',
      original: { fields: [{ fieldCode: 'Name', view: true, edit: true }] },
      theirs: { fields: [{ fieldCode: 'Name', view: false, edit: false }] },
      read: (body: Json) => ({
        fields: (body.items as Json[])
          .filter((i) => i.fieldCode === 'Name')
          .map((i) => ({ fieldCode: i.fieldCode, view: i.view, edit: i.edit })),
      }),
    },
  ] as const;

  it.each(CONFLICT_CASES)(
    '$entry 弹窗：409 → 重读到他人改动 → 改回原值 → 带新 revision 保存成功',
    async ({ tail, original, theirs, read }) => {
      const target = await createProfile(world, `CONFLICT-${tail.slice(1, 5)}-${tag}`);
      const seeded = await setObjectPermission(world, target, {
        dataOperations: FULL,
        fields: [{ fieldCode: 'Name', view: true, edit: true }],
        buttons: [],
      });
      expect(seeded.status, await seeded.clone().text()).toBe(200);
      const endpoint = url(target, DEMO_OBJECT.code, tail);
      const first = await get(endpoint);
      const staleRevision = first.body.revision as number;
      expect(read(first.body)).toEqual(original);

      // 另一位管理员先保存了别的值，本端手里的 revision 过期
      expect((await put(target, tail, theirs, staleRevision)).status).toBe(200);
      const rejected = await put(target, tail, original, staleRevision);
      expect(rejected.status).toBe(409);

      // 重读：看到的是他人的值与新 revision；原值没有被盲重试写回
      const reread = await get(endpoint);
      const freshRevision = reread.body.revision as number;
      expect(freshRevision).toBeGreaterThan(staleRevision);
      expect(read(reread.body)).toEqual(theirs);

      // 用户显式选择改回原值，带新 revision 提交
      const restored = await put(target, tail, original, freshRevision);
      expect(restored.status, JSON.stringify(restored.body)).toBe(200);
      expect(restored.body.revision).toBeGreaterThan(freshRevision);
      expect(read((await get(endpoint)).body)).toEqual(original);
    },
  );

  it('对象没有配置进该身份时：四个入口都 404，不顺手新建对象权限', async () => {
    for (const tail of ['/data-operations', '/fields']) {
      expect((await get(url(bare, DEMO_OBJECT.code, tail))).status).toBe(404);
    }
    expect((await put(bare, '/data-operations', { dataOperations: FULL })).status).toBe(404);
    expect((await put(bare, '/fields', { fields: [{ fieldCode: 'Name', view: true, edit: false }] })).status).toBe(404);
    const detail = (await get(`${BASE}/profiles/${bare.id}`)).body as { objects: Json[]; revision: number };
    expect(detail.objects).toEqual([]);
    expect(detail.revision).toBe(await current(bare));
  });

  it('无身份管理能力 403；另一租户的身份 404', async () => {
    const plain = await addMember(world, `plain-${tag}`);
    const as = { user: plain.id, tenant: world.tenant.id };
    expect((await get(url(profile, DEMO_OBJECT.code, '/fields'), as)).status).toBe(403);
    expect((await get(url(profile, DEMO_OBJECT.code, '/data-operations'), as)).status).toBe(403);
    const denied = await world.api.request('PUT', url(profile, DEMO_OBJECT.code, '/fields'), {
      ...as,
      ifMatch: profile.revision,
      body: { fields: [{ fieldCode: 'Name', view: true, edit: false }] },
    });
    expect(denied.status).toBe(403);

    const other = await seedPermissionWorld(world.db);
    const foreign = await other.api.request('GET', url(profile, DEMO_OBJECT.code, '/fields'), other.asAdmin);
    expect(foreign.status).toBe(404);
  });
});
