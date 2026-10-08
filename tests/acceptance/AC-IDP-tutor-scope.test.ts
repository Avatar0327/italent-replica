/**
 * R3-T07 PR-B 第 2 轮 P2-2：指导人按角色解析时，源任职记录 / 组织版本除字段查看权外还要在操作人的数据范围内
 * （DEC-309 E3；任职记录接口 404 的记录不能带出 directManagerId）。间接经理逐跳校验；部门负责人 / HRBP 校验员工任职记录
 * 与部门组织。新建与修改计划两个入口。范围外与“确实解析不到”响应一致（409 IDP_TUTOR_UNRESOLVED）。
 */
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { idpOperator } from './AC-IDP-permission-support.js';
import { errorOf, permissionWorldOf, planWorld, type PlanView, type PlanWorld } from './AC-IDP-plan-support.js';
import { createProfile, grant, makeGrantable, type PermissionWorld, setObjectPermission } from './AC-PRM-support.js';

const testDb = useTestDb();

/** TenantBase 身份：任职记录与组织全部字段可查看；orgIds 为 TenantBase 数据范围（含下级），空 = 缺省空范围。 */
export async function grantTenantBaseView(pw: PermissionWorld, userId: string, orgIds: readonly string[]) {
  const profile = await createProfile(pw, `tb-${userId.slice(0, 6)}`, { apps: ['TenantBase'] });
  for (const definition of [MODULE_OBJECTS.employmentRecord, MODULE_OBJECTS.organization]) {
    const response = await setObjectPermission(
      pw,
      profile,
      {
        dataOperations: { create: false, update: false, delete: false },
        fields: definition.fields.map((f) => ({ fieldCode: f.code, view: true, edit: false })),
        buttons: [],
      },
      definition.code,
    );
    expect(response.status, await response.clone().text()).toBe(200);
  }
  await makeGrantable(pw, [profile.id]);
  expect((await grant(pw, userId, profile.id)).status).toBe(201);
  if (!orgIds.length) return;
  const scope = await pw.api.request('PUT', `/api/tenant/permission/scopes/${userId}/TenantBase`, {
    ...pw.asAdmin,
    ifMatch: 0,
    body: { kind: 'org_range', orgRanges: orgIds.map((orgId) => ({ orgId, includeDescendants: true })) },
  });
  expect(scope.status, await scope.clone().text()).toBe(200);
}

const body = (w: PlanWorld, employeeId: string, tutorRole: string) => ({
  name: '2026 年度发展计划',
  employeeId,
  templateId: w.template.id,
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  tutorRole,
});

async function operator(w: PlanWorld, pw: PermissionWorld, tenantBaseOrgs: readonly string[]) {
  const op = await idpOperator(pw, { orgId: w.dept });
  await grantTenantBaseView(pw, op.user.id, tenantBaseOrgs);
  return op;
}

describe('P2-2：指导人解析校验源数据范围', () => {
  it('直线经理 / 部门负责人 / HRBP：TenantBase 范围为空时与解析不到一致；范围内照常解析', async () => {
    const w = await planWorld(testDb().db, 'idp-tutor-scope');
    const pw = await permissionWorldOf(w);
    const head = await w.person('部门负责人', w.dept);
    const hrbp = await w.person('部门HRBP', w.dept);
    await w.setOrgRoles(w.dept, { head: head.employeeId, hrbp: hrbp.employeeId });
    const empty = await operator(w, pw, []);
    const scoped = await operator(w, pw, [w.dept]);
    // 无关员工丙没有直线经理：作为“确实解析不到”的对照
    const missing = await scoped.request('POST', '/plans', {
      ifMatch: 0,
      body: body(w, w.outsider.employeeId, 'direct_manager'),
    });
    const expected = await errorOf(missing);
    expect(expected).toMatchObject({ status: 409, reason: 'IDP_TUTOR_UNRESOLVED' });
    for (const [role, tutor] of [
      ['direct_manager', w.manager.employeeId],
      ['department_head', head.employeeId],
      ['department_hrbp', hrbp.employeeId],
    ] as const) {
      const denied = await empty.request('POST', '/plans', { ifMatch: 0, body: body(w, w.employee.employeeId, role) });
      expect(denied.status, role).toBe(409);
      expect(await errorOf(denied), role).toEqual(expected);
      const ok = await w.ok<PlanView>(
        await scoped.request('POST', '/plans', { ifMatch: 0, body: body(w, w.employee.employeeId, role) }),
        201,
      );
      expect(ok.tutorEmployeeId, role).toBe(tutor);
    }
  });

  it('间接经理逐跳：直线经理的任职记录在范围外 → 解析不到；两跳都在范围内 → 解析为经理的经理', async () => {
    const w = await planWorld(testDb().db, 'idp-tutor-hop');
    const pw = await permissionWorldOf(w);
    const otherOrg = await w.org('经理所在部门');
    const boss = await w.person('上级经理', otherOrg);
    const midManager = await w.person('范围外经理', otherOrg, { directManagerId: boss.employeeId });
    const subject = await w.person('被计划员工', w.dept, { directManagerId: midManager.employeeId });
    const firstHopOnly = await operator(w, pw, [w.dept]);
    const denied = await firstHopOnly.request('POST', '/plans', {
      ifMatch: 0,
      body: body(w, subject.employeeId, 'indirect_manager'),
    });
    expect(denied.status).toBe(409);
    expect(await errorOf(denied)).toMatchObject({ status: 409, reason: 'IDP_TUTOR_UNRESOLVED' });
    const both = await operator(w, pw, [w.dept, otherOrg]);
    const ok = await w.ok<PlanView>(
      await both.request('POST', '/plans', { ifMatch: 0, body: body(w, subject.employeeId, 'indirect_manager') }),
      201,
    );
    expect(ok.tutorEmployeeId).toBe(boss.employeeId);
  });

  it('修改计划改指导人角色：同样校验源数据范围，失败时计划不变', async () => {
    const w = await planWorld(testDb().db, 'idp-tutor-patch');
    const pw = await permissionWorldOf(w);
    const plan = await w.createPlan({ tutorRole: 'other', tutorEmployeeId: w.outsider.employeeId });
    const empty = await operator(w, pw, []);
    const denied = await empty.request('PATCH', `/plans/${plan.id}`, {
      ifMatch: plan.revision,
      body: { tutorRole: 'direct_manager' },
    });
    expect(denied.status).toBe(409);
    expect(await errorOf(denied)).toMatchObject({ status: 409, reason: 'IDP_TUTOR_UNRESOLVED' });
    expect(await w.readPlan(plan.id)).toMatchObject({
      revision: plan.revision,
      tutorEmployeeId: w.outsider.employeeId,
    });
    const scoped = await operator(w, pw, [w.dept]);
    const ok = await w.ok<PlanView>(
      await scoped.request('PATCH', `/plans/${plan.id}`, {
        ifMatch: plan.revision,
        body: { tutorRole: 'direct_manager' },
      }),
    );
    expect(ok.tutorEmployeeId).toBe(w.manager.employeeId);
  });
});
