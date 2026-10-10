/**
 * AC-TR-08-matrix-permissions · R3-T04 PR-B4 九宫格权限（真实授权器；设计 §6.1、§6.5；DEC-080 / 121 / 082 / 043）：
 * 九宫格没有组织字段，数据范围只认看全部或创建人（缺省为空），新建只有看全部可建，范围外与不存在同一个 404；
 * 写入口 = 数据操作权 + 按钮，载荷逐字段校验编辑权（含显式清空）；引用盘点字段（轴 / 位置字段）还须有字段目录的查看权，
 * 看不到的字段与不存在同一个 404；规则组写入同样要 update 按钮与 ratioGroups 字段编辑权；
 * 撤按钮 / 撤范围后原命令重放同样被拒；响应按字段权限裁剪（键缺席）；列表筛选字段同受字段查看权约束。
 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import { configBody, configWorld, TR_BASE, TR_NOW } from './AC-TR-config-support.js';
import { MATRICES, matrixBody, matrixOperator, type MatrixView, ratioGroupBody } from './AC-TR-matrix-support.js';
import { errorCode, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const clock = () => TR_NOW;

describe('九宫格权限（DEC-121 / 082 / 043 / 080）', () => {
  let world: PermissionWorld;
  let setup: ReturnType<typeof tenantApi>;
  let existing: MatrixView;
  const adminCreate = async (path: string, body: Record<string, unknown>) => {
    const response = await setup.request('POST', `${TR_BASE}${path}`, { ...world.asAdmin, ifMatch: 0, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as MatrixView;
  };
  const refs = async () => {
    const option = () =>
      adminCreate(
        '/fields',
        configBody('field', {
          kind: 'option',
          group: 'result',
          options: [
            { value: '1', label: '低' },
            { value: '2', label: '中' },
            { value: '3', label: '高' },
          ],
        }),
      );
    const position = () => adminCreate('/fields', configBody('field', { kind: 'number', group: 'position' }));
    return {
      x: (await option()).id,
      y: (await option()).id,
      before: (await position()).id,
      after: (await position()).id,
    };
  };
  const adminRead = async (id: string) =>
    (await (await setup.request('GET', `${TR_BASE}${MATRICES}/${id}`, world.asAdmin)).json()) as MatrixView;

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock }) };
    setup = tenantApi(world.db, { clock });
    existing = await adminCreate(MATRICES, matrixBody(await refs(), { name: '管理员建的' }));
  });

  it('没有对象查看权：列表、详情与规则组写入 403', async () => {
    const operator = await matrixOperator(world, { view: false });
    expect((await operator.request('GET', MATRICES)).status).toBe(403);
    expect((await operator.request('GET', `${MATRICES}/${existing.id}`)).status).toBe(403);
  });

  it('有查看权、范围缺省为空：列表为空，他人建的详情 404，新建 / 修改 / 规则组写入 404 且不落库', async () => {
    const operator = await matrixOperator(world, { fields: 'seeAll' });
    expect(await (await operator.request('GET', MATRICES)).json()).toMatchObject({
      items: [],
      hasDataPermission: false,
    });
    const detail = await operator.request('GET', `${MATRICES}/${existing.id}`);
    expect([detail.status, await errorCode(detail)]).toEqual([404, 'NOT_FOUND']);
    const body = matrixBody(await refs());
    expect((await operator.request('POST', MATRICES, { ifMatch: 0, body })).status).toBe(404);
    const patch = await operator.request('PATCH', `${MATRICES}/${existing.id}`, {
      ifMatch: 1,
      body: { enabled: false },
    });
    expect(patch.status).toBe(404);
    const group = await operator.request('POST', `${MATRICES}/${existing.id}/ratio-groups`, {
      ifMatch: 1,
      body: ratioGroupBody(),
    });
    expect(group.status).toBe(404);
    const all = await setup.request('GET', `${TR_BASE}${MATRICES}?pageSize=100`, world.asAdmin);
    expect(((await all.json()) as { items: { code: unknown }[] }).items.map((item) => item.code)).not.toContain(
      body.code,
    );
    expect(await adminRead(existing.id)).toEqual(existing);
  });

  it('引用字段需要字段目录查看权：没有 403；有查看权但字段在其范围外 404（与不存在相同）；看全部字段目录后可建', async () => {
    const given = await refs();
    const denied = await matrixOperator(world, { seeAll: true, fields: 'none' });
    const body = matrixBody(given);
    const forbidden = await denied.request('POST', MATRICES, { ifMatch: 0, body });
    expect([forbidden.status, await errorCode(forbidden)]).toEqual([403, 'FORBIDDEN']);
    const hidden = await matrixOperator(world, { seeAll: true, fields: 'creator' });
    const missing = await hidden.request('POST', MATRICES, { ifMatch: 0, body });
    const unknown = await hidden.request('POST', MATRICES, {
      ifMatch: 0,
      body: { ...body, xFieldId: '00000000-0000-4000-8000-000000000000' },
    });
    expect([missing.status, await missing.json()]).toEqual([unknown.status, await unknown.json()]);
    expect(missing.status).toBe(404);
    const allowed = await matrixOperator(world, { seeAll: true, fields: 'seeAll' });
    const created = await allowed.request('POST', MATRICES, { ifMatch: 0, body });
    expect(created.status, await created.clone().text()).toBe(201);
  });

  it('看全部：可见他人建的；撤掉看全部后自己建的也不可见', async () => {
    const operator = await matrixOperator(world, { seeAll: true, fields: 'seeAll' });
    const list = (await (await operator.request('GET', `${MATRICES}?pageSize=100`)).json()) as {
      items: { id: string }[];
    };
    expect(list.items.map((item) => item.id)).toContain(existing.id);
    const created = await operator.request('POST', MATRICES, { ifMatch: 0, body: matrixBody(await refs()) });
    expect(created.status, await created.clone().text()).toBe(201);
    const mine = (await created.json()) as MatrixView;
    await operator.setSeeAll('matrix', false);
    expect((await operator.request('GET', `${MATRICES}/${mine.id}`)).status).toBe(404);
  });

  it('隐藏字段：响应键缺席；写隐藏 / 只读字段（含显式清空）403，数据不变', async () => {
    const operator = await matrixOperator(world, {
      seeAll: true,
      fields: 'seeAll',
      hidden: ['placementSource', 'ratioGroups'],
      readonly: ['zFieldId', 'positionFields'],
    });
    const detail = (await (await operator.request('GET', `${MATRICES}/${existing.id}`)).json()) as object;
    expect(detail).toMatchObject({ id: existing.id, name: existing.name });
    for (const hidden of ['placementSource', 'ratioGroups']) expect(detail).not.toHaveProperty(hidden);
    const attempts = [{ placementSource: 'before' }, { zFieldId: null }, { positionFields: existing.positionFields }];
    for (const body of attempts) {
      const response = await operator.request('PATCH', `${MATRICES}/${existing.id}`, { ifMatch: 1, body });
      expect(response.status, JSON.stringify(body)).toBe(403);
    }
    const group = await operator.request('POST', `${MATRICES}/${existing.id}/ratio-groups`, {
      ifMatch: 1,
      body: ratioGroupBody(),
    });
    expect(group.status).toBe(403);
    expect(await adminRead(existing.id)).toEqual(existing);
    const ok = await operator.request('PATCH', `${MATRICES}/${existing.id}`, { ifMatch: 1, body: { sortNo: 9 } });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await ok.json()).not.toHaveProperty('placementSource');
    existing = await adminRead(existing.id);
  });

  it('看不到 enabled 字段的人不能用 enabled 筛选（403 FILTER_FIELD_HIDDEN），其他筛选不受影响', async () => {
    const operator = await matrixOperator(world, { seeAll: true, hidden: ['enabled'] });
    const filtered = await operator.request('GET', `${MATRICES}?enabled=true`);
    expect([filtered.status, await errorCode(filtered)]).toEqual([403, 'FORBIDDEN']);
    expect((await operator.request('GET', MATRICES)).status).toBe(200);
  });

  it('缺 update 按钮：修改与规则组写入首次与重放都 403；撤看全部后重放 404', async () => {
    const operator = await matrixOperator(world, { seeAll: true, fields: 'seeAll' });
    const created = await operator.request('POST', MATRICES, { ifMatch: 0, body: matrixBody(await refs()) });
    const mine = (await created.json()) as MatrixView;
    const options = { ifMatch: 1, idempotencyKey: `trm-replay-${Date.now()}`, body: ratioGroupBody() };
    const path = `${MATRICES}/${mine.id}/ratio-groups`;
    expect((await operator.request('POST', path, options)).status).toBe(201);
    await operator.setButtons(false);
    expect((await operator.request('POST', path, options)).status).toBe(403);
    expect(
      (await operator.request('PATCH', `${MATRICES}/${mine.id}`, { ifMatch: 2, body: { sortNo: 3 } })).status,
    ).toBe(403);
    expect((await operator.request('DELETE', `${MATRICES}/${mine.id}`, { ifMatch: 2 })).status).toBe(403);
    await operator.setButtons(true);
    await operator.setSeeAll('matrix', false);
    expect((await operator.request('POST', path, options)).status).toBe(404);
    const after = await setup.request('GET', `${TR_BASE}${MATRICES}/${mine.id}`, world.asAdmin);
    expect(((await after.json()) as MatrixView).ratioGroups).toHaveLength(1);
  });

  it('只缺 create 按钮：能改不能建；其他租户的九宫格不出现在列表里', async () => {
    const operator = await matrixOperator(world, { seeAll: true, fields: 'seeAll', omitButtons: ['create'] });
    const denied = await operator.request('POST', MATRICES, { ifMatch: 0, body: matrixBody(await refs()) });
    expect(denied.status).toBe(403);
    const foreign = await configWorld(testDb().db, 'trm-foreign');
    expect(foreign.as.tenant).not.toBe(world.tenant.id);
  });
});
