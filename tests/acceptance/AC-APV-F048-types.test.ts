/**
 * F-048 PR-1 遗留 P3（设计 §3.2，测试 T11）：离职、员工子集两类审批的实际派单回归——
 * - 手工新建、不传开关的流程（DEC-329④ 缺省关闭）：发起人 / 异动本人收到自己的待办，不再被自审回避；
 * - 存量在途实例（avoid_self=true 的已发布版本、没有冻结行）：回避事实按单主体回退，实例照常继续办理并走完。
 * 合同、IDP 两类见 AC-CT-approval-actions、AC-IDP-k37-avoid。
 */
import { loadRecusalFacts } from '../../apps/api/src/modules/approval/subjects.js';
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, transferScene, type ApprovalWorld, type InstanceView } from './AC-APV-support.js';
import { dropFrozen, pendingOf } from './support/f048.js';

const database = useTestDb();
const BASE = '/api/tenant/approval';

/** 手工新建并发布：节点不传任何回避开关（走缺省）。 */
async function manualProcess(
  w: ApprovalWorld,
  approvalType: string,
  condition: { field: string; value: string },
  nodes: Record<string, unknown>[],
) {
  const created = await w.json<{ id: string; revision: number }>(
    await w.request(w.hr.id, 'POST', `${BASE}/processes`, {
      ifMatch: 0,
      body: {
        code: `F048_${approvalType}`,
        name: `F-048 ${approvalType}`,
        approvalType,
        exceptionAdminUserId: w.exceptionAdmin,
        conditions: { items: [{ no: 1, field: condition.field, operator: 'eq', value: condition.value }] },
        nodes,
      },
    }),
    201,
  );
  return w.publish(created as never);
}

async function legacyFacts(w: ApprovalWorld, view: InstanceView) {
  await dropFrozen(w.db, w.tenant.id, view.id);
  return withTenant(w.db, w.tenant.id, (tx) =>
    loadRecusalFacts(tx, w.tenant.id, {
      id: view.id,
      initiatorUserId: view.initiatorUserId,
      subjectEmployeeId: view.subjectEmployeeId,
    }),
  );
}

describe('T11 离职（DEC-329④）', () => {
  const LEAVE = { field: 'processCode', value: 'DimissionProcessNew' };
  async function leaveApplication(w: ApprovalWorld, employeeId: string) {
    const employee = await w.json<{ revision: number }>(
      await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${employeeId}`),
    );
    return w.json<{ id: string; revision: number }>(
      await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${employeeId}/businesses`, {
        ifMatch: employee.revision,
        body: { kind: 'leave', mode: 'application', lastWorkDate: '2026-10-20', fields: {} },
      }),
      201,
    );
  }

  it('手工新建且不传开关：发起人是审批人时收到自己的待办（不再自审回避）', async () => {
    const w = await approvalWorld(database().db, 'f048-type-leave-default');
    const s = await transferScene(w);
    await manualProcess(w, 'leave', LEAVE, [{ key: 'owner_node', approver: 'owner' }]);
    const view = await w.submit(await leaveApplication(w, s.subject.employeeId));
    expect(pendingOf(view)).toEqual([
      expect.objectContaining({ nodeKey: 'owner_node', assigneeUserId: w.hr.id, origin: 'resolved' }),
    ]);
    expect(view.tasks.some((task) => task.origin === 'self_skip')).toBe(false);
  });

  it('存量在途实例（avoid_self=true、无冻结行）：按单主体回退，升级后继续办理并走完', async () => {
    const w = await approvalWorld(database().db, 'f048-type-leave-legacy');
    const s = await transferScene(w);
    await manualProcess(w, 'leave', LEAVE, [
      { key: 'head', approver: 'latest_record_department_head', actions: { avoidSelf: true } },
    ]);
    const view = await w.submit(await leaveApplication(w, s.subject.employeeId));
    const facts = await legacyFacts(w, view);
    expect([...facts.subjectEmployeeIds]).toEqual([s.subject.employeeId]);
    expect(facts.primaryUserId).toBe(s.subject.userId);
    const done = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, pendingOf(view)[0]!.id, 'approve', view.revision),
    );
    expect(done.status).toBe('approved');
  });
});

describe('T11 员工子集变更（DEC-329④）', () => {
  async function scene(label: string, node: Record<string, unknown>) {
    const w = await approvalWorld(database().db, label);
    const s = await transferScene(w);
    await w.json(
      await w.request(w.hr.id, 'PUT', '/api/tenant/settings/personnel.self_service_fields', {
        ifMatch: 0,
        body: { value: { education: ['school'] } },
      }),
    );
    await manualProcess(w, 'personnel_change', { field: 'request.subset', value: 'education' }, [
      { ...node, formFields: ['school'] },
    ]);
    const record = await w.json<{ id: string; revision: number }>(
      await w.request(w.hr.id, 'POST', `/api/tenant/personnel/employees/${s.subject.employeeId}/subsets/education`, {
        ifMatch: 0,
        body: { school: '甲校', educationLevel: '本科' },
      }),
      201,
    );
    const response = await w.request(s.subject.userId, 'POST', '/api/tenant/personnel/change-requests', {
      ifMatch: 0,
      body: {
        employeeId: s.subject.employeeId,
        subset: 'education',
        recordId: record.id,
        targetRevision: record.revision,
        values: { school: '乙校' },
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const created = (await response.json()) as { id: string };
    return { w, s, view: await w.instanceOf(created.id, s.subject.userId) };
  }

  it('手工新建且不传开关：本人发起、本人是审批人时收到自己的待办', async () => {
    const { s, view } = await scene('f048-type-sub-default', { key: 'owner_node', approver: 'owner' });
    expect(pendingOf(view)).toEqual([
      expect.objectContaining({ nodeKey: 'owner_node', assigneeUserId: s.subject.userId, origin: 'resolved' }),
    ]);
    expect(view.tasks.some((task) => task.origin === 'self_skip')).toBe(false);
  });

  it('存量在途实例（avoid_self=true、无冻结行）：按单主体回退，升级后继续办理并走完', async () => {
    const { w, s, view } = await scene('f048-type-sub-legacy', {
      key: 'head',
      approver: 'latest_record_department_head',
      actions: { avoidSelf: true },
    });
    const facts = await legacyFacts(w, view);
    expect([...facts.subjectEmployeeIds]).toEqual([s.subject.employeeId]);
    expect(facts.primaryUserId).toBe(s.subject.userId);
    const done = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, pendingOf(view)[0]!.id, 'approve', view.revision),
    );
    expect(done.status).toBe('approved');
  });
});
