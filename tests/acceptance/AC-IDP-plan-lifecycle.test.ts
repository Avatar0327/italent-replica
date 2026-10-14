/**
 * R3-T07 PR-B 计划生命周期与执行（docs/02_业务建模/28 §2.3；IDP-R10 / R13 / R14 / R17；DEC-296④；PR 描述 K-37～K-49）：
 * - 新建只用已发布模板；开始一次；被计划引用的模板不能删除 / 增删模块（K-25）；删除计划不可恢复、作废运行中的审批；
 * - 执行人按“当前节点执行人 + 节点按钮”写目标 / 任务 / 回顾 / 综述，非执行人 403；重放同样复核；
 * - 员工填写节点不按自审拦截（节点开关，DEC-318 K-37）；驳回等动作按节点开关（K-39）；最后一段结束 → 计划已结束；
 * - 审批人表达式 idp_employee / idp_tutor 只有 IDP 审批类型可选。负例前后比对不变。
 */
import { PRESET_PROCESSES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { errorOf, planWorld, type PlanView, type Receipt } from './AC-IDP-plan-support.js';

const testDb = useTestDb();
const IDP = '/api/tenant/idp';

describe('新建 / 开始 / 删除', () => {
  it('草稿模板 409；指定人缺人 400；结束早于开始 400；开始两次 409', async () => {
    const w = await planWorld(testDb().db, 'idp-life-create');
    const draft = await w.ok<{ revision: number }>(
      await w.http(w.hrUser, 'POST', `${IDP}/templates/${w.template.id}/unpublish`, { ifMatch: w.template.revision }),
    );
    const body = {
      name: '计划',
      employeeId: w.employee.employeeId,
      templateId: w.template.id,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      tutorRole: 'direct_manager',
    };
    const notPublished = await w.http(w.hrUser, 'POST', `${IDP}/plans`, { ifMatch: 0, body });
    expect(await errorOf(notPublished)).toMatchObject({ status: 409, reason: 'IDP_TEMPLATE_NOT_PUBLISHED' });
    await w.ok(
      await w.http(w.hrUser, 'POST', `${IDP}/templates/${w.template.id}/publish`, { ifMatch: draft.revision }),
    );
    const noTutor = await w.http(w.hrUser, 'POST', `${IDP}/plans`, {
      ifMatch: 0,
      body: { ...body, tutorRole: 'other' },
    });
    expect(noTutor.status).toBe(400);
    const reversed = await w.http(w.hrUser, 'POST', `${IDP}/plans`, {
      ifMatch: 0,
      body: { ...body, startDate: '2026-12-31', endDate: '2026-01-01' },
    });
    expect(reversed.status).toBe(400);
    const plan = await w.createPlan();
    expect(plan).toMatchObject({
      status: 'not_started',
      tutorEmployeeId: w.manager.employeeId,
      currentStageName: null,
    });
    const started = await w.start(plan);
    const again = await w.http(w.hrUser, 'POST', `${IDP}/plans/${plan.id}/start`, { ifMatch: started.revision });
    expect(await errorOf(again)).toMatchObject({ status: 409, reason: 'IDP_PLAN_NOT_STARTABLE' });
  });

  it('修改计划：未开始可改起止与指导人；开始后改起止 409，改指导人照常；已终止 409', async () => {
    const w = await planWorld(testDb().db, 'idp-life-patch');
    let plan = await w.createPlan();
    plan = await w.ok<PlanView>(
      await w.http(w.hrUser, 'PATCH', `${IDP}/plans/${plan.id}`, {
        ifMatch: plan.revision,
        body: { endDate: '2026-11-30', tutorRole: 'other', tutorEmployeeId: w.outsider.employeeId },
      }),
    );
    expect(plan).toMatchObject({ endDate: '2026-11-30', tutorRole: 'other', tutorEmployeeId: w.outsider.employeeId });
    plan = await w.start(plan);
    const dates = await w.http(w.hrUser, 'PATCH', `${IDP}/plans/${plan.id}`, {
      ifMatch: plan.revision,
      body: { startDate: '2026-02-01' },
    });
    expect(await errorOf(dates)).toMatchObject({ status: 409, reason: 'IDP_PLAN_STARTED' });
    plan = await w.ok<PlanView>(
      await w.http(w.hrUser, 'PATCH', `${IDP}/plans/${plan.id}`, {
        ifMatch: plan.revision,
        body: { tutorRole: 'direct_manager' },
      }),
    );
    expect(plan.tutorEmployeeId).toBe(w.manager.employeeId);
    await w.ok(await w.intervene('terminate', { items: [{ id: plan.id, revision: plan.revision }] }));
    const after = await w.readPlan(plan.id);
    const late = await w.http(w.hrUser, 'PATCH', `${IDP}/plans/${plan.id}`, {
      ifMatch: after.revision,
      body: { name: '终止后改名' },
    });
    expect(await errorOf(late)).toMatchObject({ status: 409, reason: 'IDP_PLAN_NOT_ACTIVE' });
  });

  it('被计划引用的模板：不能删除、不能增删模块（K-25）', async () => {
    const w = await planWorld(testDb().db, 'idp-life-ref');
    await w.createPlan();
    const template = await w.ok<{ revision: number }>(
      await w.http(w.hrUser, 'GET', `${IDP}/templates/${w.template.id}`),
    );
    const del = await w.http(w.hrUser, 'DELETE', `${IDP}/templates/${w.template.id}`, { ifMatch: template.revision });
    expect(await errorOf(del)).toMatchObject({ status: 409, reason: 'IDP_TEMPLATE_REFERENCED' });
    const add = await w.http(w.hrUser, 'POST', `${IDP}/templates/${w.template.id}/modules`, {
      ifMatch: template.revision,
      body: { moduleType: 'summary', name: '年度总结' },
    });
    expect(await errorOf(add)).toMatchObject({ status: 409, reason: 'IDP_TEMPLATE_REFERENCED' });
  });

  it('删除进行中的计划：运行中的审批实例作废、员工待办消失；计划 404', async () => {
    const w = await planWorld(testDb().db, 'idp-life-delete');
    const plan = await w.startedPlan();
    const instanceId = plan.stages[0]!.approvalInstanceId!;
    const response = await w.http(w.hrUser, 'DELETE', `${IDP}/plans/${plan.id}`, { ifMatch: plan.revision });
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await w.plan(plan.id)).status).toBe(404);
    expect((await w.detail(instanceId)).status).toBe('cancelled');
    expect((await w.todos(w.employee.userId)).items.filter((t) => t.instanceId === instanceId)).toEqual([]);
  });
});

describe('执行：当前节点执行人 + 节点按钮（DEC-296④）', () => {
  it('员工在“制定发展目标”：增改删目标、加任务、写综述；回顾模块无按钮 403；指导人此时 403', async () => {
    const w = await planWorld(testDb().db, 'idp-exec');
    let plan = await w.startedPlan();
    plan = await w.addGoal(plan, w.employee.userId, { name: '学习领域建模', measure: '完成两次分享' });
    const goal = plan.goals!.find((g) => g.name === '学习领域建模')!;
    const edited = await w.execute(w.employee.userId, 'PATCH', `/plans/${plan.id}/goals/${goal.id}`, {
      suggestion: '参加读书会',
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    const task = await w.execute(w.employee.userId, 'POST', `/plans/${plan.id}/goals/${goal.id}/tasks`, {
      name: '整理一份领域词汇表',
      endDate: '2026-04-30',
    });
    expect(task.status, await task.clone().text()).toBe(201);
    const analysis = await w.execute(
      w.employee.userId,
      'PUT',
      `/plans/${plan.id}/modules/${w.analysisModule.id}/content`,
      {
        currentAnalysis: '技术扎实，协作待加强',
        developmentItems: '跨团队沟通',
      },
    );
    expect(analysis.status, await analysis.clone().text()).toBe(200);
    const review = await w.execute(w.employee.userId, 'PUT', `/plans/${plan.id}/modules/${w.reviewModule.id}/content`, {
      summary: '不该能写',
    });
    expect(await errorOf(review)).toMatchObject({ status: 403, reason: 'IDP_NODE_BUTTON_DENIED' });
    const byTutor = await w.execute(w.manager.userId, 'POST', `/plans/${plan.id}/goals`, {
      moduleId: w.goalModule.id,
      name: '指导人不能此时加',
    });
    expect(await errorOf(byTutor)).toMatchObject({ status: 403, reason: 'IDP_NODE_BUTTON_DENIED' });

    plan = await w.readPlan(plan.id);
    const saved = plan.goals!.find((g) => g.id === goal.id)!;
    expect(saved).toMatchObject({ measure: '完成两次分享', suggestion: '参加读书会', sourceType: 'custom' });
    expect(saved.tasks.map((t) => [t.name, t.endDate])).toEqual([['整理一份领域词汇表', '2026-04-30']]);
    expect(plan.analyses).toEqual([
      expect.objectContaining({ moduleId: w.analysisModule.id, currentAnalysis: '技术扎实，协作待加强' }),
    ]);
  });

  it('指导人在“审批发展计划”：能改目标（RowEditIdpGoal），不能加 / 删（403）', async () => {
    const w = await planWorld(testDb().db, 'idp-exec-tutor');
    let plan = await w.startedPlan();
    plan = await w.submit(plan, 1, w.employee.userId);
    const goal = plan.goals![0]!;
    const edit = await w.execute(w.manager.userId, 'PATCH', `/plans/${plan.id}/goals/${goal.id}`, {
      measure: '经理改',
    });
    expect(edit.status, await edit.clone().text()).toBe(200);
    const del = await w.execute(w.manager.userId, 'DELETE', `/plans/${plan.id}/goals/${goal.id}`);
    expect(await errorOf(del)).toMatchObject({ status: 403, reason: 'IDP_NODE_BUTTON_DENIED' });
    const byEmployee = await w.execute(w.employee.userId, 'PATCH', `/plans/${plan.id}/goals/${goal.id}`, {
      measure: '员工已提交不能改',
    });
    expect(byEmployee.status).toBe(403);
    expect((await w.readPlan(plan.id)).goals![0]!.measure).toBe('经理改');
  });

  it('阶段 2 员工中期回顾：写目标回顾与回顾模块；目标回顾挂在当前阶段', async () => {
    const w = await planWorld(testDb().db, 'idp-exec-review');
    let plan = await w.startedPlan();
    await w.submit(plan, 1, w.employee.userId);
    plan = await w.submit(plan, 1, w.manager.userId);
    await w.ok(
      await w.intervene('start-next', {
        items: [{ id: plan.id, revision: plan.revision }],
        runningMode: 'skipRunning',
      }),
    );
    plan = await w.readPlan(plan.id);
    const goal = plan.goals![0]!;
    const review = await w.execute(w.employee.userId, 'PUT', `/plans/${plan.id}/goals/${goal.id}/review`, {
      progress: 60,
      outcome: '完成两次跨部门周会主持',
    });
    expect(review.status, await review.clone().text()).toBe(200);
    const content = await w.execute(
      w.employee.userId,
      'PUT',
      `/plans/${plan.id}/modules/${w.reviewModule.id}/content`,
      {
        summary: '上半年进展顺利',
        improvement: '加强复盘',
      },
    );
    expect(content.status, await content.clone().text()).toBe(200);
    plan = await w.readPlan(plan.id);
    expect(plan.goals![0]!.reviews).toEqual([
      { stageId: plan.stages[1]!.id, progress: 60, outcome: '完成两次跨部门周会主持' },
    ]);
    expect(plan.reviews).toEqual([
      expect.objectContaining({ moduleId: w.reviewModule.id, stageId: plan.stages[1]!.id, summary: '上半年进展顺利' }),
    ]);
  });

  it('幂等重放复核当前执行人：员工提交后，原键重放加目标 403', async () => {
    const w = await planWorld(testDb().db, 'idp-exec-replay');
    const plan = await w.startedPlan();
    const options = {
      ifMatch: plan.revision,
      idempotencyKey: 'idp-exec-replay-key',
      body: { moduleId: w.goalModule.id, name: '首次成功的目标' },
    };
    const first = await w.http(w.employee.userId, 'POST', `${IDP}/plans/${plan.id}/goals`, options);
    expect(first.status, await first.clone().text()).toBe(201);
    await w.submit(await w.readPlan(plan.id), 1, w.employee.userId);
    const replay = await w.http(w.employee.userId, 'POST', `${IDP}/plans/${plan.id}/goals`, options);
    expect(await errorOf(replay)).toMatchObject({ status: 403, reason: 'IDP_NODE_BUTTON_DENIED' });
  });
});

describe('审批中心接入', () => {
  it('员工填写节点可以提交（节点关闭自审回避，DEC-318 K-37）；员工节点未开启驳回 409（节点开关，K-39）', async () => {
    const w = await planWorld(testDb().db, 'idp-apv');
    const plan = await w.startedPlan();
    const { instance, task } = await w.pendingTask(plan, 1, w.employee.userId);
    const reject = await w.taskAction(w.employee.userId, task.id, 'reject', instance.revision, { comment: '重写' });
    expect(await errorOf(reject)).toMatchObject({ status: 409, reason: 'APPROVAL_ACTION_DISABLED' });
    expect((await w.instanceOf(plan, 1)).revision).toBe(instance.revision);
    await w.submit(plan, 1, w.employee.userId);
  });

  it('三段全部结束 → 计划已结束；当前阶段为空', async () => {
    const w = await planWorld(testDb().db, 'idp-apv-end');
    let plan = await w.startedPlan();
    await w.submit(plan, 1, w.employee.userId);
    plan = await w.submit(plan, 1, w.manager.userId);
    await w.ok(
      await w.intervene('start-next', {
        items: [{ id: plan.id, revision: plan.revision }],
        runningMode: 'skipRunning',
      }),
    );
    plan = await w.readPlan(plan.id);
    await w.submit(plan, 2, w.employee.userId);
    plan = await w.submit(plan, 2, w.manager.userId);
    // 期末回顾：上一阶段结束后 7 天自动开启，HR 可提前手动开启（IDP-R4）
    const early = await w.ok<{ receipts: Receipt[] }>(
      await w.intervene('start-next', {
        items: [{ id: plan.id, revision: plan.revision }],
        runningMode: 'skipRunning',
      }),
    );
    expect(early.receipts[0]).toMatchObject({ status: 200, outcome: 'opened' });
    plan = await w.readPlan(plan.id);
    await w.submit(plan, 3, w.employee.userId);
    plan = await w.submit(plan, 3, w.manager.userId);
    expect(plan).toMatchObject({ status: 'ended', currentStageName: null });
    expect(plan.stages.map((s) => s.status)).toEqual(['ended', 'ended', 'ended']);
  });

  it('idp_employee / idp_tutor 只有 IDP 审批类型可选；预置流程用员工本人 → 指导人', async () => {
    const w = await planWorld(testDb().db, 'idp-apv-expr');
    const response = await w.http(w.hrUser, 'POST', '/api/tenant/approval/processes', {
      ifMatch: 0,
      body: {
        code: 'NOT_IDP',
        name: '调动流程',
        approvalType: 'transfer',
        priority: 0,
        isFallback: false,
        exceptionAdminUserId: w.exceptionAdmin,
        conditions: { items: [] },
        nodes: [{ key: 'n1', name: '节点', approver: 'idp_employee' }],
      },
    });
    expect(response.status).toBe(400);
    const idpPresets = PRESET_PROCESSES.filter((p) => p.approvalType.startsWith('idp_'));
    expect(idpPresets).toHaveLength(3);
    for (const preset of idpPresets) {
      expect(preset.definition.nodes.map((n) => ('approver' in n ? n.approver : null))).toEqual([
        'idp_employee',
        'idp_tutor',
      ]);
    }
  });
});

export type { PlanView };
