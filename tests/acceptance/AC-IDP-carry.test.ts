/**
 * DEC-309“从另一个对象带出值”的入口（PR 描述第三节入口清单）：查看人对源字段当前没有查看权就不带出。
 * - E2 新建计划带入模板通用目标（默认值）：看不到的字段留空；看不到通用目标对象 → 不带入；
 * - E3 新建计划按指导人角色解析（默认值，源 = 任职记录直线经理）：看不到源字段视同解析不到，与“确实没有”响应一致；
 * - E6 计划详情的关键信息：按查看人对带教 / 职业发展 / 轮岗对象的字段查看权裁剪，没有对象查看权不列出；
 * - E7 计划详情的模板模块结构：HR 按模块对象裁剪。
 * 真实授权器；业务数据由“全部允许”的夹具接口建。
 */
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { idpOperator } from './AC-IDP-permission-support.js';
import { errorOf, permissionWorldOf, planWorld, type PlanView, type PlanWorld } from './AC-IDP-plan-support.js';
import { createProfile, grant, makeGrantable, type PermissionWorld, setObjectPermission } from './AC-PRM-support.js';

const testDb = useTestDb();

const planBody = (w: PlanWorld, extra: Record<string, unknown> = {}) => ({
  name: '2026 年度发展计划',
  employeeId: w.employee.employeeId,
  templateId: w.template.id,
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  tutorRole: 'other',
  tutorEmployeeId: w.manager.employeeId,
  ...extra,
});

/**
 * 给已有成员加一个 TenantBase 身份：任职记录对象可查看，按需隐藏字段；TenantBase 范围为 orgId（含下级），
 * 源记录须在范围内才能带出（第 2 轮 P2-2，范围为空的反例见 AC-IDP-tutor-scope）。
 */
async function grantEmploymentView(pw: PermissionWorld, userId: string, hidden: readonly string[], orgId: string) {
  const profile = await createProfile(pw, `emp-${userId.slice(0, 6)}`, { apps: ['TenantBase'] });
  const definition = MODULE_OBJECTS.employmentRecord;
  const response = await setObjectPermission(
    pw,
    profile,
    {
      dataOperations: { create: false, update: false, delete: false },
      fields: definition.fields.map((f) => ({ fieldCode: f.code, view: !hidden.includes(f.code), edit: false })),
      buttons: [],
    },
    definition.code,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  await makeGrantable(pw, [profile.id]);
  expect((await grant(pw, userId, profile.id)).status).toBe(201);
  const scope = await pw.api.request('PUT', `/api/tenant/permission/scopes/${userId}/TenantBase`, {
    ...pw.asAdmin,
    ifMatch: 0,
    body: { kind: 'org_range', orgRanges: [{ orgId, includeDescendants: true }] },
  });
  expect(scope.status, await scope.clone().text()).toBe(200);
}

describe('E2 新建计划带入通用目标', () => {
  it('看不到 measure：带入的目标 measure 留空，name / suggestion 照带', async () => {
    const w = await planWorld(testDb().db, 'idp-e2');
    const pw = await permissionWorldOf(w);
    const hr = await idpOperator(pw, { orgId: w.dept, hidden: { commonGoal: ['measure'] } });
    const plan = await w.ok<PlanView>(await hr.request('POST', '/plans', { ifMatch: 0, body: planBody(w) }), 201);
    const goal = (await w.readPlan(plan.id)).goals!.find((g) => g.commonGoalId === w.firstCommonGoal.id)!;
    expect(goal).toMatchObject({ name: '提升跨部门沟通', suggestion: '主持周会', measure: null });
  });

  it('没有通用目标对象的查看权：不带入任何通用目标', async () => {
    const w = await planWorld(testDb().db, 'idp-e2-none');
    const pw = await permissionWorldOf(w);
    const hr = await idpOperator(pw, {
      orgId: w.dept,
      objects: ['process', 'subProcess', 'template', 'templateModule', 'plan', 'goal', 'task'],
    });
    const plan = await w.ok<PlanView>(await hr.request('POST', '/plans', { ifMatch: 0, body: planBody(w) }), 201);
    expect((await w.readPlan(plan.id)).goals).toEqual([]);
  });

  it('全部可见：照常带入（对照）', async () => {
    const w = await planWorld(testDb().db, 'idp-e2-all');
    const pw = await permissionWorldOf(w);
    const hr = await idpOperator(pw, { orgId: w.dept });
    const plan = await w.ok<PlanView>(await hr.request('POST', '/plans', { ifMatch: 0, body: planBody(w) }), 201);
    expect((await w.readPlan(plan.id)).goals![0]).toMatchObject({ measure: '季度 360 评分 ≥ 4' });
  });
});

describe('E3 指导人角色解析', () => {
  it('看不到任职记录的直线经理字段：409 IDP_TUTOR_UNRESOLVED，与“确实没有直线经理”的响应完全一致', async () => {
    const w = await planWorld(testDb().db, 'idp-e3');
    const pw = await permissionWorldOf(w);
    const hidden = await idpOperator(pw, { orgId: w.dept });
    await grantEmploymentView(pw, hidden.user.id, ['directManagerId'], w.dept);
    const denied = await hidden.request('POST', '/plans', {
      ifMatch: 0,
      body: planBody(w, { tutorRole: 'direct_manager', tutorEmployeeId: undefined }),
    });
    const visible = await idpOperator(pw, { orgId: w.dept });
    await grantEmploymentView(pw, visible.user.id, [], w.dept);
    // 无关员工丙没有直线经理
    const missing = await visible.request('POST', '/plans', {
      ifMatch: 0,
      body: planBody(w, { employeeId: w.outsider.employeeId, tutorRole: 'direct_manager', tutorEmployeeId: undefined }),
    });
    const a = await errorOf(denied.clone());
    const b = await errorOf(missing.clone());
    expect(a).toMatchObject({ status: 409, reason: 'IDP_TUTOR_UNRESOLVED' });
    expect(a).toEqual(b);
    expect(await denied.text()).toBe(await missing.text());

    // 看得到：解析为经理甲
    const ok = await w.ok<PlanView>(
      await visible.request('POST', '/plans', {
        ifMatch: 0,
        body: planBody(w, { tutorRole: 'direct_manager', tutorEmployeeId: undefined }),
      }),
      201,
    );
    expect(ok.tutorEmployeeId).toBe(w.manager.employeeId);
  });

  it('没有任职记录对象权限（只有 IDP 身份）：同样视为解析不到', async () => {
    const w = await planWorld(testDb().db, 'idp-e3-none');
    const pw = await permissionWorldOf(w);
    const hr = await idpOperator(pw, { orgId: w.dept });
    const response = await hr.request('POST', '/plans', {
      ifMatch: 0,
      body: planBody(w, { tutorRole: 'direct_manager', tutorEmployeeId: undefined }),
    });
    expect(await errorOf(response)).toMatchObject({ status: 409, reason: 'IDP_TUTOR_UNRESOLVED' });
  });
});

describe('E6 / E7 计划详情里带出的关键信息与模块结构', () => {
  it('轮岗导师字段不可见：关键信息里该字段缺席；无轮岗对象查看权：不列出；本人（无 IDP 身份）不列出', async () => {
    const w = await planWorld(testDb().db, 'idp-e6');
    const pw = await permissionWorldOf(w);
    await w.ok(
      await w.http(w.hrUser, 'POST', '/api/tenant/idp/work-shifts', {
        ifMatch: 0,
        body: {
          employeeId: w.employee.employeeId,
          orgId: w.dept,
          mentorEmployeeId: w.manager.employeeId,
          startDate: '2026-02-01',
          endDate: '2026-05-31',
        },
      }),
      201,
    );
    const plan = await w.startedPlan();
    const trimmed = await idpOperator(pw, { orgId: w.dept, hidden: { workShift: ['mentorEmployeeId'] } });
    const view = await w.ok<PlanView>(await trimmed.request('GET', `/plans/${plan.id}`));
    expect(view.keyInfo!.workShifts).toHaveLength(1);
    expect(view.keyInfo!.workShifts![0]).toMatchObject({ orgId: w.dept, startDate: '2026-02-01' });
    expect(view.keyInfo!.workShifts![0]).not.toHaveProperty('mentorEmployeeId');

    const noShift = await idpOperator(pw, {
      orgId: w.dept,
      objects: ['process', 'subProcess', 'template', 'templateModule', 'commonGoal', 'plan', 'goal', 'task'],
    });
    const without = await w.ok<PlanView>(await noShift.request('GET', `/plans/${plan.id}`));
    expect(without.keyInfo?.workShifts ?? []).toEqual([]);
    // E7：没有模板模块对象的查看权 → 模块结构不列出
    expect(without.modules).toBeDefined();
    const noModule = await idpOperator(pw, { orgId: w.dept, objects: ['plan', 'goal'] });
    const bare = await w.ok<PlanView>(await noModule.request('GET', `/plans/${plan.id}`));
    expect(bare.modules ?? []).toEqual([]);

    const own = await w.ok<PlanView>(await w.realHttp(w.employee.userId, 'GET', `/api/tenant/idp/plans/${plan.id}`));
    expect(own.keyInfo?.workShifts ?? []).toEqual([]);
    expect(JSON.stringify(own)).not.toContain('2026-05-31');
  });
});
