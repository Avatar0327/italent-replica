/**
 * R3-T07 PR-B 第 2 轮 P2-1：关键信息按记录涉及的全部人员 / 组织判断范围（IDP-R21 / R22；DEC-309 E6）。
 * 带教看带教人与被带教人，轮岗看员工与轮岗部门：任一方在范围外，直接读取、列表、计划详情（HR 分支与参与人分支）、
 * 审计列表与详情都不可见；都在范围内的对照记录照常可见。
 */
import { randomUUID } from 'node:crypto';
import { IDP_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { idpOperator } from './AC-IDP-permission-support.js';
import { permissionWorldOf, planWorld, PLAN_NOW, type PlanView } from './AC-IDP-plan-support.js';
import { memberWithAdminRole } from './AC-PRM-users-support.js';

const testDb = useTestDb();
const IDP = '/api/tenant/idp';
const span = { startDate: '2026-01-01', endDate: '2026-06-30' };

async function scene(label: string) {
  const w = await planWorld(testDb().db, label);
  const pw = await permissionWorldOf(w);
  const otherOrg = await w.org('范围外部门');
  const stranger = await w.person('范围外带教人', otherOrg);
  const make = async (path: string, body: Record<string, unknown>) =>
    (await w.ok<{ id: string }>(await w.http(w.hrUser, 'POST', `${IDP}${path}`, { ifMatch: 0, body }), 201)).id;
  const ids = {
    tutorIn: await make('/tutorships', {
      tutorEmployeeId: w.manager.employeeId,
      tuteeEmployeeId: w.employee.employeeId,
      ...span,
    }),
    tutorOut: await make('/tutorships', {
      tutorEmployeeId: stranger.employeeId,
      tuteeEmployeeId: w.employee.employeeId,
      remark: '范围外带教备注',
      ...span,
    }),
    shiftIn: await make('/work-shifts', { employeeId: w.employee.employeeId, orgId: w.dept, ...span }),
    shiftOut: await make('/work-shifts', { employeeId: w.employee.employeeId, orgId: otherOrg, ...span }),
  };
  const plan = await w.startedPlan();
  return { w, pw, otherOrg, stranger, ids, plan };
}

const idsOf = (rows: readonly Record<string, unknown>[] | undefined) => (rows ?? []).map((r) => r.id).sort();

describe('P2-1：关键信息的完整范围条件', () => {
  it('直接读取与列表：带教人或轮岗部门在范围外即不可见', async () => {
    const { w, pw, ids } = await scene('idp-kis-list');
    const hr = await idpOperator(pw, { orgId: w.dept });
    expect((await hr.request('GET', `/tutorships/${ids.tutorOut}`)).status).toBe(404);
    expect((await hr.request('GET', `/work-shifts/${ids.shiftOut}`)).status).toBe(404);
    const tutorships = (await (await hr.request('GET', '/tutorships')).json()) as { items: { id: string }[] };
    expect(idsOf(tutorships.items)).toEqual([ids.tutorIn]);
    const shifts = (await (await hr.request('GET', '/work-shifts')).json()) as { items: { id: string }[] };
    expect(idsOf(shifts.items)).toEqual([ids.shiftIn]);
  });

  it('计划详情：HR 分支与参与人分支都不聚合范围外的关键信息', async () => {
    const { w, pw, ids, plan, stranger, otherOrg } = await scene('idp-kis-plan');
    const hr = await idpOperator(pw, { orgId: w.dept });
    const asHr = (await (await hr.request('GET', `/plans/${plan.id}`)).json()) as PlanView;
    expect(idsOf(asHr.keyInfo?.tutorships)).toEqual([ids.tutorIn]);
    expect(idsOf(asHr.keyInfo?.workShifts)).toEqual([ids.shiftIn]);

    // 员工本人只持关键信息对象（无计划查看权）→ 参与人分支
    const self = await idpOperator(pw, {
      objects: ['tutorship', 'career', 'workShift'],
      orgId: w.dept,
      user: { id: w.employee.userId },
    });
    const response = await self.request('GET', `/plans/${plan.id}`);
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const asSelf = JSON.parse(text) as PlanView;
    expect(asSelf).not.toHaveProperty('tutorEmployeeId');
    expect(idsOf(asSelf.keyInfo?.tutorships)).toEqual([ids.tutorIn]);
    expect(idsOf(asSelf.keyInfo?.workShifts)).toEqual([ids.shiftIn]);
    for (const leaked of [stranger.employeeId, otherOrg, '范围外带教备注']) expect(text).not.toContain(leaked);
  });

  it('审计列表与详情：范围外带教人 / 轮岗部门的记录不可见', async () => {
    const { w, pw, ids } = await scene('idp-kis-audit');
    const all = auditApi(w.db, PLAN_NOW);
    const audit = auditApi(w.db, PLAN_NOW, { authorize: undefined });
    const viewer = await memberWithAdminRole(pw, 'audit_admin', `idp-kis-${randomUUID().slice(0, 4)}`);
    const op = await idpOperator(pw, { orgId: w.dept, user: viewer.user });
    for (const [code, inside, outside] of [
      [IDP_OBJECTS.tutorship.code, ids.tutorIn, ids.tutorOut],
      [IDP_OBJECTS.workShift.code, ids.shiftIn, ids.shiftOut],
    ] as const) {
      const query = { objectType: code, limit: '50' };
      const visible = (await audit.dataChanges(op.as, query)).items.map((i) => i.objectId);
      expect(visible, code).toEqual([inside]);
      const hidden = (await all.dataChanges(w.as(w.hrUser), query)).items.find((i) => i.objectId === outside)!;
      expect((await audit.get(`/data-changes/${hidden.id}`, op.as)).status, code).toBe(404);
    }
  });
});
