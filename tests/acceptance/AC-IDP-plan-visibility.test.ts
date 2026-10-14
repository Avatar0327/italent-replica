/**
 * R3-T07 PR-B 矩阵（PR 描述第二节“查看人 × 接口 × 字段”，真实授权器；DEC-285⑤ / DEC-296④ / DEC-309④ K-30～K-32）：
 * 本人、指导人、步骤审批人按参与关系看到固定字段集；直线经理（非指导人）、带教人（非指导人）、无关员工 404；
 * 本人看不到“未开始”的计划；HR 按 IDP 范围（计划员工当前任职）与字段权限；范围外 HR 404；
 * HR 不经节点按钮不能改目标（403）；干预按钮与范围（范围外的条目回执 404）。负例前后比对不变。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { idpOperator } from './AC-IDP-permission-support.js';
import { errorOf, permissionWorldOf, planWorld, type PlanView, type Receipt } from './AC-IDP-plan-support.js';

const testDb = useTestDb();
const IDP = '/api/tenant/idp';

/** 参与人字段集（DEC-296④ 固定字段，不按 IDP 字段权限）。 */
const PARTICIPANT_KEYS = [
  'analyses',
  'currentNodeName',
  'currentStageName',
  'employeeId',
  'endDate',
  'goals',
  'id',
  'keyInfo',
  'modules',
  'name',
  'reviews',
  'revision',
  'stages',
  'startDate',
  'status',
  'templateId',
];

describe('计划可见性：参与人', () => {
  it('本人 / 指导人看到参与人字段集；直线经理（非指导人）、无关员工 404；未开始的计划本人 404', async () => {
    const w = await planWorld(testDb().db, 'idp-vis');
    const draft = await w.createPlan({ name: '未开始的计划' });
    expect((await w.realHttp(w.employee.userId, 'GET', `${IDP}/plans/${draft.id}`)).status).toBe(404);
    const plan = await w.start(await w.createPlan());

    for (const user of [w.employee.userId, w.manager.userId]) {
      const view = await w.ok<PlanView>(await w.realHttp(user, 'GET', `${IDP}/plans/${plan.id}`));
      expect(Object.keys(view).sort()).toEqual(PARTICIPANT_KEYS);
      expect(view).toMatchObject({ id: plan.id, status: 'running', currentStageName: '制定计划' });
      expect(view.goals!.map((g) => g.name)).toEqual(['提升跨部门沟通']);
      expect(view).not.toHaveProperty('tutorEmployeeId');
    }
    expect((await w.realHttp(w.outsider.userId, 'GET', `${IDP}/plans/${plan.id}`)).status).toBe(404);

    // 指导人指定为他人时，直线经理不再是参与人（K-30 按现状不可见）
    const other = await w.start(
      await w.createPlan({ name: '他人指导', tutorRole: 'other', tutorEmployeeId: w.outsider.employeeId }),
    );
    expect((await w.realHttp(w.manager.userId, 'GET', `${IDP}/plans/${other.id}`)).status).toBe(404);
    expect((await w.realHttp(w.outsider.userId, 'GET', `${IDP}/plans/${other.id}`)).status).toBe(200);
  });

  it('参与列表 my-plans：本人只见非未开始的，无关员工为空；无 IDP 身份时 HR 列表 403', async () => {
    const w = await planWorld(testDb().db, 'idp-vis-mine');
    await w.createPlan({ name: '未开始' });
    const started = await w.start(await w.createPlan({ name: '进行中' }));
    const mine = await w.ok<{ items: PlanView[] }>(await w.realHttp(w.employee.userId, 'GET', `${IDP}/my-plans`));
    expect(mine.items.map((p) => [p.id, p.name])).toEqual([[started.id, '进行中']]);
    const none = await w.ok<{ items: PlanView[] }>(await w.realHttp(w.outsider.userId, 'GET', `${IDP}/my-plans`));
    expect(none.items).toEqual([]);
    expect((await w.realHttp(w.employee.userId, 'GET', `${IDP}/plans`)).status).toBe(403);
  });

  it('步骤审批人（指导人无账号时转异常管理员）只读可见、没有新增目标按钮；办完后 404', async () => {
    const w = await planWorld(testDb().db, 'idp-vis-assignee');
    const plan = await w.startedPlan();
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`DELETE FROM permission_user_person_links WHERE employee_id=${w.manager.employeeId}::uuid`),
    );
    await w.submit(plan, 1, w.employee.userId);
    const view = await w.ok<PlanView>(await w.realHttp(w.exceptionAdmin, 'GET', `${IDP}/plans/${plan.id}`));
    expect(Object.keys(view).sort()).toEqual(PARTICIPANT_KEYS);
    expect(view.currentNodeName).toBe('审批发展计划');
    const add = await w.realHttp(w.exceptionAdmin, 'POST', `${IDP}/plans/${plan.id}/goals`, {
      ifMatch: view.revision,
      body: { moduleId: w.goalModule.id, name: '异常管理员加的目标' },
    });
    expect(await errorOf(add)).toMatchObject({ status: 403, reason: 'IDP_NODE_BUTTON_DENIED' });
    await w.submit(plan, 1, w.exceptionAdmin);
    expect((await w.realHttp(w.exceptionAdmin, 'GET', `${IDP}/plans/${plan.id}`)).status).toBe(404);
  });
});

describe('计划可见性与写入：HR（IDP 身份 + 范围）', () => {
  it('范围内 HR 按字段权限看到计划；范围外 HR 404；隐藏字段缺席', async () => {
    const w = await planWorld(testDb().db, 'idp-vis-hr');
    const pw = await permissionWorldOf(w);
    const plan = await w.startedPlan();
    const inside = await idpOperator(pw, { orgId: w.dept, hidden: { plan: ['tutorEmployeeId'] } });
    const view = await w.ok<PlanView>(await inside.request('GET', `/plans/${plan.id}`));
    expect(view).toMatchObject({ id: plan.id, employeeId: w.employee.employeeId, tutorRole: 'direct_manager' });
    expect(view).not.toHaveProperty('tutorEmployeeId');
    const list = await w.ok<{ items: PlanView[] }>(await inside.request('GET', '/plans'));
    expect(list.items.map((p) => p.id)).toEqual([plan.id]);

    const otherOrg = await w.org('范围外部门');
    const outside = await idpOperator(pw, { orgId: otherOrg });
    expect((await outside.request('GET', `/plans/${plan.id}`)).status).toBe(404);
    const empty = await w.ok<{ items: PlanView[] }>(await outside.request('GET', '/plans'));
    expect(empty.items).toEqual([]);
  });

  it('HR 不经节点按钮不能改目标（403），前后不变', async () => {
    const w = await planWorld(testDb().db, 'idp-vis-hr-goal');
    const pw = await permissionWorldOf(w);
    const plan = await w.startedPlan();
    const hr = await idpOperator(pw, { orgId: w.dept });
    const response = await hr.request('POST', `/plans/${plan.id}/goals`, {
      ifMatch: plan.revision,
      body: { moduleId: w.goalModule.id, name: 'HR 代写的目标' },
    });
    expect(await errorOf(response)).toMatchObject({ status: 403, reason: 'IDP_NODE_BUTTON_DENIED' });
    expect((await w.readPlan(plan.id)).goals!.map((g) => g.name)).toEqual(['提升跨部门沟通']);
  });

  it('新建计划：员工须在范围内（范围外 404）；无 create 按钮 403', async () => {
    const w = await planWorld(testDb().db, 'idp-vis-create');
    const pw = await permissionWorldOf(w);
    const otherOrg = await w.org('范围外部门');
    const stranger = await w.person('范围外员工', otherOrg);
    const hr = await idpOperator(pw, { orgId: w.dept });
    const body = {
      name: '计划',
      templateId: w.template.id,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      tutorRole: 'other',
      tutorEmployeeId: w.manager.employeeId,
    };
    const outside = await hr.request('POST', '/plans', {
      ifMatch: 0,
      body: { ...body, employeeId: stranger.employeeId },
    });
    expect(outside.status).toBe(404);
    const created = await hr.request('POST', '/plans', {
      ifMatch: 0,
      body: { ...body, employeeId: w.employee.employeeId },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const noButton = await idpOperator(pw, { orgId: w.dept, buttons: false });
    const denied = await noButton.request('POST', '/plans', {
      ifMatch: 0,
      body: { ...body, employeeId: w.employee.employeeId },
    });
    expect(denied.status).toBe(403);
  });

  it('干预：范围外的计划在批量回执里 404；无按钮整次 403；本人、指导人 403', async () => {
    const w = await planWorld(testDb().db, 'idp-vis-intervene');
    const pw = await permissionWorldOf(w);
    const otherOrg = await w.org('范围外部门');
    const stranger = await w.person('范围外员工', otherOrg, { directManagerId: w.manager.employeeId });
    const inPlan = await w.startedPlan();
    const outPlan = await w.startedPlan({ employeeId: stranger.employeeId });
    const hr = await idpOperator(pw, { orgId: w.dept });
    const items = [inPlan, outPlan].map((p) => ({ id: p.id, revision: p.revision }));
    const result = await w.ok<{ receipts: Receipt[] }>(
      await hr.request('POST', '/plans/terminate', { ifMatch: 0, body: { items, reason: '人员离岗' } }),
    );
    expect(result.receipts).toEqual([
      expect.objectContaining({ id: inPlan.id, status: 200, outcome: 'terminated' }),
      expect.objectContaining({ id: outPlan.id, status: 404 }),
    ]);
    expect((await w.readPlan(outPlan.id)).status).toBe('running');

    const noButton = await idpOperator(pw, { orgId: w.dept, buttons: false });
    expect((await noButton.request('POST', '/plans/urge', { ifMatch: 0, body: { items } })).status).toBe(403);
    for (const user of [w.employee.userId, w.manager.userId]) {
      const response = await w.realHttp(user, 'POST', `${IDP}/plans/terminate`, { ifMatch: 0, body: { items } });
      expect(response.status).toBe(403);
    }
  });
});
