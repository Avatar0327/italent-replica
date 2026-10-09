/**
 * R3-T02 PR-A 第 5 轮（DEC-352，真实授权器）：任职资格类数据只放开查看——类别、级别、指标、标准、发展通道、编码规则
 * （及随指标的等级描述）只要有功能 / 字段查看权就看得到全部，不按管理单元 / 创建人裁剪；新建、编辑、删除仍按
 * 管理单元控制（🟡 写权限待原站取证）。分类、指标类型等其余对象的口径不变。
 */
import { QUALIFICATION_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import { code, creatorOnly, type Data, operator, reasonOf, seed } from './AC-QL-perm-support.js';
import { type CategoryView, QL_NOW, type StandardView } from './AC-QL-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

interface Rule {
  readonly item: string;
  readonly prefix: string;
  readonly revision: number;
}

describe('任职资格配置第 5 轮：只放开查看（DEC-352）', () => {
  let world: PermissionWorld;
  let data: Data;
  /** 其他部（下级管理员范围外、不向下公开）的一套对象。 */
  let outside: {
    category: CategoryView;
    levelId: string;
    levelCode: string;
    targetId: string;
    standard: StandardView;
  };
  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock: () => QL_NOW }) };
    data = await seed(world);
    const create = await data.adminIn(data.outside);
    const levelCode = code('L');
    const level = await create<{ id: string }>('/levels', { code: levelCode, name: '外级别' });
    const target = await create<{ id: string }>('/targets', {
      code: code(),
      name: '外指标',
      typeId: data.typeId,
      evalMode: 'score',
      description: '外指标说明',
    });
    const destination = await create<CategoryView>('/categories', {
      code: code(),
      name: '外目的地',
      classId: data.foreign.classId,
    });
    const standard = await create<StandardView>('/standards', {
      categoryId: data.foreign.id,
      name: '外标准',
      levelIds: [level.id],
      details: [{ levelId: level.id, targetId: target.id }],
    });
    const channels = await data.admin('PUT', `/standards/${standard.id}/channels`, {
      ifMatch: standard.revision,
      body: { channels: [{ levelId: level.id, targetCategoryId: destination.id, targetLevelId: level.id }] },
    });
    expect(channels.status, await channels.clone().text()).toBe(200);
    outside = {
      category: data.foreign,
      levelId: level.id,
      levelCode,
      targetId: target.id,
      standard: { ...standard, revision: standard.revision + 1 },
    };
  });

  const childOp = (extra: Parameters<typeof operator>[1] = {}) => operator(world, { mouId: data.childMou, ...extra });
  const ids = async (response: Response) => {
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { items: { id: string }[] }).items.map((item) => item.id);
  };

  it('范围外的类别、级别、指标、标准：有查看权即在列表与详情里看得到', async () => {
    const op = await childOp();
    expect(await ids(await op.request('GET', '/categories?pageSize=200'))).toContain(outside.category.id);
    expect(await ids(await op.request('GET', '/levels?pageSize=200'))).toContain(outside.levelId);
    expect(await ids(await op.request('GET', '/targets?pageSize=200'))).toContain(outside.targetId);
    expect(await ids(await op.request('GET', '/standards?pageSize=200'))).toContain(outside.standard.id);
    for (const path of [
      `/categories/${outside.category.id}`,
      `/levels/${outside.levelId}`,
      `/targets/${outside.targetId}`,
      `/standards/${outside.standard.id}`,
      `/standards/${outside.standard.id}/channels`,
      `/standards/${outside.standard.id}/chart`,
      `/targets/${outside.targetId}/grade-descriptions`,
    ]) {
      const response = await op.request('GET', path);
      expect(response.status, `${path} ${await response.clone().text()}`).toBe(200);
    }
    const channels = (await (await op.request('GET', `/standards/${outside.standard.id}/channels`)).json()) as {
      horizontal: { targetCategoryId?: string }[];
    };
    expect(channels.horizontal[0]?.targetCategoryId).toBeDefined();
  });

  it('没有对象查看权仍 403；字段查看权照常裁剪', async () => {
    const blind = await childOp({ noObject: ['category'] });
    expect((await blind.request('GET', `/categories/${outside.category.id}`)).status).toBe(403);
    const hidden = await childOp({ hidden: { target: ['description'] } });
    const target = (await (await hidden.request('GET', `/targets/${outside.targetId}`)).json()) as Record<
      string,
      unknown
    >;
    expect(target).not.toHaveProperty('description');
    expect(target).toHaveProperty('name', '外指标');
  });

  it('写入仍按管理单元：改范围外的类别 403，数据不变', async () => {
    const op = await childOp();
    const response = await op.request('PATCH', `/categories/${outside.category.id}`, {
      ifMatch: outside.category.revision,
      body: { name: '越权改名' },
    });
    expect(response.status, await response.clone().text()).toBe(403);
    expect(await reasonOf(response)).toBe('QL_OUT_OF_SCOPE_READONLY');
    const after = (await (await data.admin('GET', `/categories/${outside.category.id}`)).json()) as CategoryView;
    expect(after.name).toBe(outside.category.name);
  });

  it('引用带出：建自己的标准时可以引用范围外的级别与指标', async () => {
    const create = await data.adminIn(data.child);
    const klass = await create<{ id: string }>('/category-classes', { code: code(), name: '下级分类' });
    const category = await create<CategoryView>('/categories', { code: code(), name: '下级类别', classId: klass.id });
    const op = await childOp();
    const response = await op.request('POST', '/standards', {
      ifMatch: 0,
      body: {
        categoryId: category.id,
        name: '引用外级别',
        levelIds: [outside.levelId],
        details: [{ levelId: outside.levelId, targetId: outside.targetId }],
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const standard = (await response.json()) as { details: { abilities: { content: string }[] }[] };
    expect(standard.details[0]?.abilities[0]?.content).toBe('外指标说明');
  });

  it('审计：有审计与对象查看权即查得到范围外的类别 / 标准 / 发展通道日志', async () => {
    const auditor = await childOp({ auditor: true });
    const audit = auditApi(testDb().db, QL_NOW.toISOString(), { authorize: undefined });
    const seen = async (object: 'category' | 'standard' | 'developmentChannel', objectId: string) =>
      (await audit.dataChanges(auditor.as, { objectType: QUALIFICATION_OBJECTS[object].code, limit: '100' })).items
        .filter((item) => item.objectId === objectId)
        .map((item) => item.action);
    expect(await seen('category', outside.category.id)).toContain('qualification.category.create');
    expect(await seen('standard', outside.standard.id)).toContain('qualification.standard.create');
    expect(await seen('developmentChannel', outside.standard.id)).toContain('qualification.development-channel.create');
  });

  it('编码规则：有查看权即看到真实规则；改别人建的仍 403', async () => {
    const rules = (await (await data.admin('GET', '/coding-rules')).json()) as { items: Rule[] };
    const level = rules.items.find((rule) => rule.item === 'level')!;
    const saved = await data.admin('PATCH', '/coding-rules/level', {
      ifMatch: level.revision,
      body: { prefix: 'OPENX' },
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    await creatorOnly(world, 'codingRule');
    const op = await operator(world, {});
    const listed = (await (await op.request('GET', '/coding-rules')).json()) as { items: Rule[] };
    expect(listed.items.find((rule) => rule.item === 'level')).toMatchObject({ prefix: 'OPENX' });
    const edit = await op.request('PATCH', '/coding-rules/level', {
      ifMatch: level.revision + 1,
      body: { prefix: 'MINE' },
    });
    expect(edit.status, await edit.clone().text()).toBe(403);
  });

  it('边界：分类不在六类之内，范围外的分类照旧不可见', async () => {
    const op = await childOp();
    expect((await op.request('GET', `/category-classes/${outside.category.classId}`)).status).toBe(404);
  });
});
