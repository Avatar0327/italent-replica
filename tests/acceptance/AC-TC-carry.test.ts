/**
 * DEC-309（#106 第 6 轮清单 1、2）：凡是把对象 X 的字段值写进对象 Y、或经 Y 返回给操作人的入口，都按查看人**当前**
 * 对源字段的查看权裁剪——看不到就留空 / 不带出。逐个入口一条“看不到”的反向用例，“看得到”的正例不退化：
 * - E1 选入指标时默认复制库内分类名称 → 关联记录.dimensionCategory（源字段：指标.categoryName）；
 * - E2 人才标准里嵌套的指标名称 / 定义（指标对象查看权 + 指标范围 + 指标字段权限）；
 * - E3 指标的分类名称、类型（指标.categoryName / type，列表、详情、写入响应、可引用指标候选）；
 * - E4 发展建议的类型名称（指标.suggestions 里的 typeName；类型下拉候选的名称同样按 suggestions 的查看权）；
 * - E5 所属管理单元候选里的组织名称 / 编码（源字段：组织.name / code）。
 * 审计快照里的带出值见 AC-TC-audit.test.ts（按指标字段权限裁剪）。
 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';
import { clock, seedTalentData, talentOperator, type TalentPermissionData } from './AC-TC-permission-support.js';
import { TC_BASE, type CriterionView } from './AC-TC-support.js';

const testDb = useTestDb();

type Operator = Awaited<ReturnType<typeof talentOperator>>;

describe('DEC-309 从另一个对象带出值：按查看人当前对源字段的查看权裁剪', () => {
  let world: PermissionWorld;
  let data: TalentPermissionData;
  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock }) };
    data = await seedTalentData(world);
  });

  const adminRequest = (method: string, path: string, extra: Record<string, unknown> = {}) =>
    data.setup.request(method, `${TC_BASE}${path}`, { ...world.asAdmin, ...extra });
  const adminRead = async <T>(path: string): Promise<T> => {
    const response = await adminRequest('GET', path);
    expect(response.status).toBe(200);
    return (await response.json()) as T;
  };
  async function json<T>(response: Response, status = 200): Promise<T> {
    expect(response.status, await response.clone().text()).toBe(status);
    return (await response.json()) as T;
  }
  const rowOf = (view: CriterionView, dimensionId: string) =>
    view.dimensions.find((row) => row.dimensionId === dimensionId)!;

  /** 管理员在范围内组织下建一个空标准，供操作人编辑时选入指标。 */
  async function emptyCriterion(name: string) {
    const response = await adminRequest('POST', '/criteria', {
      ifMatch: 0,
      body: { categoryId: data.inside.criterionCategory.id, name, ownerOrgId: data.inside.orgId, dimensions: [] },
    });
    return json<CriterionView>(response, 201);
  }

  async function createWithDimension(op: Operator, name: string, extra: Record<string, unknown> = {}) {
    const response = await op.request('POST', '/criteria', {
      ifMatch: 0,
      body: {
        categoryId: data.inside.criterionCategory.id,
        name,
        dimensions: [{ dimensionId: data.inside.dimension.id, ...extra }],
      },
    });
    return json<CriterionView>(response, 201);
  }

  it('E1 看不到指标的 categoryName：新建标准不复制分类名，201 响应与重读都为空', async () => {
    const op = await talentOperator(world, { mouId: data.mouId, hidden: { dimension: ['categoryName'] } });
    const created = await createWithDimension(op, '看不到分类名的标准');
    expect(rowOf(created, data.inside.dimension.id).dimensionCategory).toBeNull();
    expect(JSON.stringify(created)).not.toContain('内通用');
    const reread = await adminRead<CriterionView>(`/criteria/${created.id}`);
    expect(rowOf(reread, data.inside.dimension.id).dimensionCategory).toBeNull();
    expect(JSON.stringify(reread)).not.toContain('内通用');
  });

  it('E1 看不到指标的 categoryName：编辑时新选入的指标同样不复制；自己填写的类别照存', async () => {
    const op = await talentOperator(world, { mouId: data.mouId, hidden: { dimension: ['categoryName'] } });
    const empty = await emptyCriterion('编辑选入的标准');
    const edited = await json<CriterionView>(
      await op.request('PATCH', `/criteria/${empty.id}`, {
        ifMatch: empty.revision,
        body: { dimensions: [{ dimensionId: data.inside.dimension.id }] },
      }),
    );
    expect(rowOf(edited, data.inside.dimension.id).dimensionCategory).toBeNull();
    const reread = await adminRead<CriterionView>(`/criteria/${empty.id}`);
    expect(rowOf(reread, data.inside.dimension.id).dimensionCategory).toBeNull();
    expect(JSON.stringify(reread)).not.toContain('内通用');

    const typed = await createWithDimension(op, '自己填类别的标准', { dimensionCategory: '自填类别' });
    expect(rowOf(typed, data.inside.dimension.id).dimensionCategory).toBe('自填类别');
  });

  it('E1 正例：看得到 categoryName 时照常复制（新建与编辑）', async () => {
    const op = await talentOperator(world, { mouId: data.mouId });
    const created = await createWithDimension(op, '看得到分类名的标准');
    expect(rowOf(created, data.inside.dimension.id).dimensionCategory).toBe('内通用');
    const empty = await emptyCriterion('看得到分类名的编辑');
    const edited = await json<CriterionView>(
      await op.request('PATCH', `/criteria/${empty.id}`, {
        ifMatch: empty.revision,
        body: { dimensions: [{ dimensionId: data.inside.dimension.id }] },
      }),
    );
    expect(rowOf(edited, data.inside.dimension.id).dimensionCategory).toBe('内通用');
  });

  it('E2 标准里嵌套的指标：看不到指标 name 不带名称；范围外的指标不带内容', async () => {
    const hidden = await talentOperator(world, { seeAll: true, hidden: { dimension: ['name'] } });
    const view = await json<CriterionView>(await hidden.request('GET', `/criteria/${data.inside.criterion.id}`));
    expect(rowOf(view, data.inside.dimension.id).dimension).toEqual({ definition: '保密定义' });
    expect(JSON.stringify(view)).not.toContain('内战略思维');

    // 范围内的标准引用了范围外的指标：只保留引用本身
    const mixed = await json<CriterionView>(
      await adminRequest('POST', '/criteria', {
        ifMatch: 0,
        body: {
          categoryId: data.inside.criterionCategory.id,
          name: '引用范围外指标的标准',
          ownerOrgId: data.inside.orgId,
          dimensions: [{ dimensionId: data.outside.dimension.id }],
        },
      }),
      201,
    );
    const scoped = await talentOperator(world, { mouId: data.mouId });
    const seen = await json<CriterionView>(await scoped.request('GET', `/criteria/${mixed.id}`));
    expect(rowOf(seen, data.outside.dimension.id)).not.toHaveProperty('dimension');
    expect(JSON.stringify(seen)).not.toContain('外战略思维');
  });

  it('E3 看不到指标的 categoryName / type：列表、详情、写入响应、可引用指标候选都不带出', async () => {
    const op = await talentOperator(world, { seeAll: true, hidden: { dimension: ['categoryName', 'type'] } });
    const id = data.inside.dimension.id;
    const list = await json<{ items: Record<string, unknown>[] }>(await op.request('GET', '/dimensions'));
    const detail = await json<Record<string, unknown> & { revision: number }>(
      await op.request('GET', `/dimensions/${id}`),
    );
    const candidates = await json<{ items: Record<string, unknown>[] }>(
      await op.request('GET', '/candidates/dimensions'),
    );
    const written = await json<Record<string, unknown>>(
      await op.request('PATCH', `/dimensions/${id}`, { ifMatch: detail.revision, body: { displayOrder: 3 } }),
    );
    for (const item of [
      list.items.find((row) => row.id === id)!,
      detail,
      candidates.items.find((row) => row.id === id)!,
      written,
    ]) {
      expect(item).toMatchObject({ name: '内战略思维' });
      expect(item).not.toHaveProperty('categoryName');
      expect(item).not.toHaveProperty('type');
      expect(JSON.stringify(item)).not.toContain('内通用');
    }
  });

  it('E4 看不到指标的 suggestions：详情不带类型名称，类型下拉也不带名称', async () => {
    const op = await talentOperator(world, { seeAll: true, hidden: { dimension: ['suggestions'] } });
    const detail = await json<Record<string, unknown>>(
      await op.request('GET', `/dimensions/${data.inside.dimension.id}`),
    );
    expect(detail).not.toHaveProperty('suggestions');
    expect(JSON.stringify(detail)).not.toContain('行动建议');
    const options = await json<{ items: Record<string, unknown>[] }>(
      await op.request('GET', '/candidates/description-types'),
    );
    expect(options.items.map((item) => item.id)).toContain(data.type.id);
    for (const item of options.items) expect(item).not.toHaveProperty('name');
    expect(JSON.stringify(options)).not.toContain('行动建议');

    // 正例：看得到 suggestions 时下拉照常带名称
    const visible = await talentOperator(world, { seeAll: true });
    const shown = await json<{ items: { id: string; name: string }[] }>(
      await visible.request('GET', '/candidates/description-types'),
    );
    expect(shown.items).toContainEqual(expect.objectContaining({ id: data.type.id, name: '行动建议' }));
  });

  it('E5 所属管理单元候选：看不到组织的名称 / 编码时只返回 ID；看得到时照常带出', async () => {
    const op = await talentOperator(world, { mouId: data.mouId });
    const options = await json<{ items: Record<string, unknown>[] }>(
      await op.request('GET', '/candidates/owner-orgs?object=library'),
    );
    expect(options.items).toEqual([{ id: data.inside.orgId }]);
    expect(JSON.stringify(options)).not.toContain('人才标准部');

    const admin = await adminRead<{ items: { id: string; name: string; code: string }[] }>(
      '/candidates/owner-orgs?object=library',
    );
    expect(admin.items.map((item) => item.name).sort()).toEqual(
      ['人才标准部（范围内）', '人才标准部（范围外）'].sort(),
    );
    for (const item of admin.items) expect(typeof item.code).toBe('string');
  });
});
