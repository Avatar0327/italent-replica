/**
 * R3-T02 PR-B B5：适用范围重复检查的有界解析按**去重后的组织集合**计数（#226 第 2 轮 P2-1；DEC-372②、Q-M0-174 第 4 点）。
 * 一条 10 层组织链、末层下 2,100 个组织，配置人选这 10 个上级都勾“包含下级”：覆盖 2,110 个不同组织，选中根只有 10 个；
 * 按“根 × 下级”展开行计数是 21,055 行，会撞 20,000 行的有界解析保护（413），而只选最上面一个组织（覆盖集合完全相同）却能保存。
 * 保护要保留，但重叠的根不能重复消耗上限。三个分支都要覆盖：
 * - 新建活动自身范围的展开；
 * - 修改适用组织范围 / 申请类别；
 * - 同类别进行中候选活动的范围展开（候选范围重叠，新活动只选一个不相交组织）。
 * 另：相同覆盖集合、不同根选择，冲突结果一致。
 */
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { errorOf } from './AC-EV-support.js';
import {
  ACTIVITIES,
  type ActivityFixtures,
  activityFixtures,
  type ActivityView,
  activityWorld,
  type ActivityWorld,
} from './AC-EV-activity-support.js';

const testDb = useTestDb();
const LEAVES = 2100;
const DEPTH = 10;

describe('AC-EV-activity-scope-bounded 重叠组织根不重复消耗有界解析上限', () => {
  let w: ActivityWorld;
  let f: ActivityFixtures;
  let chain: string[];
  /** 10 个重叠的根，都勾“包含下级”。 */
  let overlapping: { orgId: string; includeDescendants: boolean }[];
  /** 与重叠根覆盖集合完全相同的单根选择。 */
  let top: { orgId: string; includeDescendants: boolean }[];

  beforeAll(async () => {
    w = (await activityWorld(testDb().db)) as ActivityWorld;
    f = await activityFixtures(w);
    chain = [await w.childOrg(w.orgA)];
    for (let level = 1; level < DEPTH; level++) chain.push(await w.childOrg(chain[level - 1]!));
    const last = chain[DEPTH - 1]!;
    await w.asOwner(async (run) => {
      const tid = w.tenant.id;
      await run(sql`INSERT INTO org_objects(id,tenant_id)
        SELECT md5(${tid}||'bounded'||g)::uuid,${tid} FROM generate_series(1,${LEAVES}) g`);
      await run(sql`INSERT INTO org_versions(id,tenant_id,org_id,version_no,start_date,code,name,full_name)
        SELECT md5(${tid}||'boundedv'||g)::uuid,${tid},md5(${tid}||'bounded'||g)::uuid,1,'2025-01-01',
        'BD'||g,'有界叶子'||g,'有界叶子'||g FROM generate_series(1,${LEAVES}) g`);
      await run(sql`INSERT INTO org_hierarchy_links(tenant_id,version_id,dimension,parent_org_id)
        SELECT ${tid},md5(${tid}||'boundedv'||g)::uuid,'admin',${last}::uuid FROM generate_series(1,${LEAVES}) g`);
    });
    overlapping = chain.map((orgId) => ({ orgId, includeDescendants: true }));
    top = [{ orgId: chain[0]!, includeDescendants: true }];
  }, 120_000);

  const create = (extra: Record<string, unknown>) =>
    w.setup.request('POST', `/api/tenant/evaluation${ACTIVITIES}`, { ...w.asAdmin, ifMatch: 0, body: f.body(extra) });
  const patch = (activity: ActivityView, data: Record<string, unknown>) =>
    w.setup.request('PATCH', `/api/tenant/evaluation${ACTIVITIES}/${activity.id}`, {
      ...w.asAdmin,
      ifMatch: activity.revision,
      body: data,
    });
  const created = async (response: Response) => {
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as ActivityView;
  };
  const duplicate = async (response: Response) => {
    expect(response.status, await response.clone().text()).toBe(409);
    expect((await errorOf(response)).reason).toBe('ACTIVITY_SCOPE_DUPLICATE');
  };
  /** 另一个不相交组织（乙部）上的进行中活动，让检查走到“展开自身范围”。 */
  async function elsewhere() {
    const category = await w.qlCategory();
    const other = await w.adminActivity(
      f.body({ categoryIds: [category.id], ownerOrgId: w.orgB, orgRange: f.orgs(w.orgB), noticeOrgRange: [w.orgB] }),
    );
    await w.setStatus(other.id, 'published');
    return category;
  }

  it('新建：10 个重叠的根（覆盖 2,110 个不同组织）+ 另一个不相交组织已有同类别进行中活动 → 201，不是 413', async () => {
    const category = await elsewhere();
    await created(await create({ categoryIds: [category.id], orgRange: overlapping }));
  });

  it('修改：把适用组织范围改成 10 个重叠的根 → 200；改申请类别（范围本来就是重叠根）→ 200', async () => {
    const category = await elsewhere();
    const draft = await created(await create({ categoryIds: [(await w.qlCategory()).id], orgRange: top }));
    const widened = await patch(draft, { orgRange: overlapping, categoryIds: [category.id] });
    expect(widened.status, await widened.clone().text()).toBe(200);
    const again = await w.adminRead(draft.id);
    const spare = await elsewhere();
    const recategorized = await patch(again, { categoryIds: [spare.id] });
    expect(recategorized.status, await recategorized.clone().text()).toBe(200);
  });

  it('候选活动：同类别进行中活动的范围是 10 个重叠的根，新活动只选一个不相交组织 → 201，不是 413；选其中一个下级则 409', async () => {
    const category = await w.qlCategory();
    const candidate = await w.adminActivity(f.body({ categoryIds: [category.id], orgRange: top }));
    // 范围追加另外 9 个重叠的根（候选范围按行展开是 21,055 行）
    await w.asOwner(async (run) => {
      for (const [index, entry] of overlapping.slice(1).entries()) {
        await run(sql`INSERT INTO ev_activity_orgs(tenant_id, activity_id, org_id, include_descendants, seq)
          VALUES (${w.tenant.id}::uuid, ${candidate.id}::uuid, ${entry.orgId}::uuid, true, ${index + 2})`);
      }
    });
    await w.setStatus(candidate.id, 'published');
    await created(
      await create({
        categoryIds: [category.id],
        ownerOrgId: w.orgB,
        orgRange: f.orgs(w.orgB),
        noticeOrgRange: [w.orgB],
      }),
    );
    await duplicate(
      await create({ categoryIds: [category.id], orgRange: [{ orgId: chain[5]!, includeDescendants: false }] }),
    );
  });

  it('相同覆盖集合、不同根选择：冲突结果一致（单个最上级根与 10 个重叠根都与同一进行中活动冲突，都不撞上限）', async () => {
    const category = await w.qlCategory();
    const base = await w.adminActivity(
      f.body({ categoryIds: [category.id], orgRange: [{ orgId: chain[9]!, includeDescendants: true }] }),
    );
    await w.setStatus(base.id, 'published');
    const viaTop = await create({ categoryIds: [category.id], orgRange: top });
    await duplicate(viaTop);
    const viaAll = await create({ categoryIds: [category.id], orgRange: overlapping });
    await duplicate(viaAll);
    const message = async (response: Response) =>
      ((await response.clone().json()) as { error: { message: string } }).error.message;
    expect(await message(viaAll)).toBe(await message(viaTop));
  });
});
