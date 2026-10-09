/**
 * DEC-318 K-38：IDP 阶段审批实例的发起人 = 流程所有者（计划所有者，即建计划的人），不是员工本人；撤回“员工没有账号
 * 时退回为创建人 HR”的兜底（发起人始终是所有者）。处理人为空照原站“无操作”（noAssignee = none）：不转异常管理员、
 * 不自动跳过，推进到该节点的操作报 409 APPROVAL_NO_ASSIGNEE，流程停在原节点（🟡 原站报错文案未实测）。
 * IDP 预置流程的两个节点都是“无操作”。
 */
import { PRESET_PROCESSES } from '@italent/domain';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { errorOf, planWorld } from './AC-IDP-plan-support.js';

const testDb = useTestDb();

describe('K-38：发起人 = 计划所有者', () => {
  it('员工有账号：阶段实例的发起人仍是建计划的 HR', async () => {
    const w = await planWorld(testDb().db, 'idp-k38-owner');
    const plan = await w.startedPlan();
    const instance = await w.instanceOf(plan, 1);
    expect(instance.initiatorUserId).toBe(w.hrUser);
    expect(instance.subjectEmployeeId).toBe(w.employee.employeeId);
  });
});

describe('K-38：处理人为空 = 无操作', () => {
  it('预置 IDP 流程两个节点都是“无操作”', () => {
    for (const type of ['idp_plan', 'idp_mid_review', 'idp_final_review']) {
      const preset = PRESET_PROCESSES.find((p) => p.approvalType === type)!;
      for (const node of preset.definition.nodes) expect(node.noAssignee, `${type}/${node.key}`).toBe('none');
    }
  });

  it('指导人没有账号：员工提交 409 APPROVAL_NO_ASSIGNEE，不转异常管理员，流程停在员工节点', async () => {
    const w = await planWorld(testDb().db, 'idp-k38-none', {
      nodes: { idp_employee: { noAssignee: 'none' }, idp_tutor: { noAssignee: 'none' } },
    });
    const loner = await w.person('无账号指导人', w.dept);
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`DELETE FROM permission_user_person_links
        WHERE tenant_id=${w.tenant.id} AND employee_id=${loner.employeeId}::uuid`),
    );
    const plan = await w.start(await w.createPlan({ tutorRole: 'other', tutorEmployeeId: loner.employeeId }));
    const submitted = await w.submitRaw(plan, 1, w.employee.userId);
    expect(await errorOf(submitted)).toMatchObject({ status: 409, reason: 'APPROVAL_NO_ASSIGNEE' });
    const instance = await w.instanceOf(plan, 1);
    expect(instance.tasks.filter((t) => t.status === 'pending')).toEqual([
      expect.objectContaining({ nodeKey: 'set_goals', assigneeUserId: w.employee.userId }),
    ]);
    expect(instance.tasks.some((t) => t.assigneeUserId === w.exceptionAdmin)).toBe(false);
  });
});
