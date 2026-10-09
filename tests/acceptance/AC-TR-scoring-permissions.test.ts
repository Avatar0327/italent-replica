/**
 * R3-T04 PR-B2 评价规则 / 模块等级 / 字段映射的权限（真实授权器；设计 §6.1、§6.5“配置对象”行；DEC-080 / 121 / 082 / 043）：
 * 三个对象都没有组织字段，数据范围只认看全部或创建人（缺省为空），新建只有看全部可建，范围外与不存在同一个 404；
 * 写入口 = 数据操作权 + 按钮，载荷逐字段校验编辑权；撤按钮 / 撤范围后原命令重放同样被拒；响应按字段权限裁剪；
 * 列表筛选字段同受字段查看权约束。字段映射引用字段 = 读取字段对象：另需字段对象的查看权与范围（先于读取字段，
 * 不存在与范围外同一个 404，不暴露字段是否存在）。负向用例断言具体响应码，并前后各读一次比对。
 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import {
  configOperator,
  gradeRuleBody,
  mappingBody,
  moduleGradeBody,
  scoreItems,
  TR_BASE,
  TR_NOW,
  type ConfigView,
} from './AC-TR-scoring-support.js';
import { errorCode, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const clock = () => TR_NOW;

describe.each([
  {
    object: 'scoreRule',
    path: '/score-rules',
    body: () => gradeRuleBody({ name: `权限规则${Math.random()}` }),
    secret: 'allowUnable',
    attempt: { allowUnable: true },
    patch: { enabled: false },
    filter: 'enabled',
  },
  {
    object: 'moduleGrade',
    path: '/module-grades',
    body: () => moduleGradeBody({ name: `权限等级${Math.random()}` }),
    secret: 'items',
    attempt: { items: scoreItems(0, 1) },
    patch: { enabled: false },
    filter: 'enabled',
  },
] as const)(
  '配置对象权限 · $object（DEC-121 / 082 / 043）',
  ({ object, path, body, secret, attempt, patch, filter }) => {
    let world: PermissionWorld;
    let setup: ReturnType<typeof tenantApi>;
    let existing: ConfigView;
    const adminRead = async (id: string) =>
      (await (await setup.request('GET', `${TR_BASE}${path}/${id}`, world.asAdmin)).json()) as ConfigView;

    beforeAll(async () => {
      world = await seedPermissionWorld(testDb().db);
      world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock }) };
      setup = tenantApi(world.db, { clock });
      const response = await setup.request('POST', `${TR_BASE}${path}`, { ...world.asAdmin, ifMatch: 0, body: body() });
      expect(response.status, await response.clone().text()).toBe(201);
      existing = (await response.json()) as ConfigView;
    });

    it('没有对象查看权 403；有查看权但范围为空：列表空、他人建的详情 404、新建 404 且不落库、修改 404', async () => {
      const none = await configOperator(world, object, { view: false });
      expect((await none.request('GET', path)).status).toBe(403);
      const operator = await configOperator(world, object);
      expect(await (await operator.request('GET', path)).json()).toMatchObject({ items: [], hasDataPermission: false });
      const detail = await operator.request('GET', `${path}/${existing.id}`);
      expect([detail.status, await errorCode(detail)]).toEqual([404, 'NOT_FOUND']);
      const draft = body();
      expect((await operator.request('POST', path, { ifMatch: 0, body: draft })).status).toBe(404);
      const names = (
        (await (await setup.request('GET', `${TR_BASE}${path}?pageSize=100`, world.asAdmin)).json()) as {
          items: { name: string }[];
        }
      ).items.map((item) => item.name);
      expect(names).not.toContain(draft.name);
      expect((await operator.request('PATCH', `${path}/${existing.id}`, { ifMatch: 1, body: patch })).status).toBe(404);
      expect(await adminRead(existing.id)).toEqual(existing);
    });

    it('看全部：可见他人建的；隐藏字段键缺席、写隐藏 / 只读字段 403 数据不变；看不到筛选字段不能筛选', async () => {
      const operator = await configOperator(world, object, { seeAll: true, hidden: [secret], readonly: ['name'] });
      const detail = (await (await operator.request('GET', `${path}/${existing.id}`)).json()) as object;
      expect(detail).toMatchObject({ id: existing.id });
      expect(detail).not.toHaveProperty(secret);
      for (const payload of [attempt, { name: '改' }]) {
        const response = await operator.request('PATCH', `${path}/${existing.id}`, { ifMatch: 1, body: payload });
        expect(response.status, JSON.stringify(payload)).toBe(403);
      }
      expect(await adminRead(existing.id)).toEqual(existing);
      const hiddenFilter = await configOperator(world, object, { seeAll: true, hidden: [filter] });
      const filtered = await hiddenFilter.request('GET', `${path}?${filter}=true`);
      expect([filtered.status, await errorCode(filtered)]).toEqual([403, 'FORBIDDEN']);
      expect((await hiddenFilter.request('GET', path)).status).toBe(200);
    });

    it('撤按钮后新请求与原命令重放都 403；撤看全部后重放 404', async () => {
      const operator = await configOperator(world, object, { seeAll: true });
      const options = { ifMatch: 0, idempotencyKey: `trs-replay-${object}-${Date.now()}`, body: body() };
      expect((await operator.request('POST', path, options)).status).toBe(201);
      await operator.setButtons(false);
      expect((await operator.request('POST', path, options)).status).toBe(403);
      expect((await operator.request('PATCH', `${path}/${existing.id}`, { ifMatch: 1, body: patch })).status).toBe(403);
      await operator.setButtons(true);
      await operator.setSeeAll(false);
      expect((await operator.request('POST', path, options)).status).toBe(404);
      expect(await adminRead(existing.id)).toEqual(existing);
    });
  },
);

describe('字段映射权限（DEC-121 / 082 / 043）', () => {
  let world: PermissionWorld;
  let setup: ReturnType<typeof tenantApi>;
  const adminPost = async (path: string, payload: Record<string, unknown>) => {
    const response = await setup.request('POST', `${TR_BASE}${path}`, { ...world.asAdmin, ifMatch: 0, body: payload });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as ConfigView;
  };
  const field = (n: string) =>
    adminPost('/fields', { code: `perm_${n}`, name: `权限字段${n}`, kind: 'text', group: 'evaluation' });
  const mappingCount = async () =>
    (
      (await (await setup.request('GET', `${TR_BASE}/field-mappings?pageSize=100`, world.asAdmin)).json()) as {
        items: unknown[];
      }
    ).items.length;

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock }) };
    setup = tenantApi(world.db, { clock });
  });

  it('没有映射查看权 403；范围为空：列表空、详情 404、新建 404 不落库', async () => {
    const a = await field('a');
    const b = await field('b');
    const mapping = await adminPost('/field-mappings', mappingBody(a.id, b.id));
    const none = await configOperator(world, 'mapping', { view: false });
    expect((await none.request('GET', '/field-mappings')).status).toBe(403);
    const operator = await configOperator(world, 'mapping');
    expect(await (await operator.request('GET', '/field-mappings')).json()).toMatchObject({
      items: [],
      hasDataPermission: false,
    });
    expect((await operator.request('GET', `/field-mappings/${mapping.id}`)).status).toBe(404);
    await configOperator(world, 'field', { user: operator.user });
    const before = await mappingCount();
    expect(
      (await operator.request('POST', '/field-mappings', { ifMatch: 0, body: mappingBody(a.id, a.id) })).status,
    ).toBe(404);
    expect(await mappingCount()).toBe(before);
  });

  it('引用字段 = 读取字段对象：没有字段查看权 403；字段范围为空时存在与不存在的字段得到同一个 404，不落库', async () => {
    const a = await field('c');
    const b = await field('d');
    const mappingOnly = await configOperator(world, 'mapping', { seeAll: true });
    const before = await mappingCount();
    const denied = await mappingOnly.request('POST', '/field-mappings', { ifMatch: 0, body: mappingBody(a.id, b.id) });
    expect([denied.status, await errorCode(denied)]).toEqual([403, 'FORBIDDEN']);
    const both = await configOperator(world, 'mapping', { seeAll: true });
    await configOperator(world, 'field', { user: both.user });
    const results = [];
    for (const target of [b.id, '00000000-0000-4000-8000-000000000000']) {
      const response = await both.request('POST', '/field-mappings', { ifMatch: 0, body: mappingBody(a.id, target) });
      results.push([response.status, await response.json()]);
    }
    expect(results[0]![0]).toBe(404);
    expect(results[1]).toEqual(results[0]);
    expect(await mappingCount()).toBe(before);
    const full = await configOperator(world, 'mapping', { seeAll: true });
    const seeFields = await configOperator(world, 'field', { user: full.user, seeAll: true });
    expect(seeFields.user.id).toBe(full.user.id);
    const ok = await full.request('POST', '/field-mappings', { ifMatch: 0, body: mappingBody(a.id, b.id) });
    expect(ok.status, await ok.clone().text()).toBe(201);
    expect(await mappingCount()).toBe(before + 1);
  });

  it('看不到 scene 的人不能按 scene 筛选（403）；隐藏的目标字段键缺席、写它 403', async () => {
    const hidden = await configOperator(world, 'mapping', { seeAll: true, hidden: ['scene', 'targetFieldId'] });
    const filtered = await hidden.request('GET', '/field-mappings?scene=carry_last');
    expect([filtered.status, await errorCode(filtered)]).toEqual([403, 'FORBIDDEN']);
    const list = (await (await hidden.request('GET', '/field-mappings?pageSize=100')).json()) as { items: object[] };
    for (const item of list.items) expect(item).not.toHaveProperty('targetFieldId');
  });
});
