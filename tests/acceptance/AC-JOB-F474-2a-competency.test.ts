/**
 * F-474-2a #5：职务「胜任力模型」（人才标准引用，Q-M0-17）与只读的「关联任职资格」（R1a §2.9、§3.7）。
 * - 保存时校验引用的人才标准存在、同租户、启用；停用后已有引用可保留，换成别的停用标准不行；
 * - 被职务引用的人才标准不能删除（外部引用守卫）；
 * - 关联任职资格由任职类别关联带出，不可手选。
 */
import { qlCategories, qlCategoryClasses, qlCategoryJobLinks, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { talentWorld } from './AC-TC-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const POSTS = '/api/tenant/job/posts';
const ASOF = '?asOf=2026-10-07';

type World = Awaited<ReturnType<typeof talentWorld>>;

async function criterion(w: World, name: string) {
  const library = await w.library('ability');
  const dimension = await w.dimension(library.id, { name: `能力${uniqueSuffix()}` });
  const category = await w.category(`序列${uniqueSuffix()}`);
  return w.criterion(category.id, [{ dimensionId: dimension.id, displayOrder: 1 }], { name });
}

describe('AC-JOB-F474-2a-02 职务胜任力模型 / 关联任职资格', () => {
  let w: World;
  let enabled: { id: string; revision: number };
  let disabled: { id: string; revision: number };

  const job = (method: string, path: string, body?: unknown, ifMatch = 0) =>
    w.api.request(method, path, { ...w.as, ifMatch, body });
  const createPost = (extra: Record<string, unknown> = {}) =>
    job('POST', POSTS, {
      name: `职务${uniqueSuffix()}`,
      code: `P${uniqueSuffix()}`,
      startDate: '2026-01-01',
      ...extra,
    });
  const read = async (id: string) =>
    (await (await w.api.request('GET', `${POSTS}/${id}${ASOF}`, w.as)).json()) as {
      competencyModelId: string | null;
      qualificationId: string | null;
    };

  beforeAll(async () => {
    w = await talentWorld(testDb().db, 'f4742comp');
    enabled = await criterion(w, '启用的人才标准');
    const stopped = await criterion(w, '停用的人才标准');
    const patched = await w.request('PATCH', `/criteria/${stopped.id}`, {
      ifMatch: stopped.revision,
      body: { enabled: false },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
    disabled = { id: stopped.id, revision: ((await patched.json()) as { revision: number }).revision };
  });

  it('引用启用的同租户人才标准可保存，详情与列表都返回', async () => {
    const created = await createPost({ competencyModelId: enabled.id });
    expect(created.status, await created.clone().text()).toBe(201);
    const post = (await created.json()) as { id: string };
    expect((await read(post.id)).competencyModelId).toBe(enabled.id);
    const list = (await (await w.api.request('GET', `${POSTS}${ASOF}`, w.as)).json()) as {
      items: { id: string; competencyModelId: string | null }[];
    };
    expect(list.items.find((item) => item.id === post.id)?.competencyModelId).toBe(enabled.id);
  });

  it.each([
    ['不存在', () => '00000000-0000-4000-8000-0000000000aa'],
    ['已停用', () => disabled.id],
  ])('新建引用%s的人才标准 400，字段指向 competencyModelId', async (_name, id) => {
    const response = await createPost({ competencyModelId: id() });
    expect(response.status, await response.clone().text()).toBe(400);
    expect(JSON.stringify(await response.json())).toContain('competencyModelId');
  });

  it('其他租户的人才标准 400', async () => {
    const other = await talentWorld(testDb().db, 'f4742other');
    const foreign = await criterion(other, '别租户标准');
    const response = await createPost({ competencyModelId: foreign.id });
    expect(response.status, await response.clone().text()).toBe(400);
  });

  it('修改：可改为另一启用标准、可清空；改成停用标准 400；标准停用后原引用随其他字段修改保留', async () => {
    const created = await createPost();
    let post = (await created.json()) as { id: string; revision: number };
    const patch = async (body: Record<string, unknown>) => {
      const response = await job(
        'PATCH',
        `${POSTS}/${post.id}`,
        { effectiveDate: '2026-10-07', ...body },
        post.revision,
      );
      if (response.status === 200) post = (await response.clone().json()) as typeof post;
      return response;
    };
    expect((await patch({ competencyModelId: enabled.id })).status).toBe(200);
    expect((await patch({ competencyModelId: disabled.id })).status).toBe(400);
    expect((await read(post.id)).competencyModelId).toBe(enabled.id);
    // 引用保留：标准停用后，职务改别的字段不重复校验未改动的引用（规格：停用后保留引用，展示标注已停用）。
    const second = await criterion(w, '稍后停用');
    expect((await patch({ competencyModelId: second.id })).status).toBe(200);
    const stop = await w.request('PATCH', `/criteria/${second.id}`, {
      ifMatch: second.revision,
      body: { enabled: false },
    });
    expect(stop.status, await stop.clone().text()).toBe(200);
    const renamed = await patch({ name: `改名${uniqueSuffix()}` });
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    expect((await read(post.id)).competencyModelId).toBe(second.id);
    expect((await patch({ competencyModelId: null })).status).toBe(200);
    expect((await read(post.id)).competencyModelId).toBeNull();
  });

  it('被职务引用的人才标准不能删除：409，引用方 JOB_COMPETENCY_MODEL', async () => {
    const target = await criterion(w, '待删除标准');
    const created = await createPost({ competencyModelId: target.id });
    expect(created.status).toBe(201);
    const denied = await w.request('DELETE', `/criteria/${target.id}`, { ifMatch: target.revision });
    expect(denied.status).toBe(409);
    expect(((await denied.json()) as { error: { details: { referrer: string } } }).error.details.referrer).toBe(
      'JOB_COMPETENCY_MODEL',
    );
  });

  it('候选来源：人才标准列表 enabled=true 只列启用标准', async () => {
    const response = await w.request('GET', '/criteria?enabled=true');
    expect(response.status, await response.clone().text()).toBe(200);
    const ids = ((await response.json()) as { items: { id: string }[] }).items.map((item) => item.id);
    expect(ids).toContain(enabled.id);
    expect(ids).not.toContain(disabled.id);
  });

  describe('关联任职资格（只读，由任职类别关联带出）', () => {
    async function linkCategory(postId: string): Promise<string> {
      return withTenant(testDb().db, w.tenant.id, async (tx) => {
        const base = { tenantId: w.tenant.id, ownerId: w.user.id, ownerOrgId: w.orgId, createdBy: w.user.id };
        const [klass] = await tx
          .insert(qlCategoryClasses)
          .values({ ...base, code: `K${uniqueSuffix()}`, name: '合成分类', level: 1 })
          .returning({ id: qlCategoryClasses.id });
        const [category] = await tx
          .insert(qlCategories)
          .values({ ...base, code: `C${uniqueSuffix()}`, name: '合成类别', classId: klass!.id, jobLinkType: 'post' })
          .returning({ id: qlCategories.id });
        await tx
          .insert(qlCategoryJobLinks)
          .values({ tenantId: w.tenant.id, categoryId: category!.id, jobLinkType: 'post', jobObjectId: postId });
        return category!.id;
      });
    }

    it('无关联为 null；建立类别关联后详情与列表带出类别，改职务其他字段不受影响', async () => {
      const created = await createPost();
      const post = (await created.json()) as { id: string; revision: number };
      expect((await read(post.id)).qualificationId).toBeNull();
      const categoryId = await linkCategory(post.id);
      expect((await read(post.id)).qualificationId).toBe(categoryId);
      const list = (await (await w.api.request('GET', `${POSTS}${ASOF}`, w.as)).json()) as {
        items: { id: string; qualificationId: string | null }[];
      };
      expect(list.items.find((item) => item.id === post.id)?.qualificationId).toBe(categoryId);
      const patched = await job(
        'PATCH',
        `${POSTS}/${post.id}`,
        { effectiveDate: '2026-10-07', isKey: true },
        post.revision,
      );
      expect(patched.status, await patched.clone().text()).toBe(200);
      expect((await read(post.id)).qualificationId).toBe(categoryId);
    });

    it('不可手选：请求体带 qualificationId 一律 400', async () => {
      const response = await createPost({ qualificationId: '00000000-0000-4000-8000-0000000000bb' });
      expect(response.status, await response.clone().text()).toBe(400);
    });
  });
});
