/**
 * R3-T04 PR-A 准备度字典的权限（真实授权器；设计 §6.1、§6.5“配置对象”行；DEC-080 / 121 / 082 / 043）：
 * - 人才盘点是独立应用 TalentReview，对象权限只能挂在带该应用的身份上；
 * - 准备度没有组织字段：数据范围只认看全部或创建人（缺省为空），新建只有看全部可建，范围外与不存在同一个 404；
 * - 写入口 = 数据操作权 + 按钮，载荷逐字段校验编辑权（含显式清空）；撤按钮 / 撤范围后原命令重放同样被拒；
 * - 响应按字段权限裁剪（键缺席）。负向用例断言具体响应码，并前后各读一次比对。
 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import { errorCode, tenantApi } from './support/tenant-api.js';
import { readinessBody, readinessOperator, type ReadinessView, TR_BASE, TR_NOW } from './AC-TR-support.js';

const testDb = useTestDb();
const clock = () => TR_NOW;

describe('R3-T04 准备度字典权限（真实授权器；DEC-121 / 082 / 043）', () => {
  let world: PermissionWorld;
  let setup: ReturnType<typeof tenantApi>;
  let existing: ReadinessView;
  const adminRead = async (id: string) => {
    const response = await setup.request('GET', `${TR_BASE}/readiness-levels/${id}`, world.asAdmin);
    return (await response.json()) as ReadinessView;
  };

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock }) };
    setup = tenantApi(world.db, { clock });
    const response = await setup.request('POST', `${TR_BASE}/readiness-levels`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: readinessBody({ name: '管理员建的' }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    existing = (await response.json()) as ReadinessView;
  });

  it('没有对象查看权：列表与详情 403', async () => {
    const operator = await readinessOperator(world, { view: false });
    expect((await operator.request('GET', '/readiness-levels')).status).toBe(403);
    expect((await operator.request('GET', `/readiness-levels/${existing.id}`)).status).toBe(403);
  });

  it('有查看权、范围缺省为空：列表为空且 hasDataPermission = false，他人建的详情 404，新建 404 且不落库', async () => {
    const operator = await readinessOperator(world);
    expect(await (await operator.request('GET', '/readiness-levels')).json()).toMatchObject({
      items: [],
      hasDataPermission: false,
    });
    const detail = await operator.request('GET', `/readiness-levels/${existing.id}`);
    expect([detail.status, await errorCode(detail)]).toEqual([404, 'NOT_FOUND']);
    const body = readinessBody();
    const created = await operator.request('POST', '/readiness-levels', { ifMatch: 0, body });
    expect(created.status).toBe(404);
    const all = await setup.request('GET', `${TR_BASE}/readiness-levels`, world.asAdmin);
    expect(((await all.json()) as { items: { code: string }[] }).items.map((item) => item.code)).not.toContain(
      body.code,
    );
    const patch = await operator.request('PATCH', `/readiness-levels/${existing.id}`, {
      ifMatch: 1,
      body: { sortNo: 9 },
    });
    expect(patch.status).toBe(404);
    expect(await adminRead(existing.id)).toEqual(existing);
  });

  it('看全部：可见他人建的、可新建；创建人规则之外撤掉看全部后，自己建的仍不可见（无创建人规则）', async () => {
    const operator = await readinessOperator(world, { seeAll: true });
    const list = (await (await operator.request('GET', '/readiness-levels')).json()) as { items: { id: string }[] };
    expect(list.items.map((item) => item.id)).toContain(existing.id);
    const created = await operator.request('POST', '/readiness-levels', { ifMatch: 0, body: readinessBody() });
    expect(created.status, await created.clone().text()).toBe(201);
    const mine = (await created.json()) as ReadinessView;
    await operator.setSeeAll(false);
    expect((await operator.request('GET', `/readiness-levels/${mine.id}`)).status).toBe(404);
  });

  it('隐藏字段：响应里键缺席；写隐藏字段（含显式清空）403，数据不变', async () => {
    const operator = await readinessOperator(world, { seeAll: true, hidden: ['description'], readonly: ['color'] });
    const detail = (await (await operator.request('GET', `/readiness-levels/${existing.id}`)).json()) as object;
    expect(detail).toMatchObject({ id: existing.id, name: existing.name });
    expect(detail).not.toHaveProperty('description');
    for (const body of [{ description: null }, { description: '改' }, { color: '#000000' }]) {
      const response = await operator.request('PATCH', `/readiness-levels/${existing.id}`, { ifMatch: 1, body });
      expect(response.status, JSON.stringify(body)).toBe(403);
    }
    expect(await adminRead(existing.id)).toEqual(existing);
    const ok = await operator.request('PATCH', `/readiness-levels/${existing.id}`, { ifMatch: 1, body: { sortNo: 1 } });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await ok.json()).not.toHaveProperty('description');
    existing = await adminRead(existing.id);
  });

  it('撤掉按钮后，新请求与原命令重放都 403；撤掉看全部后重放 404', async () => {
    const operator = await readinessOperator(world, { seeAll: true });
    const options = { ifMatch: 0, idempotencyKey: `tr-replay-${Date.now()}`, body: readinessBody() };
    const first = await operator.request('POST', '/readiness-levels', options);
    expect(first.status).toBe(201);
    await operator.setButtons(false);
    expect((await operator.request('POST', '/readiness-levels', options)).status).toBe(403);
    const update = await operator.request('PATCH', `/readiness-levels/${existing.id}`, {
      ifMatch: existing.revision,
      body: { sortNo: 2 },
    });
    expect(update.status).toBe(403);
    await operator.setButtons(true);
    await operator.setSeeAll(false);
    const replay = await operator.request('POST', '/readiness-levels', options);
    expect(replay.status).toBe(404);
    expect(await adminRead(existing.id)).toEqual(existing);
  });
});
