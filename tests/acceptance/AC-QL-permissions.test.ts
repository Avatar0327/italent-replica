/**
 * R3-T02 PR-A 任职资格配置的权限（设计 §5.1、§5.2；DEC-026 / 324② 向下公开；DEC-309 带出值；DEC-043 用户 × 应用范围）：
 * - 数据范围缺省为空：列表为空、新建没有授权管理单元 403；
 * - 读取 = 所属管理单元在范围内 ∪（向下公开 ∧ 范围内有其下级组织）；仅因向下公开可见的对象写入 403
 *   QL_PUBLIC_DOWN_READONLY；不向下公开的上级对象与范围外对象同一个 404；新建的向下公开缺省 false；
 * - 带出值 #1：新建标准时非通用指标的说明只有操作人当前对 Target.description 有查看权才复制，否则能力标准留空；
 * - 带出值 #2：通用指标覆盖写入的能力标准，读取时按查看人当前对 Target.description 的查看权给出，看不到只留标记；
 * - 带出值 #3：未手改的指标等级描述是等级明细描述的投影，看不到 GradeScheme.details 就不给描述；
 * - 带出值 #4：引入类别时编码 / 名称缺省取自岗职务，看不到岗职务的这两个字段就不带出（须自己填）；
 * - DEC-339 资源集合（同 #106）：只有一个授权管理单元时自动填写；多个时新建必须显式选一个，不选 400
 *   MANAGEMENT_UNIT_REQUIRED，选了不属于本人的单元与不存在同一个 404；候选只列本人的授权管理单元。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import { type Data, operator, seed } from './AC-QL-perm-support.js';
import { type CategoryView, QL_NOW, type StandardView } from './AC-QL-support.js';
import { createMou } from './AC-TC-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

describe('任职资格配置的数据范围与向下公开', () => {
  let world: PermissionWorld;
  let data: Data;
  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock: () => QL_NOW }) };
    data = await seed(world);
  });

  it('DEC-043 数据范围缺省为空：列表为空、详情 404、新建 403 NO_MANAGEMENT_UNIT', async () => {
    const op = await operator(world, {});
    const list = await op.request('GET', '/categories');
    expect(await list.json()).toMatchObject({ items: [], hasDataPermission: false });
    expect((await op.request('GET', `/categories/${data.open.id}`)).status).toBe(404);
    const create = await op.request('POST', '/category-classes', { ifMatch: 0, body: { code: 'KX', name: '分类' } });
    expect(create.status).toBe(403);
    expect(((await create.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      'NO_MANAGEMENT_UNIT',
    );
  });

  it('DEC-324② 下级单元管理员：上级向下公开的对象可读不可写（403），不公开的与范围外的同一个 404', async () => {
    const op = await operator(world, { mouId: data.childMou });
    const list = (await (await op.request('GET', '/categories')).json()) as { items: { id: string }[] };
    expect(list.items.map((c) => c.id)).toEqual([data.open.id]);
    expect((await op.request('GET', `/categories/${data.open.id}`)).status).toBe(200);
    const notFound = [data.closed.id, data.foreign.id, randomUUID()];
    const bodies = new Set<string>();
    for (const id of notFound) {
      const response = await op.request('GET', `/categories/${id}`);
      expect(response.status).toBe(404);
      bodies.add(JSON.stringify(((await response.json()) as { error: { message: string } }).error.message));
    }
    expect(bodies.size).toBe(1);
    const write = await op.request('PATCH', `/categories/${data.open.id}`, {
      ifMatch: data.open.revision,
      body: { name: '改名' },
    });
    expect(write.status).toBe(403);
    expect(((await write.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      'QL_PUBLIC_DOWN_READONLY',
    );
    const remove = await op.request('DELETE', `/categories/${data.open.id}`, { ifMatch: data.open.revision });
    expect(remove.status).toBe(403);
    // 标准锚在类别上：公开类别的标准可读
    expect((await op.request('GET', `/standards/${data.standardId}`)).status).toBe(200);
    // 新建的向下公开缺省 false，资源集合 = 本人的授权管理单元
    const own = await op.request('POST', '/category-classes', { ifMatch: 0, body: { code: 'KOWN', name: '自建' } });
    expect(own.status, await own.clone().text()).toBe(201);
    expect(await own.json()).toMatchObject({ ownerOrgId: data.child, publicDown: false });
  });

  it('DEC-309 带出值 #1：看不到指标说明时，新建标准不复制，能力标准留空；看得到时复制', async () => {
    const hiddenOp = await operator(world, { mouId: data.childMou, hidden: { target: ['description'] } });
    const visibleOp = await operator(world, { mouId: data.childMou });
    const results: string[] = [];
    for (const op of [hiddenOp, visibleOp]) {
      const klass = (await (
        await op.request('POST', '/category-classes', {
          ifMatch: 0,
          body: { code: `K${randomUUID().slice(0, 5)}`, name: '分类' },
        })
      ).json()) as { id: string };
      const category = (await (
        await op.request('POST', '/categories', {
          ifMatch: 0,
          body: { code: `C${randomUUID().slice(0, 5)}`, name: '类别', classId: klass.id },
        })
      ).json()) as { id: string };
      const response = await op.request('POST', '/standards', {
        ifMatch: 0,
        body: {
          categoryId: category.id,
          name: '标准',
          levelIds: [data.levelId],
          details: [{ levelId: data.levelId, targetId: data.plainTarget }],
        },
      });
      expect(response.status, await response.clone().text()).toBe(201);
      const standard = (await response.json()) as StandardView;
      results.push(standard.details[0]!.abilities[0]!.content ?? '');
    }
    expect(results).toEqual(['', '保密说明']);
  });

  it('DEC-309 带出值 #2：通用指标覆盖写入的能力标准，看不到指标说明时只给标记、不给值', async () => {
    const hiddenOp = await operator(world, { mouId: data.childMou, hidden: { target: ['description'] } });
    const standard = (await (await hiddenOp.request('GET', `/standards/${data.standardId}`)).json()) as StandardView;
    const ability = standard.details[0]!.abilities[0]!;
    expect(ability).toMatchObject({ source: 'common_overwrite', projectionHidden: true });
    expect(ability).not.toHaveProperty('content');
    const visibleOp = await operator(world, { mouId: data.childMou });
    const shown = (await (await visibleOp.request('GET', `/standards/${data.standardId}`)).json()) as StandardView;
    expect(shown.details[0]!.abilities[0]).toMatchObject({ content: '通用保密说明', source: 'common_overwrite' });
  });

  it('DEC-309 带出值 #3：未手改的等级描述随等级方案的读取范围与明细字段权；看不到时不给描述、名称与等级', async () => {
    type Descriptions = {
      items: { gradeDetailId: string; description?: string; name?: string; grade?: number; modified: boolean }[];
    };
    const read = async (op: Awaited<ReturnType<typeof operator>>) => {
      const response = await op.request('GET', `/targets/${data.gradeTarget}/grade-descriptions`);
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as Descriptions).items;
    };
    // 方案读取范围外（等级方案是字典：看全部或创建人）
    const outOfScheme = await read(await operator(world, { mouId: data.childMou }));
    // 方案可读，但看不到明细字段
    const hiddenDetails = await read(
      await operator(world, { mouId: data.childMou, seeAll: true, hidden: { gradeScheme: ['details'] } }),
    );
    for (const items of [outOfScheme, hiddenDetails]) {
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ modified: false });
      for (const key of ['description', 'name', 'grade']) expect(items[0]).not.toHaveProperty(key);
    }
    const shown = await read(await operator(world, { mouId: data.childMou, seeAll: true }));
    expect(shown[0]).toMatchObject({ description: '明细保密描述', name: '初级', grade: 1, modified: false });
  });

  it('DEC-309 带出值 #4：看不到岗职务的编码 / 名称时，引入不带出（须自己填）；看得到时带出', async () => {
    const importInto = async (op: Awaited<ReturnType<typeof operator>>, item: Record<string, unknown>) => {
      const klass = (await (
        await op.request('POST', '/category-classes', {
          ifMatch: 0,
          body: { code: `K${randomUUID().slice(0, 5)}`, name: '分类' },
        })
      ).json()) as { id: string };
      return op.request('POST', '/categories/import', {
        ifMatch: 0,
        body: { classId: klass.id, jobLinkType: 'sequence', items: [item] },
      });
    };
    const hiddenOp = await operator(world, { mouId: data.childMou, sequenceHidden: ['code', 'name'] });
    const missing = await importInto(hiddenOp, { jobObjectId: data.sequences[0] });
    expect(missing.status, await missing.clone().text()).toBe(400);
    expect(((await missing.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      'NAME_REQUIRED',
    );
    const filled = await importInto(hiddenOp, { jobObjectId: data.sequences[0], code: 'QSELF', name: '自填名称' });
    expect(filled.status, await filled.clone().text()).toBe(201);
    expect(((await filled.json()) as { items: CategoryView[] }).items[0]).toMatchObject({
      code: 'QSELF',
      name: '自填名称',
    });
    const visibleOp = await operator(world, { mouId: data.childMou, sequenceHidden: [] });
    const carried = await importInto(visibleOp, { jobObjectId: data.sequences[1] });
    expect(carried.status, await carried.clone().text()).toBe(201);
    expect(((await carried.json()) as { items: CategoryView[] }).items[0]).toMatchObject({ name: '保密序列乙' });
  });

  it('DEC-339：一个单元自动填写；多个单元不选 400、选范围外 404、选了按所选填写；候选只列本人单元', async () => {
    const reason = async (response: Response) =>
      ((await response.json()) as { error: { details?: { reason?: string } } }).error.details?.reason;
    const single = await operator(world, { mouId: data.childMou });
    const auto = await single.request('POST', '/target-types', { ifMatch: 0, body: { code: 'TSINGLE', name: '单' } });
    expect(auto.status, await auto.clone().text()).toBe(201);
    expect(await auto.json()).toMatchObject({ ownerOrgId: data.child });

    const setup = tenantApi(world.db, { clock: () => QL_NOW });
    const multiMou = await createMou(setup, world.asAdmin, [data.child, data.outside], '多单元');
    const multi = await operator(world, { mouId: multiMou });
    const candidates = await multi.request('GET', '/candidates/owner-orgs?object=targetType');
    expect(candidates.status, await candidates.clone().text()).toBe(200);
    const items = ((await candidates.json()) as { items: Record<string, unknown>[] }).items;
    expect(items.map((item) => item.id).sort()).toEqual([data.child, data.outside].sort());
    // 没有组织对象的查看权：只给 ID，不带编码 / 名称（DEC-316②）
    for (const item of items) expect(Object.keys(item)).toEqual(['id']);

    const before = await multi.request('GET', '/target-types');
    const countBefore = ((await before.json()) as { items: unknown[] }).items.length;
    const missing = await multi.request('POST', '/target-types', { ifMatch: 0, body: { code: 'TMULTI', name: '多' } });
    expect(missing.status).toBe(400);
    expect(await reason(missing)).toBe('MANAGEMENT_UNIT_REQUIRED');
    const imported = await multi.request('POST', '/levels/import', {
      ifMatch: 0,
      body: { jobLinkType: 'level', items: [{ jobObjectId: randomUUID(), code: 'LX', name: '级' }] },
    });
    expect(imported.status).toBe(400);

    const notFound = new Set<string>();
    for (const ownerOrgId of [data.parent, randomUUID()]) {
      const response = await multi.request('POST', '/target-types', {
        ifMatch: 0,
        body: { code: 'TMULTI', name: '多', ownerOrgId },
      });
      expect(response.status).toBe(404);
      notFound.add(JSON.stringify(await response.json()));
    }
    expect(notFound.size).toBe(1);
    const after = await multi.request('GET', '/target-types');
    expect(((await after.json()) as { items: unknown[] }).items).toHaveLength(countBefore);

    const chosen = await multi.request('POST', '/target-types', {
      ifMatch: 0,
      body: { code: 'TMULTI', name: '多', ownerOrgId: data.outside },
    });
    expect(chosen.status, await chosen.clone().text()).toBe(201);
    const created = (await chosen.json()) as { id: string; revision: number; ownerOrgId: string };
    expect(created.ownerOrgId).toBe(data.outside);
    // 建后不可改：修改请求带 ownerOrgId 按严格结构 400
    const move = await multi.request('PATCH', `/target-types/${created.id}`, {
      ifMatch: created.revision,
      body: { ownerOrgId: data.child },
    });
    expect(move.status).toBe(400);
  });
});
