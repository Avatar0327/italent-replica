/**
 * R3-T04 PR-B1 配置对象的权限（真实授权器；设计 §6.1、§6.5“配置对象”行；DEC-080 / 121 / 082 / 043）：
 * 盘点分类 / 角色 / 字段目录 / 租户设置都没有组织字段，数据范围只认看全部或创建人（缺省为空），新建只有看全部可建，
 * 范围外与不存在同一个 404；写入口 = 数据操作权 + 按钮，载荷逐字段校验编辑权（含显式清空）；
 * 撤按钮 / 撤范围后原命令重放同样被拒；响应按字段权限裁剪（键缺席）；列表筛选字段同受字段查看权约束。
 * 负向用例断言具体响应码，并前后各读一次比对。
 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import {
  CONFIG_KINDS,
  type ConfigKind,
  configBody,
  configOperator,
  type ConfigView,
  TR_BASE,
  TR_NOW,
} from './AC-TR-config-support.js';
import { errorCode, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const clock = () => TR_NOW;
/** 每种对象选一个可单独隐藏 / 锁定的非系统字段，以及一次合法的修改载荷。 */
const SAMPLE = {
  category: { secret: 'sortNo', attempt: { sortNo: 5 }, patch: { enabled: false } },
  role: { secret: 'resolver', attempt: { resolver: 'self' }, patch: { sortNo: 9 } },
  field: { secret: 'group', attempt: { group: 'result' }, patch: { sortNo: 9 } },
} as const;

describe.each(Object.keys(CONFIG_KINDS) as ConfigKind[])('配置对象权限 · %s（DEC-121 / 082 / 043）', (kind) => {
  const { path } = CONFIG_KINDS[kind];
  const { secret, attempt, patch } = SAMPLE[kind];
  let world: PermissionWorld;
  let setup: ReturnType<typeof tenantApi>;
  let existing: ConfigView;
  const adminRead = async (id: string) => {
    const response = await setup.request('GET', `${TR_BASE}${path}/${id}`, world.asAdmin);
    return (await response.json()) as ConfigView;
  };

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock }) };
    setup = tenantApi(world.db, { clock });
    const response = await setup.request('POST', `${TR_BASE}${path}`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: configBody(kind, { name: '管理员建的' }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    existing = (await response.json()) as ConfigView;
  });

  it('没有对象查看权：列表与详情 403', async () => {
    const operator = await configOperator(world, kind, { view: false });
    expect((await operator.request('GET', path)).status).toBe(403);
    expect((await operator.request('GET', `${path}/${existing.id}`)).status).toBe(403);
  });

  it('有查看权、范围缺省为空：列表为空，他人建的详情 404，新建 404 且不落库，修改 404', async () => {
    const operator = await configOperator(world, kind);
    expect(await (await operator.request('GET', path)).json()).toMatchObject({ items: [], hasDataPermission: false });
    const detail = await operator.request('GET', `${path}/${existing.id}`);
    expect([detail.status, await errorCode(detail)]).toEqual([404, 'NOT_FOUND']);
    const body = configBody(kind);
    expect((await operator.request('POST', path, { ifMatch: 0, body })).status).toBe(404);
    const all = await setup.request('GET', `${TR_BASE}${path}?pageSize=100`, world.asAdmin);
    const names = ((await all.json()) as { items: { name: string }[] }).items.map((item) => item.name);
    expect(names).not.toContain(body.name);
    expect((await operator.request('PATCH', `${path}/${existing.id}`, { ifMatch: 1, body: patch })).status).toBe(404);
    expect(await adminRead(existing.id)).toEqual(existing);
  });

  it('看全部：可见他人建的、可新建；撤掉看全部后，自己建的也不可见', async () => {
    const operator = await configOperator(world, kind, { seeAll: true });
    const list = (await (await operator.request('GET', `${path}?pageSize=100`)).json()) as { items: { id: string }[] };
    expect(list.items.map((item) => item.id)).toContain(existing.id);
    const created = await operator.request('POST', path, { ifMatch: 0, body: configBody(kind) });
    expect(created.status, await created.clone().text()).toBe(201);
    const mine = (await created.json()) as ConfigView;
    await operator.setSeeAll(false);
    expect((await operator.request('GET', `${path}/${mine.id}`)).status).toBe(404);
  });

  it('隐藏字段：响应里键缺席；写隐藏 / 只读字段 403，数据不变', async () => {
    const operator = await configOperator(world, kind, { seeAll: true, hidden: [secret], readonly: ['name'] });
    const detail = (await (await operator.request('GET', `${path}/${existing.id}`)).json()) as object;
    expect(detail).toMatchObject({ id: existing.id });
    expect(detail).not.toHaveProperty(secret);
    for (const body of [attempt, { name: '改' }]) {
      const response = await operator.request('PATCH', `${path}/${existing.id}`, { ifMatch: 1, body });
      expect(response.status, JSON.stringify(body)).toBe(403);
    }
    expect(await adminRead(existing.id)).toEqual(existing);
    const ok = await operator.request('PATCH', `${path}/${existing.id}`, { ifMatch: 1, body: patch });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await ok.json()).not.toHaveProperty(secret);
    existing = await adminRead(existing.id);
  });

  it('看不到 enabled 字段的人不能用 enabled 筛选（403），其他筛选不受影响', async () => {
    const operator = await configOperator(world, kind, { seeAll: true, hidden: ['enabled'] });
    const filtered = await operator.request('GET', `${path}?enabled=true`);
    expect([filtered.status, await errorCode(filtered)]).toEqual([403, 'FORBIDDEN']);
    expect((await operator.request('GET', path)).status).toBe(200);
  });

  it('撤掉按钮后，新请求与原命令重放都 403；撤掉看全部后重放 404', async () => {
    const operator = await configOperator(world, kind, { seeAll: true });
    const options = { ifMatch: 0, idempotencyKey: `trc-replay-${kind}-${Date.now()}`, body: configBody(kind) };
    expect((await operator.request('POST', path, options)).status).toBe(201);
    await operator.setButtons(false);
    expect((await operator.request('POST', path, options)).status).toBe(403);
    const update = await operator.request('PATCH', `${path}/${existing.id}`, {
      ifMatch: existing.revision,
      body: patch,
    });
    expect(update.status).toBe(403);
    await operator.setButtons(true);
    await operator.setSeeAll(false);
    expect((await operator.request('POST', path, options)).status).toBe(404);
    expect(await adminRead(existing.id)).toEqual(existing);
  });
});

describe('租户设置权限（单例资源，只有看全部可读写）', () => {
  let world: PermissionWorld;
  let setup: ReturnType<typeof tenantApi>;
  const adminRead = async () => (await setup.request('GET', `${TR_BASE}/settings`, world.asAdmin)).json();

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock }) };
    setup = tenantApi(world.db, { clock });
  });

  it('没有查看权 403；没有看全部 404（读与写都不暴露设置是否存在）', async () => {
    const none = await configOperator(world, 'settings', { view: false });
    expect((await none.request('GET', '/settings')).status).toBe(403);
    const operator = await configOperator(world, 'settings');
    const before = await adminRead();
    expect((await operator.request('GET', '/settings')).status).toBe(404);
    const write = await operator.request('PATCH', '/settings', { ifMatch: 0, body: { selfResultVisible: true } });
    expect(write.status).toBe(404);
    expect(await adminRead()).toEqual(before);
  });

  it('看全部：可读可写；隐藏系统主体字段后键缺席、写它（含清空）403；撤按钮后写 403', async () => {
    const operator = await configOperator(world, 'settings', { seeAll: true, hidden: ['systemPrincipalUserId'] });
    const read = (await (await operator.request('GET', '/settings')).json()) as object;
    expect(read).toMatchObject({ selfResultVisible: false });
    expect(read).not.toHaveProperty('systemPrincipalUserId');
    for (const body of [{ systemPrincipalUserId: null }, { systemPrincipalUserId: world.asAdmin.user }]) {
      const response = await operator.request('PATCH', '/settings', { ifMatch: 0, body });
      expect(response.status, JSON.stringify(body)).toBe(403);
    }
    const ok = await operator.request('PATCH', '/settings', { ifMatch: 0, body: { selfResultVisible: true } });
    expect(ok.status, await ok.clone().text()).toBe(200);
    await operator.setButtons(false);
    const denied = await operator.request('PATCH', '/settings', { ifMatch: 1, body: { selfResultVisible: false } });
    expect(denied.status).toBe(403);
    expect(await adminRead()).toMatchObject({ selfResultVisible: true, revision: 1 });
  });
});
