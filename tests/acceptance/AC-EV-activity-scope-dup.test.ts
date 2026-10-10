/**
 * R3-T02 PR-B B5：适用范围不能与进行中的活动重复（DEC-372②，Q-M0-154 照原站；设计 §3.2；拆分方案第 4 节 B5 行）。
 * 新建，或改适用组织范围 / 申请类别时，与本租户进行中（published）的其他活动组织范围有交集且申请类别有交集 → 409
 * ACTIVITY_SCOPE_DUPLICATE，提示“适用范围与已有活动【{活动名称}】重复，请修改”：
 * - 冲突活动在操作人范围外，或活动“名称”字段对操作人不可见时，提示不带名称（不泄露范围外活动的名称与存在细节）🟡；
 * - 冲突活动是草稿时放行；部分重叠（交集）也拦 🟡；
 * - 检查与写入同一事务，按“租户 + 申请类别”取事务级咨询锁后判断（并发见 AC-EV-activity-recheck-pg）。
 */
import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { errorOf, ok } from './AC-EV-support.js';
import {
  ACTIVITIES,
  type ActivityFixtures,
  activityFixtures,
  type ActivityOperator,
  type ActivityOperatorOptions,
  activityOperator,
  type ActivityView,
  activityWorld,
  type ActivityWorld,
} from './AC-EV-activity-support.js';

const testDb = useTestDb();

const messageOf = async (response: Response) =>
  ((await response.clone().json()) as { error: { message: string } }).error.message;

describe('AC-EV-activity-scope-dup 适用范围重复拦截', () => {
  let w: ActivityWorld;
  let f: ActivityFixtures;
  beforeAll(async () => {
    w = (await activityWorld(testDb().db)) as ActivityWorld;
    f = await activityFixtures(w);
  });
  const body = (extra: Record<string, unknown> = {}) => f.body(extra);
  const manager = (options: ActivityOperatorOptions = {}) =>
    activityOperator(w, { evOrgs: [w.orgA], personOrgs: [w.orgA], ...options });
  const post = (op: ActivityOperator, data: Record<string, unknown>) =>
    op.request('POST', ACTIVITIES, { ifMatch: 0, body: data });
  const patch = (op: ActivityOperator, activity: ActivityView, data: Record<string, unknown>) =>
    op.request('PATCH', `${ACTIVITIES}/${activity.id}`, { ifMatch: activity.revision, body: data });
  const duplicate = async (response: Response) => {
    expect(response.status, await response.clone().text()).toBe(409);
    expect((await errorOf(response)).reason).toBe('ACTIVITY_SCOPE_DUPLICATE');
  };
  /** 管理员（看全部）建一个活动并置为进行中；每个用例用自己的类别 / 组织，互不干扰。 */
  async function live(extra: Record<string, unknown> = {}) {
    const category = await w.qlCategory();
    const data = body({ categoryIds: [category.id], ...extra });
    const activity = await w.adminActivity(data);
    await w.setStatus(activity.id, 'published');
    return { activity, category, data };
  }

  it('同组织同类别已有进行中活动：新建 409，提示带冲突活动名称；失败不落库', async () => {
    const { activity, category } = await live();
    const op = await manager();
    const response = await post(op, body({ categoryIds: [category.id] }));
    await duplicate(response);
    expect(await messageOf(response)).toBe(`适用范围与已有活动【${activity.name}】重复，请修改`);
    const listed = await ok<{ items: ActivityView[] }>(await op.request('GET', `${ACTIVITIES}?pageSize=200`));
    expect(listed.items.filter((item) => item.categoryIds.includes(category.id))).toHaveLength(1);
  });

  it('改组织后 201；只类别不同 201；冲突活动是草稿 201', async () => {
    const { category } = await live();
    const op = await manager({ evOrgs: [w.orgA, w.orgB], personOrgs: [w.orgA, w.orgB] });
    const otherOrg = await post(
      op,
      body({ categoryIds: [category.id], orgRange: f.orgs(w.orgB), noticeOrgRange: [w.orgB] }),
    );
    expect(otherOrg.status, await otherOrg.clone().text()).toBe(201);
    const otherCategory = await post(op, body({ categoryIds: [(await w.qlCategory()).id] }));
    expect(otherCategory.status, await otherCategory.clone().text()).toBe(201);
    const category2 = await w.qlCategory();
    await w.adminActivity(body({ categoryIds: [category2.id] }));
    const overDraft = await post(op, body({ categoryIds: [category2.id] }));
    expect(overDraft.status, await overDraft.clone().text()).toBe(201);
  });

  it('部分重叠也拦：组织范围有交集且申请类别有交集（[甲, 乙] 对 [乙, 丙]；[类别一, 类别二] 对 [类别二]），不相交放行', async () => {
    const [c1, c2] = [await w.qlCategory(), await w.qlCategory()];
    const base = await w.adminActivity(body({ orgRange: f.orgs(w.orgA, w.orgB), categoryIds: [c1.id, c2.id] }));
    await w.setStatus(base.id, 'published');
    const op = await manager({ evOrgs: [w.orgA, w.orgB, w.orgC], personOrgs: [w.orgA] });
    await duplicate(await post(op, body({ orgRange: f.orgs(w.orgB, w.orgC), categoryIds: [c1.id] })));
    await duplicate(
      await post(op, body({ orgRange: f.orgs(w.orgA), categoryIds: [(await w.qlCategory()).id, c2.id] })),
    );
    const disjoint = await post(op, body({ orgRange: f.orgs(w.orgC), categoryIds: [c1.id], noticeOrgRange: [w.orgC] }));
    expect(disjoint.status, await disjoint.clone().text()).toBe(201);
  });

  it('修改：改适用组织范围 / 申请类别触发检查；值没变或只改名称不触发；进行中的活动不与自己冲突', async () => {
    const { activity, category } = await live();
    const op = await manager({ evOrgs: [w.orgA, w.orgC] });
    const spare = await w.qlCategory();
    const mine = await ok<ActivityView>(await post(op, body({ categoryIds: [spare.id] })), 201);
    await duplicate(await patch(op, mine, { categoryIds: [category.id] }));
    const renamed = await ok<ActivityView>(await patch(op, mine, { name: `改名${randomUUID().slice(0, 6)}` }));
    expect(renamed.categoryIds).toEqual([spare.id]);
    // 历史数据里已经冲突（草稿的类别被置成与进行中活动相同）：值没变的提交、只改名称都不被拦，改适用组织范围才被拦
    await w.asOwner(async (run) => {
      await run(sql`UPDATE ev_activities SET category_ids = ARRAY[${category.id}::uuid] WHERE id = ${mine.id}::uuid`);
    });
    const legacy = await w.adminRead(mine.id);
    const same = await patch(op, legacy, { name: `历史${randomUUID().slice(0, 6)}`, categoryIds: [category.id] });
    expect(same.status, await same.clone().text()).toBe(200);
    await duplicate(await patch(op, await w.adminRead(mine.id), { orgRange: f.orgs(w.orgA, w.orgC) }));
    // 进行中的活动自己改适用组织范围：排除自身，不被自己拦
    const adminSelf = await w.setup.request('PATCH', `/api/tenant/evaluation${ACTIVITIES}/${activity.id}`, {
      ...w.asAdmin,
      ifMatch: activity.revision,
      body: { orgRange: f.orgs(w.orgA, w.orgC) },
    });
    expect(adminSelf.status, await adminSelf.clone().text()).toBe(200);
  });

  it('冲突活动在操作人范围外：提示不带名称；活动“名称”字段不可见：同样不带名称', async () => {
    const { activity, category } = await live({ ownerOrgId: w.orgB });
    const op = await manager({ evOrgs: [w.orgA] });
    const hidden = await post(op, body({ categoryIds: [category.id] }));
    await duplicate(hidden);
    expect(await messageOf(hidden)).toBe('适用范围与已有活动重复，请修改');
    expect(await hidden.clone().text()).not.toContain(activity.name);
    // 冲突活动在范围内，但操作人对活动“名称”字段没有查看权（名称不可见也就写不了名称，所以用修改适用范围的请求验证）
    const inside = await live();
    const own = await w.adminActivity(body({ categoryIds: [(await w.qlCategory()).id] }));
    const blind = await manager({ hidden: ['name'] });
    const noName = await patch(blind, own, { categoryIds: [inside.category.id] });
    await duplicate(noName);
    expect(await messageOf(noName)).toBe('适用范围与已有活动重复，请修改');
    expect(await noName.clone().text()).not.toContain(inside.activity.name);
    const sighted = await post(await manager(), body({ categoryIds: [inside.category.id] }));
    expect(await messageOf(sighted)).toContain(`【${inside.activity.name}】`);
  });

  it('多个冲突活动：只列操作人看得到的那一个的名称，不暴露范围外的', async () => {
    const category = await w.qlCategory();
    const outside = await w.adminActivity(body({ ownerOrgId: w.orgB, categoryIds: [category.id] }));
    const inside = await w.adminActivity(body({ categoryIds: [category.id] }));
    await w.setStatus(outside.id, 'published');
    await w.setStatus(inside.id, 'published');
    const response = await post(await manager(), body({ categoryIds: [category.id] }));
    await duplicate(response);
    const message = await messageOf(response);
    expect(message).toContain(inside.name);
    expect(message).not.toContain(outside.name);
  });
  it('冲突判断把下级算进去（Q-M0-174 第 4 点）：上级组织（包含下级）对进行中活动的下级组织 + 同类别 → 409；去掉“包含下级”后不冲突', async () => {
    const child = await w.childOrg(w.orgA);
    const grandchild = await w.childOrg(child);
    const category = await w.qlCategory();
    // 进行中的活动选的是下级组织本身（不含下级）
    const base = await w.adminActivity(
      body({ categoryIds: [category.id], orgRange: [{ orgId: child, includeDescendants: false }] }),
    );
    await w.setStatus(base.id, 'published');
    const op = await manager({ evOrgs: [w.orgA, child] });
    const withChildren = await post(
      op,
      body({ categoryIds: [category.id], orgRange: [{ orgId: w.orgA, includeDescendants: true }] }),
    );
    await duplicate(withChildren);
    expect(await messageOf(withChildren)).toBe(`适用范围与已有活动【${base.name}】重复，请修改`);
    const without = await post(
      op,
      body({ categoryIds: [category.id], orgRange: [{ orgId: w.orgA, includeDescendants: false }] }),
    );
    expect(without.status, await without.clone().text()).toBe(201);
    // 进行中的活动勾了“包含下级”：新活动选它的孙级组织（不含下级）也冲突
    const wide = await w.adminActivity(
      body({ categoryIds: [category.id], orgRange: [{ orgId: child, includeDescendants: true }] }),
    );
    await w.setStatus(wide.id, 'published');
    await duplicate(
      await post(
        op,
        body({ categoryIds: [category.id], orgRange: [{ orgId: grandchild, includeDescendants: false }] }),
      ),
    );
  });
});
