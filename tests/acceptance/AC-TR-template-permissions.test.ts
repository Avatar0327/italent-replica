/**
 * R3-T04 PR-B6a 盘点模板的权限（真实授权器；设计 §6.1、§6.2、§6.5“配置对象”行；DEC-080 / 043 / 082）：
 * - 数据范围：所属组织（用户 × TalentReview 的管理单元）∪ 创建人，缺省为空；范围外与不存在同一个 404；新建 / 改所属组织须目标组织在范围内；
 * - 向下公开：范围内组织的上级组织的公开模板可读（accessLevel = readonly），不可改不可删（403 TEMPLATE_PUBLIC_DOWN_READONLY）；
 * - 引用目录对象（流程 / 评价规则 / 模块等级 / 字段）= 读取目录：另需其查看权（403）与范围（不存在与范围外同一个 404）；
 * - 写入口 = 数据操作权 + 按钮，载荷逐字段校验编辑权（含显式清空）；响应按字段权限裁剪；筛选字段先校验查看权。
 * 负向用例断言具体响应码，并前后各读一次比对。
 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import { createOrg } from './AC-IDP-support.js';
import {
  indicatorModule,
  reasonOf,
  templateBody,
  TEMPLATES,
  templateOperator,
  TR_BASE,
  TR_NOW,
  type TemplateView,
} from './AC-TR-template-support.js';
import { configBody } from './AC-TR-config-support.js';
import { flowBody, nodeBody } from './AC-TR-form-flow-support.js';
import { scoreRuleBody } from './AC-TR-scoring-support.js';
import { errorCode, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const clock = () => TR_NOW;

describe('盘点模板权限（TR-R3 同谓词、DEC-043 / 082）', () => {
  let world: PermissionWorld;
  let setup: ReturnType<typeof tenantApi>;
  const ids = { parentOrg: '', insideOrg: '', outsideOrg: '', flow: '', rule: '' };
  const created: Record<'inside' | 'closed' | 'outside' | 'parentPublic' | 'parentClosed', TemplateView> = {} as never;
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await setup.request('POST', `${TR_BASE}${path}`, { ...world.asAdmin, ifMatch: 0, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as T;
  };
  const adminRead = async (id: string) =>
    (await (await setup.request('GET', `${TR_BASE}${TEMPLATES}/${id}`, world.asAdmin)).json()) as TemplateView;

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock }) };
    setup = tenantApi(world.db, { clock });
    ids.parentOrg = await createOrg(setup, world.asAdmin, '总部');
    ids.insideOrg = await createOrg(setup, world.asAdmin, '研发部', ids.parentOrg);
    ids.outsideOrg = await createOrg(setup, world.asAdmin, '市场部');
    const role = await post<{ id: string }>('/roles', configBody('role'));
    const flow = await post<{ id: string }>('/flows', flowBody([nodeBody([role.id])]));
    const rule = await post<{ id: string }>('/score-rules', scoreRuleBody());
    ids.flow = flow.id;
    ids.rule = rule.id;
    const make = (orgId: string, extra: Record<string, unknown> = {}) =>
      post<TemplateView>(TEMPLATES, templateBody(orgId, { flowId: flow.id, ...extra }));
    created.inside = await make(ids.insideOrg, { modules: [indicatorModule(rule.id, { name: '业绩' })] });
    created.closed = await make(ids.insideOrg);
    created.outside = await make(ids.outsideOrg);
    created.parentPublic = await make(ids.parentOrg, { downwardPublic: true });
    created.parentClosed = await make(ids.parentOrg);
  });

  it('没有模板查看权 403；有查看权但范围为空：列表空 + hasDataPermission = false、详情 / 修改 / 新建都 404 且不落库', async () => {
    const none = await templateOperator(world, { view: false });
    expect((await none.request('GET', TEMPLATES)).status).toBe(403);
    const op = await templateOperator(world, { references: 'seeAll' });
    expect(await (await op.request('GET', TEMPLATES)).json()).toMatchObject({ items: [], hasDataPermission: false });
    for (const id of [created.inside.id, created.outside.id]) {
      const detail = await op.request('GET', `${TEMPLATES}/${id}`);
      expect([detail.status, await errorCode(detail)]).toEqual([404, 'NOT_FOUND']);
    }
    const before = await adminRead(created.inside.id);
    const patch = await op.request('PATCH', `${TEMPLATES}/${created.inside.id}`, {
      ifMatch: before.revision,
      body: { name: '改' },
    });
    expect(patch.status).toBe(404);
    const create = await op.request('POST', TEMPLATES, {
      ifMatch: 0,
      body: templateBody(ids.insideOrg, { name: '越权新建' }),
    });
    expect(create.status).toBe(404);
    const names = (
      (await (await setup.request('GET', `${TR_BASE}${TEMPLATES}?pageSize=100`, world.asAdmin)).json()) as {
        items: { name: string }[];
      }
    ).items.map((i) => i.name);
    expect(names).not.toContain('越权新建');
    expect(await adminRead(created.inside.id)).toEqual(before);
  });

  it('组织范围内可读写：列表只含范围内（含下级）与向下公开的模板；范围外 404；新建 / 改所属组织须目标组织在范围内', async () => {
    const op = await templateOperator(world, { orgId: ids.insideOrg, references: 'seeAll' });
    const list = (await (await op.request('GET', `${TEMPLATES}?pageSize=100`)).json()) as {
      items: { id: string; accessLevel: string }[];
      hasDataPermission: boolean;
    };
    const byId = new Map(list.items.map((item) => [item.id, item.accessLevel]));
    expect(list.hasDataPermission).toBe(true);
    expect(byId.get(created.inside.id)).toBe('manage');
    expect(byId.get(created.closed.id)).toBe('manage');
    expect(byId.get(created.parentPublic.id)).toBe('readonly');
    expect(byId.has(created.outside.id)).toBe(false);
    expect(byId.has(created.parentClosed.id)).toBe(false);
    expect((await op.request('GET', `${TEMPLATES}/${created.outside.id}`)).status).toBe(404);
    expect((await op.request('GET', `${TEMPLATES}/${created.parentClosed.id}`)).status).toBe(404);
    const ok = await op.request('POST', TEMPLATES, {
      ifMatch: 0,
      body: templateBody(ids.insideOrg, { flowId: ids.flow }),
    });
    expect(ok.status, await ok.clone().text()).toBe(201);
    const outside = await op.request('POST', TEMPLATES, { ifMatch: 0, body: templateBody(ids.outsideOrg) });
    expect(outside.status).toBe(404);
    const before = await adminRead(created.inside.id);
    const move = await op.request('PATCH', `${TEMPLATES}/${created.inside.id}`, {
      ifMatch: before.revision,
      body: { ownerOrgId: ids.outsideOrg },
    });
    expect(move.status).toBe(404);
    expect(await adminRead(created.inside.id)).toEqual(before);
  });

  it('向下公开：下级只读——修改 / 删除 403 TEMPLATE_PUBLIC_DOWN_READONLY，数据不变；详情带 accessLevel = readonly', async () => {
    const op = await templateOperator(world, { orgId: ids.insideOrg, references: 'seeAll' });
    const detail = (await (await op.request('GET', `${TEMPLATES}/${created.parentPublic.id}`)).json()) as TemplateView;
    expect(detail.accessLevel).toBe('readonly');
    const before = await adminRead(created.parentPublic.id);
    const patch = await op.request('PATCH', `${TEMPLATES}/${before.id}`, {
      ifMatch: before.revision,
      body: { name: '下级改' },
    });
    expect([patch.status, await reasonOf(patch)]).toEqual([403, 'TEMPLATE_PUBLIC_DOWN_READONLY']);
    const del = await op.request('DELETE', `${TEMPLATES}/${before.id}`, { ifMatch: before.revision });
    expect([del.status, await reasonOf(del)]).toEqual([403, 'TEMPLATE_PUBLIC_DOWN_READONLY']);
    expect(await adminRead(before.id)).toEqual(before);
  });

  it('引用目录对象：没有目录查看权 403；目录对象在范围外与不存在同一个 404；模块里引用的评价规则同理', async () => {
    const noCatalog = await templateOperator(world, { orgId: ids.insideOrg, references: 'none' });
    const denied = await noCatalog.request('POST', TEMPLATES, {
      ifMatch: 0,
      body: templateBody(ids.insideOrg, { flowId: ids.flow }),
    });
    expect([denied.status, await errorCode(denied)]).toEqual([403, 'FORBIDDEN']);
    const creatorOnly = await templateOperator(world, { orgId: ids.insideOrg });
    const ghost = '00000000-0000-4000-8000-0000000000aa';
    const outOfScope = await creatorOnly.request('POST', TEMPLATES, {
      ifMatch: 0,
      body: templateBody(ids.insideOrg, { flowId: ids.flow }),
    });
    const notFound = await creatorOnly.request('POST', TEMPLATES, {
      ifMatch: 0,
      body: templateBody(ids.insideOrg, { flowId: ghost }),
    });
    expect(outOfScope.status).toBe(404);
    expect(await outOfScope.json()).toEqual(await notFound.json());
    const rule = await creatorOnly.request('POST', TEMPLATES, {
      ifMatch: 0,
      body: templateBody(ids.insideOrg, { modules: [indicatorModule(ids.rule)] }),
    });
    expect(rule.status).toBe(404);
  });

  it('字段权限：隐藏的字段键缺席、写隐藏 / 只读字段 403 数据不变；看不到 enabled 不能按它筛选；缺新建按钮 403', async () => {
    const op = await templateOperator(world, {
      orgId: ids.insideOrg,
      references: 'seeAll',
      hidden: ['modules', 'enabled'],
      readonly: ['name'],
    });
    const detail = (await (await op.request('GET', `${TEMPLATES}/${created.inside.id}`)).json()) as object;
    expect(detail).toMatchObject({ id: created.inside.id });
    for (const key of ['modules', 'enabled']) expect(detail).not.toHaveProperty(key);
    const before = await adminRead(created.inside.id);
    for (const body of [{ modules: [] }, { name: '只读字段' }, { enabled: true }]) {
      const response = await op.request('PATCH', `${TEMPLATES}/${before.id}`, { ifMatch: before.revision, body });
      expect(response.status, JSON.stringify(body)).toBe(403);
    }
    expect(await adminRead(before.id)).toEqual(before);
    const filtered = await op.request('GET', `${TEMPLATES}?enabled=true`);
    expect([filtered.status, await errorCode(filtered)]).toEqual([403, 'FORBIDDEN']);
    const noButton = await templateOperator(world, { orgId: ids.insideOrg, references: 'seeAll', buttons: false });
    const create = await noButton.request('POST', TEMPLATES, { ifMatch: 0, body: templateBody(ids.insideOrg) });
    expect(create.status).toBe(403);
  });
});
