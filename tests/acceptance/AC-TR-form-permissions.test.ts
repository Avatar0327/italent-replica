/**
 * AC-TR-form-permissions · R3-T04 PR-B3 盘点内容表单 / 流程定义的权限（定义侧；真实授权器；设计 §6.1、§6.4；DEC-080 / 121 / 082 / 043 / 306①）：
 * 表单与流程没有组织字段，数据范围只认看全部或创建人（缺省为空），新建只有看全部可建，范围外与不存在同一个 404；
 * 写入口 = 数据操作权 + 按钮，载荷逐字段校验编辑权（含显式清空）；引用字段（表单）/ 角色（流程）还须有对应目录的查看权，
 * 看不到的与不存在同一个 404；首次执行与幂等重放都在命令事务内按当前授权复核（撤按钮 / 撤范围 / 撤目录范围后重放被拒，
 * 业务、revision、台账、审计都不留痕）；响应按字段权限裁剪（键缺席）；列表筛选字段同受查看权约束。
 * 「步骤 × 表单逐字段三档」的运行侧（模板步骤选用表单）由 B6 / PR-C 覆盖，这里只覆盖表单定义本身的字段三档权限。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import { TR_BASE, TR_NOW } from './AC-TR-config-support.js';
import {
  FLOWS,
  FORMS,
  flowBody,
  formBody,
  formOperator,
  nodeBody,
  type FlowView,
  type FormView,
} from './AC-TR-form-flow-support.js';
import { errorCode, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const clock = () => TR_NOW;

interface Kind {
  readonly name: 'form' | 'flow';
  readonly path: string;
  /** 目录对象的路径与最小载荷（被引用方）。 */
  readonly catalogPath: string;
  readonly catalogBody: () => Record<string, unknown>;
  readonly body: (refId: string) => Record<string, unknown>;
  /** 载荷里“嵌套字段”的键（权限随字段）。 */
  readonly nested: 'fields' | 'nodes';
  /** 隐藏 / 只读用的普通字段。 */
  readonly plain: string;
}
const KINDS: Kind[] = [
  {
    name: 'form',
    path: FORMS,
    catalogPath: '/fields',
    catalogBody: () => ({
      code: `fld_${randomUUID().slice(0, 8)}`,
      name: `字段${randomUUID().slice(0, 4)}`,
      kind: 'text',
      group: 'evaluation',
    }),
    body: (refId) => formBody([{ fieldId: refId }]),
    nested: 'fields',
    plain: 'sortNo',
  },
  {
    name: 'flow',
    path: FLOWS,
    catalogPath: '/roles',
    catalogBody: () => ({
      code: `role_${randomUUID().slice(0, 8)}`,
      name: `角色${randomUUID().slice(0, 4)}`,
      resolver: 'self',
    }),
    body: (refId) => flowBody([nodeBody([refId])]),
    nested: 'nodes',
    plain: 'sortNo',
  },
];

describe.each(KINDS)('$name 权限（DEC-121 / 082 / 043 / 080）', (kind) => {
  let world: PermissionWorld;
  let setup: ReturnType<typeof tenantApi>;
  let existing: FormView & FlowView;
  const adminCreate = async (path: string, body: Record<string, unknown>) => {
    const response = await setup.request('POST', `${TR_BASE}${path}`, { ...world.asAdmin, ifMatch: 0, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as FormView & FlowView;
  };
  const ref = async () => (await adminCreate(kind.catalogPath, kind.catalogBody())).id;
  const adminRead = async (id: string) =>
    (await (await setup.request('GET', `${TR_BASE}${kind.path}/${id}`, world.asAdmin)).json()) as FormView & FlowView;
  const operator = (options: Parameters<typeof formOperator>[2] = {}) => formOperator(world, kind.name, options);

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock }) };
    setup = tenantApi(world.db, { clock });
    existing = await adminCreate(kind.path, kind.body(await ref()));
  });

  it('没有对象查看权：列表与详情 403', async () => {
    const denied = await operator({ view: false });
    expect((await denied.request('GET', kind.path)).status).toBe(403);
    expect((await denied.request('GET', `${kind.path}/${existing.id}`)).status).toBe(403);
  });

  it('有查看权、范围缺省为空：列表为空，他人建的详情 404，新建 / 修改 / 删除 404 且不落库', async () => {
    const op = await operator({ reference: 'seeAll' });
    expect(await (await op.request('GET', kind.path)).json()).toMatchObject({ items: [], hasDataPermission: false });
    const detail = await op.request('GET', `${kind.path}/${existing.id}`);
    expect([detail.status, await errorCode(detail)]).toEqual([404, 'NOT_FOUND']);
    const body = kind.body(await ref());
    expect((await op.request('POST', kind.path, { ifMatch: 0, body })).status).toBe(404);
    const patch = await op.request('PATCH', `${kind.path}/${existing.id}`, { ifMatch: 1, body: { enabled: false } });
    expect(patch.status).toBe(404);
    expect((await op.request('DELETE', `${kind.path}/${existing.id}`, { ifMatch: 1 })).status).toBe(404);
    expect(await adminRead(existing.id)).toEqual(existing);
  });

  it('引用目录需要对应查看权：没有 403；有查看权但引用在其范围外 404（与不存在相同）；看全部目录后可建', async () => {
    const given = await ref();
    const denied = await operator({ seeAll: true, reference: 'none' });
    const body = kind.body(given);
    const forbidden = await denied.request('POST', kind.path, { ifMatch: 0, body });
    expect([forbidden.status, await errorCode(forbidden)]).toEqual([403, 'FORBIDDEN']);
    const scoped = await operator({ seeAll: true, reference: 'creator' });
    const hidden = await scoped.request('POST', kind.path, { ifMatch: 0, body });
    const unknown = await scoped.request('POST', kind.path, {
      ifMatch: 0,
      body: kind.body('00000000-0000-4000-8000-000000000000'),
    });
    expect([hidden.status, await hidden.json()]).toEqual([unknown.status, await unknown.json()]);
    expect(hidden.status).toBe(404);
    const allowed = await operator({ seeAll: true, reference: 'seeAll' });
    const created = await allowed.request('POST', kind.path, { ifMatch: 0, body });
    expect(created.status, await created.clone().text()).toBe(201);
  });

  it('看全部：可见他人建的；撤掉看全部后自己建的也不可见', async () => {
    const op = await operator({ seeAll: true, reference: 'seeAll' });
    const list = (await (await op.request('GET', `${kind.path}?pageSize=100`)).json()) as { items: { id: string }[] };
    expect(list.items.map((item) => item.id)).toContain(existing.id);
    const created = await op.request('POST', kind.path, { ifMatch: 0, body: kind.body(await ref()) });
    expect(created.status, await created.clone().text()).toBe(201);
    const mine = (await created.json()) as { id: string };
    await op.setSeeAll('target', false);
    expect((await op.request('GET', `${kind.path}/${mine.id}`)).status).toBe(404);
  });

  it('隐藏字段：响应键缺席；写隐藏 / 只读字段（含显式清空）403，数据不变', async () => {
    const op = await operator({ seeAll: true, reference: 'seeAll', hidden: [kind.plain], readonly: [kind.nested] });
    const detail = (await (await op.request('GET', `${kind.path}/${existing.id}`)).json()) as object;
    expect(detail).toMatchObject({ id: existing.id, name: existing.name });
    expect(detail).not.toHaveProperty(kind.plain);
    const attempts = [{ [kind.plain]: 3 }, { [kind.nested]: existing[kind.nested] }];
    for (const body of attempts) {
      const response = await op.request('PATCH', `${kind.path}/${existing.id}`, { ifMatch: 1, body });
      expect(response.status, JSON.stringify(body)).toBe(403);
    }
    expect(await adminRead(existing.id)).toEqual(existing);
    const ok = await op.request('PATCH', `${kind.path}/${existing.id}`, { ifMatch: 1, body: { enabled: false } });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await ok.json()).not.toHaveProperty(kind.plain);
    existing = await adminRead(existing.id);
  });

  it('看不到 enabled 字段的人不能用 enabled 筛选（403），其他筛选不受影响', async () => {
    const op = await operator({ seeAll: true, hidden: ['enabled'] });
    const filtered = await op.request('GET', `${kind.path}?enabled=true`);
    expect([filtered.status, await errorCode(filtered)]).toEqual([403, 'FORBIDDEN']);
    expect((await op.request('GET', kind.path)).status).toBe(200);
  });

  it('撤按钮 / 撤范围 / 撤目录范围后：原命令重放被拒（403 / 404 / 404），业务与 revision 不变', async () => {
    const op = await operator({ seeAll: true, reference: 'seeAll' });
    const key = `trf-replay-${kind.name}-${randomUUID()}`;
    const options = { ifMatch: 0, idempotencyKey: key, body: kind.body(await ref()) };
    const created = await op.request('POST', kind.path, options);
    expect(created.status, await created.clone().text()).toBe(201);
    const mine = (await created.json()) as { id: string; revision: number };
    expect((await op.request('POST', kind.path, options)).status).toBe(201);
    await op.setButtons(false);
    expect((await op.request('POST', kind.path, options)).status).toBe(403);
    expect(
      (await op.request('PATCH', `${kind.path}/${mine.id}`, { ifMatch: 1, body: { enabled: false } })).status,
    ).toBe(403);
    expect((await op.request('DELETE', `${kind.path}/${mine.id}`, { ifMatch: 1 })).status).toBe(403);
    await op.setButtons(true);
    await op.setSeeAll('referenced', false);
    expect((await op.request('POST', kind.path, options)).status).toBe(404);
    await op.setSeeAll('referenced', true);
    await op.setSeeAll('target', false);
    expect((await op.request('POST', kind.path, options)).status).toBe(404);
    expect(await adminRead(mine.id)).toMatchObject({ id: mine.id, revision: 1 });
  });

  it('只缺 create 按钮：能改不能建', async () => {
    const op = await operator({ seeAll: true, reference: 'seeAll', omitButtons: ['create'] });
    const denied = await op.request('POST', kind.path, { ifMatch: 0, body: kind.body(await ref()) });
    expect(denied.status).toBe(403);
    const ok = await op.request('PATCH', `${kind.path}/${existing.id}`, { ifMatch: 2, body: { sortNo: 4 } });
    expect(ok.status, await ok.clone().text()).toBe(200);
  });
});
