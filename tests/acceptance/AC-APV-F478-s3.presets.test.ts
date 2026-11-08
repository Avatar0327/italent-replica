/**
 * AC-APV-F478-15 / 19 / 20（F-478 S3，设计 §6.2 / §6.3）：转正预置「员工自评 → 上级评价」，
 * 实习转正预置「单个系统管理员节点」。真实 HTTP + 真实库 + 合成数据。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, type ProcessView } from './AC-APV-support.js';
import { assessmentWorld } from './AC-PB-BE15b1-support.js';
import type { RegularizationReceipt } from './AC-PB-support.js';
import { addAdminRecord, APV, publishPreset, systemAdminSource } from './AC-APV-F478-s3-support.js';

const database = useTestDb();
const INSTALL = `${APV}/presets/install`;

async function installed(label: string) {
  const w = await approvalWorld(database().db, label);
  const response = await w.request(w.hr.id, 'POST', INSTALL, { ifMatch: 0 });
  const items = (await w.json<{ items: ProcessView[] }>(response)).items;
  return { w, items, byType: (type: string) => items.find((item) => item.approvalType === type)! };
}

/** HR 代发的转正申请：返回业务单与审批实例。 */
async function hrRegularizes(label: string) {
  const w = await assessmentWorld(database().db, label);
  const person = await w.probationer('转正员工');
  const receipt = await w.json<RegularizationReceipt>(await w.regularizeRaw(person, 'application'));
  expect(receipt.items[0], JSON.stringify(receipt)).toMatchObject({ status: 'succeeded' });
  return { w, person, businessId: receipt.items[0]!.businessId! };
}

describe('AC-APV-F478-19 转正预置：员工自评 → 上级评价', () => {
  it('安装后读回：两个节点、来源、出口、回避与同人跳过', async () => {
    const { byType } = await installed('f478s3-reg-preset');
    const process = byType('regularization');
    expect(process.presetKey).toBe('standard_regularization');
    const nodes = process.latestVersion.nodes;
    expect(nodes.map((n) => [n.key, n.name, n.approver])).toEqual([
      ['self_evaluation', '员工自评', { type: 'object_field', value: 'subject_employee' }],
      ['manager_review', '上级评价', { type: 'department', value: 'record_department_head' }],
    ]);
    expect(nodes.map((n) => n.exits)).toEqual([['approve'], ['approve', 'disagree']]);
    expect(nodes.map((n) => n.actions)).toMatchObject([
      { avoidSelf: false, avoidSubjects: false, reject: false },
      { avoidSelf: true },
    ]);
    for (const node of nodes) {
      expect(node).toMatchObject({ sameAssigneeSkip: false, historySameAssigneeSkip: false });
    }
  });

  it('上级评价“不同意”→ 流程不同意结束；“同意”→ 通过', async () => {
    for (const [action, status] of [
      ['disagree', 'disapproved'],
      ['approve', 'approved'],
    ] as const) {
      const { w, person, businessId } = await hrRegularizes(`f478s3-reg-${action}`);
      await w.decide(businessId, person, 'approve');
      await w.decide(businessId, w.head, action);
      expect((await w.instance(businessId)).status, action).toBe(status);
    }
  });
});

describe('AC-APV-F478-15 HR 代发转正：自评任务派给被转正员工', () => {
  it('第 1 个待办在员工账号上（不是 HR），员工不被回避；自评后才轮到上级评价', async () => {
    const { w, person, businessId } = await hrRegularizes('f478s3-reg-hr');
    const first = await w.instance(businessId);
    expect(first.initiatorUserId).toBe(w.hr.id);
    expect(first.currentNodeKey).toBe('self_evaluation');
    expect(w.pending(first).map((task) => task.assigneeUserId)).toEqual([person.userId]);
    await w.decide(businessId, person, 'approve');
    const second = await w.instance(businessId);
    expect(second.currentNodeKey).toBe('manager_review');
    expect(w.pending(second).map((task) => task.assigneeUserId)).toEqual([w.head.userId]);
  });
});

describe('AC-APV-F478-20 实习转正预置：单个系统管理员节点', () => {
  it('安装后读回：一个节点、系统管理员来源、本人回避开', async () => {
    const { byType } = await installed('f478s3-intern-preset');
    const process = byType('intern_regularization');
    expect(process.presetKey).toBe('standard_intern_regularization');
    const nodes = process.latestVersion.nodes;
    expect(nodes.map((n) => [n.key, n.name, n.approver])).toEqual([['system_admin', '系统管理员', systemAdminSource]]);
    expect(nodes[0]).toMatchObject({
      exits: ['approve'],
      sameAssigneeSkip: false,
      historySameAssigneeSkip: false,
      actions: { avoidSelf: true },
    });
  });

  it('可发起，待办派给系统管理员', async () => {
    const w = await approvalWorld(database().db, 'f478s3-intern-run');
    const dept = await w.org('合成实习部门');
    const admin = await w.person('合成系统管理员', dept);
    await addAdminRecord(w, admin.userId, 'system_admin', '2026-01-01T00:00:00Z');
    await publishPreset(w, 'standard_intern_regularization');
    const intern = await w.person('合成实习生', dept, { employType: 'intern' });
    const employee = `/api/tenant/employment/employees/${intern.employeeId}`;
    const { revision } = await w.json<{ revision: number }>(await w.request(w.hr.id, 'GET', employee));
    const business = await w.json<{ id: string; revision: number }>(
      await w.request(w.hr.id, 'POST', `${employee}/businesses`, {
        ifMatch: revision,
        body: {
          kind: 'intern_regularization',
          mode: 'application',
          effectiveDate: '2026-10-01',
          fields: { departmentId: dept },
          probation: false,
        },
      }),
      201,
    );
    const view = await w.submit(business);
    expect(w.pending(view).map((task) => [task.nodeKey, task.assigneeUserId])).toEqual([['system_admin', admin.userId]]);
  });

  it('重复安装幂等；已装（含被租户改过）的预置流程不被改写', async () => {
    const { w, items } = await installed('f478s3-intern-idem');
    const again = await w.json<{ items: ProcessView[] }>(await w.request(w.hr.id, 'POST', INSTALL, { ifMatch: 0 }));
    expect(again.items).toEqual(items);
    // 租户改过草稿后再装：不回填、不重建
    const process = items.find((item) => item.approvalType === 'intern_regularization')!;
    const edited = await w.json<ProcessView>(
      await w.request(w.hr.id, 'PUT', `${APV}/processes/${process.id}/draft`, {
        ifMatch: process.revision,
        body: {
          name: '租户改过的实习转正',
          conditions: { items: [] },
          isFallback: true,
          exceptionAdminUserId: w.exceptionAdmin,
          nodes: [{ key: 'custom', name: '自定义', approver: { type: 'department', value: 'latest_record_department_head' } }],
        },
      }),
    );
    const third = await w.json<{ items: ProcessView[] }>(await w.request(w.hr.id, 'POST', INSTALL, { ifMatch: 0 }));
    const kept = third.items.find((item) => item.id === process.id)!;
    expect(kept.latestVersion.nodes.map((n) => n.key)).toEqual(['custom']);
    expect(kept.revision).toBe(edited.revision);
  });
});
