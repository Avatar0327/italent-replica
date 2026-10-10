/**
 * R3-T02 PR-B B5：评定活动的引用与权限（设计 §3.2、§5.1“人员引用的出口”、§5.3；拆分方案第 4 节 B5 行；DEC-352、DEC-331① /
 * DEC-339②、DEC-374⑥、DEC-380③）。真实授权器：
 * - 引用：活动类型 / 周期（字典）、类别 / 级别（任职资格，只放开查看）、环节评价表（按所属组织）各按查看权、范围、启用校验；
 *   新增的引用才校验，原有引用原样保留（DEC-281⑧）；
 * - 所属组织、适用范围、通知范围：新增的组织须存在且在操作人范围内，范围外与不存在同一 404；
 * - 负责人（人员引用出口）：范围内姓名 + 工号，范围外只有姓名，人员详情仍 404；
 * - 数据操作 / 按钮 / 字段权（含显式清空）、列表筛选与分页前裁剪；
 * - 活动类型 / 周期 / 评价表被活动引用时拒删（类型 / 周期另拒停用）；审计只存 ID。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { errorOf, EV_NOW, ok } from './AC-EV-support.js';
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
  sendableChain,
} from './AC-EV-activity-support.js';

const testDb = useTestDb();
const suffix = () => randomUUID().slice(0, 6);

interface Page {
  readonly hasDataPermission: boolean;
  readonly items: ActivityView[];
}

describe('AC-EV-activity-refs 评定活动的引用与权限', () => {
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
  const created = (op: ActivityOperator, data: Record<string, unknown> = body()) =>
    post(op, data).then((r) => ok<ActivityView>(r, 201));
  const patch = (op: ActivityOperator, activity: ActivityView, data: Record<string, unknown>) =>
    op.request('PATCH', `${ACTIVITIES}/${activity.id}`, { ifMatch: activity.revision, body: data });
  const read = (op: ActivityOperator, id: string) => op.request('GET', `${ACTIVITIES}/${id}`);
  const expectError = async (response: Response, status: number, reason?: string) => {
    expect(response.status, await response.clone().text()).toBe(status);
    if (reason) expect((await errorOf(response)).reason).toBe(reason);
  };

  describe('引用：类型 / 周期 / 类别 / 级别 / 评价表', () => {
    it('活动类型 / 周期：无查看权 403；不存在 404；停用 400 REFERENCE_DISABLED', async () => {
      await expectError(await post(await manager({ noTypeObject: true }), body()), 403);
      await expectError(await post(await manager({ noCycleObject: true }), body()), 403);
      const op = await manager();
      await expectError(await post(op, body({ typeId: randomUUID() })), 404);
      await expectError(await post(op, body({ cycleId: randomUUID() })), 404);
      const type = await w.activityType();
      const cycle = await w.activityCycle();
      await w.setEnabled('activity-types', type, false);
      await w.setEnabled('activity-cycles', cycle, false);
      await expectError(await post(op, body({ typeId: type.id })), 400, 'REFERENCE_DISABLED');
      await expectError(await post(op, body({ cycleId: cycle.id })), 400, 'REFERENCE_DISABLED');
    });

    it('类别 / 级别：无查看权 403；不存在 404；停用 400；新增时才校验', async () => {
      await expectError(await post(await manager({ noCategoryObject: true }), body()), 403);
      await expectError(await post(await manager({ noLevelObject: true }), body()), 403);
      const op = await manager();
      await expectError(await post(op, body({ categoryIds: [randomUUID()] })), 404);
      await expectError(await post(op, body({ levelIds: [randomUUID()] })), 404);
      const category = await w.qlCategory();
      const level = await w.qlLevel(9);
      const activity = await created(op, body({ categoryIds: [category.id], levelIds: [level.id] }));
      await w.disableQl('categories', category);
      await w.disableQl('levels', level);
      await expectError(await post(op, body({ categoryIds: [category.id] })), 400, 'REFERENCE_DISABLED');
      await expectError(await post(op, body({ levelIds: [level.id] })), 400, 'REFERENCE_DISABLED');
      // 已有引用停用后原样提交不重校（DEC-281⑧）；没有查看权的人只要不新增也能改别的字段
      const keeper = await manager({ noCategoryObject: true, noLevelObject: true });
      const kept = await patch(keeper, activity, { name: `保留${suffix()}`, categoryIds: [category.id] });
      expect(kept.status, await kept.clone().text()).toBe(200);
    });

    it('环节评价表：无查看权 403；所属组织在范围外与不存在同一 404；停用 400；已有引用停用后原样保留', async () => {
      await expectError(await post(await manager({ noFormObject: true }), body()), 403);
      const op = await manager();
      const outside = await post(op, body({ chains: f.chains(f.formB.id) }));
      const missing = await post(op, body({ chains: f.chains(randomUUID()) }));
      await expectError(outside, 404);
      await expectError(missing, 404);
      expect(((await outside.json()) as { error: { message: string } }).error.message).toBe(
        ((await missing.json()) as { error: { message: string } }).error.message,
      );
      const spare = await w.form(w.orgA);
      const activity = await created(op, body({ chains: f.chains(spare.id) }));
      await w.forceDisable('ev_forms', spare.id);
      await expectError(await post(op, body({ chains: f.chains(spare.id) })), 400, 'REFERENCE_DISABLED');
      const kept = await patch(op, activity, { chains: activity.chains.map(sendableChain), name: `保留${suffix()}` });
      expect(kept.status, await kept.clone().text()).toBe(200);
      expect(((await kept.json()) as ActivityView).chains.map((chain) => chain.formId)).toEqual(
        activity.chains.map((chain) => chain.formId),
      );
    });
  });

  describe('所属组织、适用范围与通知范围', () => {
    it('所属组织缺失 400；范围外与不存在同一 404；改所属组织时新组织须在范围内，失败后原值不变', async () => {
      const op = await manager();
      const { ownerOrgId: _omit, ...missing } = body();
      await expectError(await post(op, missing), 400);
      const outside = await post(op, body({ ownerOrgId: w.orgB }));
      const nowhere = await post(op, body({ ownerOrgId: randomUUID() }));
      await expectError(outside, 404);
      await expectError(nowhere, 404);
      expect(await outside.clone().text()).toBe(await nowhere.clone().text());
      const activity = await created(op);
      await expectError(await patch(op, activity, { ownerOrgId: w.orgB }), 404);
      expect(await w.adminRead(activity.id)).toMatchObject({ ownerOrgId: w.orgA, revision: 1 });
    });

    it('适用范围 / 通知范围：新增的组织须在范围内（范围外与不存在同一 404）；原有的范围外组织原样提交保留', async () => {
      const op = await manager();
      await expectError(await post(op, body({ orgRange: [w.orgA, w.orgB] })), 404);
      await expectError(await post(op, body({ noticeOrgRange: [w.orgB] })), 404);
      await expectError(await post(op, body({ orgRange: [randomUUID()] })), 404);
      // 管理员建的活动适用范围含乙部（范围外）：操作人原样提交完整集合 200，新增丙部 404
      const seeded = await w.adminActivity(body({ orgRange: [w.orgA, w.orgB], noticeOrgRange: [w.orgB] }));
      const kept = await ok<ActivityView>(
        await patch(op, seeded, { name: `保留${suffix()}`, orgRange: [w.orgA, w.orgB], noticeOrgRange: [w.orgB] }),
      );
      expect(kept.orgRange).toEqual([w.orgA, w.orgB]);
      await expectError(await patch(op, kept, { orgRange: [w.orgA, w.orgB, w.orgC] }), 404);
      const dropped = await ok<ActivityView>(await patch(op, kept, { orgRange: [w.orgA] }));
      expect(dropped.orgRange).toEqual([w.orgA]);
    });

    it('列表与详情按所属组织 ∪ 所属人在分页前裁剪；范围外与不存在同一 404；空范围 fail-closed', async () => {
      const inA = await w.adminActivity(body());
      const inB = await w.adminActivity(body({ ownerOrgId: w.orgB, orgRange: [w.orgB], noticeOrgRange: [w.orgB] }));
      const op = await manager();
      const page = await ok<Page>(await op.request('GET', `${ACTIVITIES}?page=1&pageSize=200`));
      expect(page.items.map((item) => item.id)).toContain(inA.id);
      expect(page.items.map((item) => item.id)).not.toContain(inB.id);
      const outside = await read(op, inB.id);
      const missing = await read(op, randomUUID());
      expect(outside.status).toBe(404);
      expect(await outside.clone().text()).toBe((await missing.clone().text()).replace(/[0-9a-f-]{36}/g, inB.id));
      const nobody = await manager({ evOrgs: [] });
      const empty = await ok<Page>(await nobody.request('GET', ACTIVITIES));
      expect(empty).toMatchObject({ hasDataPermission: false, items: [] });
      expect((await read(nobody, inA.id)).status).toBe(404);
    });
  });

  describe('负责人（人员引用出口，DEC-331① / DEC-339②）', () => {
    it('范围内 姓名 + 工号；范围外只有姓名，人员详情仍与不存在一样 404', async () => {
      const op = await manager({ personOrgs: [w.orgA] });
      const seeded = await w.adminActivity(body({ managerEmployeeId: f.mgrB.id }));
      const own = await created(op);
      expect(own.manager).toEqual({ name: '负责人甲', code: expect.any(String) });
      const seen = await ok<ActivityView>(await read(op, seeded.id));
      expect(seen.managerEmployeeId).toBe(f.mgrB.id);
      expect(seen.manager).toEqual({ name: '负责人乙' });
      const detail = await op.request('GET', `/api/tenant/personnel/employees/${f.mgrB.id}`);
      const missing = await op.request('GET', `/api/tenant/personnel/employees/${randomUUID()}`);
      expect(detail.status).toBe(404);
      expect(missing.status).toBe(404);
    });

    it('没有员工信息查看权只给 ID；姓名字段权不可见时范围内外都不带姓名；列表同口径', async () => {
      const noObject = await manager({ noEmployeeObject: true });
      const activity = await created(await manager());
      const seen = await ok<ActivityView>(await read(noObject, activity.id));
      expect(seen.managerEmployeeId).toBe(f.mgrA.id);
      expect(seen.manager).toEqual({});
      const noName = await manager({ hiddenEmployeeFields: ['name'] });
      expect((await ok<ActivityView>(await read(noName, activity.id))).manager).toEqual({ code: expect.any(String) });
      const listed = (await ok<Page>(await noObject.request('GET', `${ACTIVITIES}?pageSize=200`))).items.find(
        (item) => item.id === activity.id,
      );
      expect(listed?.manager).toEqual({});
    });

    it('新增范围外负责人 404 且不落库；没有员工信息查看权新增 403；原有范围外负责人原样提交保留；清空允许', async () => {
      const op = await manager();
      await expectError(await post(op, body({ managerEmployeeId: f.mgrB.id })), 404);
      await expectError(await post(op, body({ managerEmployeeId: randomUUID() })), 404);
      await expectError(await post(await manager({ noEmployeeObject: true }), body()), 403);
      const seeded = await w.adminActivity(body({ managerEmployeeId: f.mgrB.id }));
      const kept = await ok<ActivityView>(
        await patch(op, seeded, { name: `保留${suffix()}`, managerEmployeeId: f.mgrB.id }),
      );
      expect(kept.managerEmployeeId).toBe(f.mgrB.id);
      await expectError(await patch(op, kept, { managerEmployeeId: f.mgrB.id.replace(/.$/, '0') }), 404);
      const cleared = await ok<ActivityView>(await patch(op, kept, { managerEmployeeId: null }));
      expect(cleared).toMatchObject({ managerEmployeeId: null, manager: null });
    });
  });

  describe('功能权限与字段权', () => {
    it('没有新建 / 编辑 / 删除数据操作权 403；没有按钮 403；对象无查看权不可读', async () => {
      const activity = await created(await manager());
      await expectError(await post(await manager({ noCreate: true }), body()), 403);
      await expectError(await patch(await manager({ noUpdate: true }), activity, { name: '越权' }), 403);
      const noDelete = await manager({ noDelete: true });
      await expectError(
        await noDelete.request('DELETE', `${ACTIVITIES}/${activity.id}`, { ifMatch: activity.revision }),
        403,
      );
      await expectError(await post(await manager({ noButtons: true }), body()), 403);
      expect(await w.adminRead(activity.id)).toMatchObject({ revision: 1 });
    });

    it('字段只读：改只读字段 403、显式清空同样 403，改可编辑字段照常；隐藏字段不返回', async () => {
      const activity = await created(await manager());
      const readonly = await manager({ readonly: ['chains', 'managerEmployeeId', 'maxLevelJump'] });
      await expectError(await patch(readonly, activity, { chains: activity.chains.map(sendableChain) }), 403);
      await expectError(await patch(readonly, activity, { managerEmployeeId: null }), 403);
      await expectError(await patch(readonly, activity, { maxLevelJump: 3 }), 403);
      expect((await patch(readonly, activity, { name: `照常${suffix()}` })).status).toBe(200);
      const hidden = await manager({ hidden: ['chains', 'manager', 'categoryIds'] });
      const seen = await ok<ActivityView>(await read(hidden, activity.id));
      expect(Object.keys(seen)).not.toContain('chains');
      expect(Object.keys(seen)).not.toContain('manager');
      expect(Object.keys(seen)).not.toContain('categoryIds');
      expect(seen.managerEmployeeId).toBe(f.mgrA.id);
    });

    it('状态筛选：有 status 字段查看权才能筛选，没有 → 403 FILTER_FIELD_HIDDEN；筛选结果与排序不泄露', async () => {
      const draft = await created(await manager());
      const live = await w.adminActivity(body({ orgRange: [w.orgB] }));
      await w.setStatus(live.id, 'published');
      const op = await manager();
      const drafts = await ok<Page>(await op.request('GET', `${ACTIVITIES}?status=draft&pageSize=200`));
      expect(drafts.items.map((item) => item.id)).toContain(draft.id);
      expect(drafts.items.map((item) => item.id)).not.toContain(live.id);
      const lives = await ok<Page>(await op.request('GET', `${ACTIVITIES}?status=published&pageSize=200`));
      expect(lives.items.map((item) => item.id)).toContain(live.id);
      const blind = await manager({ hidden: ['status'] });
      await expectError(await blind.request('GET', `${ACTIVITIES}?status=draft`), 403, 'FILTER_FIELD_HIDDEN');
      await expectError(await op.request('GET', `${ACTIVITIES}?status=nonsense`), 400);
    });
  });

  describe('被引用拒删 / 拒停用（填 B1a / B4 钩子位）', () => {
    it('活动类型 / 周期被活动引用：删除与停用 409，对象不变；没有引用的照常；活动删除后可删', async () => {
      const type = await w.activityType();
      const cycle = await w.activityCycle();
      const activity = await created(await manager(), body({ typeId: type.id, cycleId: cycle.id }));
      for (const [kind, item] of [
        ['activity-types', type],
        ['activity-cycles', cycle],
      ] as const) {
        const disable = await w.setup.request('PATCH', `/api/tenant/evaluation/${kind}/${item.id}`, {
          ...w.asAdmin,
          ifMatch: item.revision,
          body: { enabled: false },
        });
        await expectError(disable, 409);
        const remove = await w.setup.request('DELETE', `/api/tenant/evaluation/${kind}/${item.id}`, {
          ...w.asAdmin,
          ifMatch: item.revision,
        });
        await expectError(remove, 409);
      }
      const op = await manager();
      await ok(await op.request('DELETE', `${ACTIVITIES}/${activity.id}`, { ifMatch: activity.revision }));
      const remove = await w.setup.request('DELETE', `/api/tenant/evaluation/activity-types/${type.id}`, {
        ...w.asAdmin,
        ifMatch: type.revision,
      });
      expect(remove.status, await remove.clone().text()).toBe(200);
    });

    it('评价表被环节引用：删除 409 EVALUATION_FORM_IN_USE；停用不拦（新引用会被拒），活动删除后可删', async () => {
      const spare = await w.form(w.orgA);
      const op = await manager();
      const activity = await created(op, body({ chains: f.chains(spare.id) }));
      const remove = () =>
        w.setup.request('DELETE', `/api/tenant/evaluation/evaluation-forms/${spare.id}`, {
          ...w.asAdmin,
          ifMatch: spare.revision,
        });
      await expectError(await remove(), 409, 'EVALUATION_FORM_IN_USE');
      await w.setFormEnabled(spare, false);
      await ok(await op.request('DELETE', `${ACTIVITIES}/${activity.id}`, { ifMatch: activity.revision }));
      const current = await w.setup.request('GET', `/api/tenant/evaluation/evaluation-forms/${spare.id}`, w.asAdmin);
      const revision = ((await current.json()) as { revision: number }).revision;
      const done = await w.setup.request('DELETE', `/api/tenant/evaluation/evaluation-forms/${spare.id}`, {
        ...w.asAdmin,
        ifMatch: revision,
      });
      expect(done.status, await done.clone().text()).toBe(200);
    });
  });

  describe('被引用的任职类别 / 级别不能删除（#226 第 1 轮 P2-2）', () => {
    const removeQl = (kind: 'categories' | 'levels', item: { id: string; revision: number }) =>
      w.setup.request('DELETE', `/api/tenant/qualification/${kind}/${item.id}`, {
        ...w.asAdmin,
        ifMatch: item.revision,
      });

    it('活动选用的类别 / 级别：删除 409（CATEGORY_IN_USE / LEVEL_IN_USE），对象不变；活动删除后可删', async () => {
      const category = await w.qlCategory();
      const level = await w.qlLevel(7);
      const op = await manager();
      const activity = await created(op, body({ categoryIds: [category.id], levelIds: [level.id] }));
      await expectError(await removeQl('categories', category), 409, 'CATEGORY_IN_USE');
      await expectError(await removeQl('levels', level), 409, 'LEVEL_IN_USE');
      expect(await w.adminRead(activity.id)).toMatchObject({ categoryIds: [category.id], levelIds: [level.id] });
      const stillThere = await w.setup.request('GET', `/api/tenant/qualification/categories/${category.id}`, w.asAdmin);
      expect(stillThere.status).toBe(200);
      await ok(await op.request('DELETE', `${ACTIVITIES}/${activity.id}`, { ifMatch: activity.revision }));
      expect((await removeQl('categories', category)).status).toBe(200);
      expect((await removeQl('levels', level)).status).toBe(200);
    });

    it('活动改掉引用后，原类别 / 级别可以删除；只改名称不影响', async () => {
      const [oldCategory, newCategory] = [await w.qlCategory(), await w.qlCategory()];
      const op = await manager();
      const activity = await created(op, body({ categoryIds: [oldCategory.id], levelIds: [] }));
      await expectError(await removeQl('categories', oldCategory), 409, 'CATEGORY_IN_USE');
      await ok(await patch(op, activity, { categoryIds: [newCategory.id] }));
      expect((await removeQl('categories', oldCategory)).status).toBe(200);
      await expectError(await removeQl('categories', newCategory), 409, 'CATEGORY_IN_USE');
    });
  });

  describe('审计（DEC-019 / 216：业务写与审计同事务；只存 ID，不冻结名称）', () => {
    it('新建 / 修改 / 删除各一条日志，环节与引用只含 ID，负责人姓名不进快照', async () => {
      const op = await manager({ auditor: true });
      const activity = await created(op);
      const next = await ok<ActivityView>(await patch(op, activity, { year: 2027 }));
      await ok(await op.request('DELETE', `${ACTIVITIES}/${next.id}`, { ifMatch: next.revision }));
      const audit = auditApi(testDb().db, EV_NOW.toISOString(), { authorize: undefined });
      const logs = (
        await audit.dataChanges(op.as, { objectType: 'TEvaluation.EvaluationActivity', limit: '100' })
      ).items.filter((item) => item.objectId === activity.id);
      expect(logs.map((item) => item.action).sort()).toEqual([
        'evaluation.activity.create',
        'evaluation.activity.delete',
        'evaluation.activity.update',
      ]);
      const details = await Promise.all(logs.map((item) => audit.dataChange(op.as, item.id)));
      const text = JSON.stringify({ logs, details });
      expect(text).toContain(f.mgrA.id);
      expect(text).toContain(f.form1.id);
      expect(text).not.toContain('负责人甲');
      expect(text).not.toContain(f.form1.name);
      const update = details.find((entry) => entry.action.endsWith('.update'))!;
      expect(update.changes.map((change) => change.field)).toContain('year');
    });
  });
});
