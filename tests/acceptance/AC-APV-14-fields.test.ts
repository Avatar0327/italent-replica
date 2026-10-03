/**
 * PR #35 第二轮清单 主题 B：字段权限与盲审（DEC-057 / DEC-058 / DEC-069）。
 * 2 审批编辑校验字段编辑权；3 审批快照覆盖自定义字段、业务日期、最后工作日（载荷、原值、变化、编辑）；
 * 4 编辑并同意后按新快照重新盲审；5 同人自动跳过前也做盲审；C-非4 异常管理员本人也看不到变化字段时不循环建任务；
 * X-13 用户可见日志按字段权限投影。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  approvalWorld,
  grantFieldAccess,
  permissionAdmin,
  TRANSFER_NODES,
  transferScene,
  type ApprovalWorld,
  type InstanceView,
} from './AC-APV-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const BASE = '/api/tenant/approval';

function current(view: InstanceView) {
  const tasks = view.tasks.filter((task) => task.status === 'pending');
  expect(tasks).toHaveLength(1);
  return tasks[0]!;
}

async function reasonOf(response: Response) {
  const body = (await response.json()) as { error?: { details?: { reason?: string } } };
  return { status: response.status, reason: body.error?.details?.reason };
}

/** 真实授权器下的接口：字段可见 / 可编辑按身份解析。 */
function realApi(w: ApprovalWorld) {
  const api = tenantApi(w.db, { authorize: undefined, clock: w.clock });
  return {
    act: (user: string, task: string, action: string, revision: number, body: Record<string, unknown> = {}) =>
      api.request('POST', `${BASE}/tasks/${task}/${action}`, { ...w.as(user), ifMatch: revision, body }),
    detail: async (user: string, id: string) => {
      const response = await api.request('GET', `${BASE}/instances/${id}`, w.as(user));
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()) as InstanceView;
    },
  };
}

async function directBusiness(w: ApprovalWorld, employeeId: string, effectiveDate: string, fields: object) {
  const employee = await w.json<{ revision: number }>(
    await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${employeeId}`),
  );
  return w.json(
    await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${employeeId}/businesses`, {
      ifMatch: employee.revision,
      body: { kind: 'transfer', mode: 'direct', effectiveDate, fields },
    }),
    201,
  );
}

describe('清单 2：审批编辑必须校验字段编辑权', () => {
  it('节点开放了可编辑字段，但审批人对该字段只有查看权：编辑被拒；授予编辑权后可编辑', async () => {
    const w = await approvalWorld(database().db, 'apv-edit-permission');
    const s = await transferScene(w);
    const world = await permissionAdmin(w);
    const view = ['id', 'departmentId', 'effectiveDate', 'place'];
    await grantFieldAccess(world, s.outHead.userId, { view });
    await w.publishedProcess({
      nodes: [
        {
          key: 'out_head',
          approver: 'latest_record_department_head',
          formFields: ['departmentId', 'effectiveDate', 'place'],
          editableFields: ['place'],
          editMode: 'separate',
        },
      ],
    });
    const real = realApi(w);
    let instance = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to, place: '原地点' }));
    const denied = await real.act(s.outHead.userId, current(instance).id, 'edit', instance.revision, {
      fields: { place: '改地点' },
    });
    expect(denied.status).toBe(403);
    await grantFieldAccess(world, s.outHead.userId, { view, edit: ['place'] });
    const ok = await real.act(s.outHead.userId, current(instance).id, 'edit', instance.revision, {
      fields: { place: '改地点' },
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    instance = await w.detail(instance.id);
    expect(instance.form.values).toMatchObject({ place: '改地点' });
  });
});

describe('清单 3：审批快照覆盖自定义字段、业务日期与最后工作日', () => {
  it('自定义字段的变化纳入盲审；节点表单可配置并展示自定义字段', async () => {
    const w = await approvalWorld(database().db, 'apv-custom-field');
    const s = await transferScene(w);
    const field = await w.json<{ id: string }>(
      await w.request(w.hr.id, 'POST', '/api/tenant/employment/custom-fields', {
        ifMatch: 0,
        body: { name: '机密备注', valueType: 'text', objectType: 'employment' },
      }),
      201,
    );
    const code = `custom:${field.id}`;
    await w.publishedProcess({
      nodes: [{ key: 'out_head', approver: 'latest_record_department_head', formFields: ['departmentId', code] }],
    });
    const world = await permissionAdmin(w);
    await grantFieldAccess(world, s.outHead.userId, { view: ['id', 'departmentId', 'effectiveDate'] });
    const employee = await w.json<{ revision: number }>(
      await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${s.subject.employeeId}`),
    );
    const draft = await w.json<{ id: string; revision: number }>(
      await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${s.subject.employeeId}/businesses`, {
        ifMatch: employee.revision,
        body: {
          kind: 'transfer',
          mode: 'application',
          effectiveDate: '2026-10-01',
          fields: { departmentId: s.to },
          customFields: { [field.id]: '仅限 HR' },
        },
      }),
      201,
    );
    const instance = await w.submit(draft);
    expect(instance.form.values).toMatchObject({ [code]: '仅限 HR', departmentId: s.to });
    const blind = await realApi(w).act(s.outHead.userId, current(instance).id, 'approve', instance.revision);
    expect(await reasonOf(blind)).toMatchObject({ status: 403, reason: 'APPROVAL_BLIND_REVIEW' });
  });

  it('离职节点可查看、编辑最后工作日：详情有值，编辑写入业务顶层并重算生效日', async () => {
    const w = await approvalWorld(database().db, 'apv-last-work-date');
    const s = await transferScene(w);
    await w.publishedProcess({
      approvalType: 'leave',
      conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'DimissionProcessNew' }] },
      nodes: [
        {
          key: 'out_head',
          approver: 'latest_record_department_head',
          formFields: ['lastWorkDate', 'effectiveDate'],
          editableFields: ['lastWorkDate'],
          editMode: 'separate',
        },
      ],
    });
    const employee = await w.json<{ revision: number }>(
      await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${s.subject.employeeId}`),
    );
    const draft = await w.json<{ id: string; revision: number }>(
      await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${s.subject.employeeId}/businesses`, {
        ifMatch: employee.revision,
        body: { kind: 'leave', mode: 'application', lastWorkDate: '2026-10-20', fields: {} },
      }),
      201,
    );
    let instance = await w.submit(draft);
    expect(instance.form.values).toMatchObject({ lastWorkDate: '2026-10-20', effectiveDate: '2026-10-21' });
    instance = await w.json(
      await w.taskAction(s.outHead.userId, current(instance).id, 'edit', instance.revision, {
        fields: { lastWorkDate: '2026-10-25' },
      }),
    );
    expect(instance.form.values).toMatchObject({ lastWorkDate: '2026-10-25', effectiveDate: '2026-10-26' });
    expect(await w.business(draft.id)).toMatchObject({ effectiveDate: '2026-10-26' });
  });
});

describe('清单 4：编辑并同意后按新快照重新做盲审', () => {
  it('改生效日后新前驱使不可见字段成为变化：整单回滚，编辑不生效，任务仍在本人名下', async () => {
    const w = await approvalWorld(database().db, 'apv-edit-reblind');
    const s = await transferScene(w);
    await directBusiness(w, s.subject.employeeId, '2026-09-01', { place: '乙地' });
    const world = await permissionAdmin(w);
    await grantFieldAccess(world, s.outHead.userId, { view: ['id', 'departmentId'], edit: ['effectiveDate'] });
    await w.publishedProcess({
      nodes: [
        {
          key: 'out_head',
          approver: 'latest_record_department_head',
          formFields: ['departmentId', 'effectiveDate'],
          editableFields: ['effectiveDate'],
          editMode: 'with_approve',
        },
        TRANSFER_NODES[2]!,
      ],
    });
    const draft = await w.application(
      s.subject.employeeId,
      { departmentId: s.to, place: '乙地' },
      { effectiveDate: '2026-10-15' },
    );
    const instance = await w.submit(draft);
    const response = await realApi(w).act(s.outHead.userId, current(instance).id, 'approve', instance.revision, {
      fields: { effectiveDate: '2026-08-15' },
    });
    expect(await reasonOf(response)).toMatchObject({ status: 403, reason: 'APPROVAL_BLIND_REVIEW' });
    const after = await w.detail(instance.id);
    expect(after.revision).toBe(instance.revision);
    expect(current(after)).toMatchObject({ assigneeUserId: s.outHead.userId, nodeKey: 'out_head' });
    expect(await w.business(draft.id)).toMatchObject({ effectiveDate: '2026-10-15' });
  });
});

describe('清单 5：同人自动跳过之前也做盲审', () => {
  it('前序节点改了 A 看不到的字段：第三节点不再自动同意，按 DEC-069 转异常管理员', async () => {
    const w = await approvalWorld(database().db, 'apv-skip-reblind');
    const s = await transferScene(w);
    const world = await permissionAdmin(w);
    const all = ['id', 'departmentId', 'effectiveDate', 'place'];
    await grantFieldAccess(world, s.outHead.userId, { view: ['id', 'departmentId', 'effectiveDate'] });
    await grantFieldAccess(world, s.inHrbp.userId, { view: all, edit: ['place'] });
    await w.publishedProcess({
      nodes: [
        { key: 'out_head', approver: 'latest_record_department_head', formFields: ['departmentId'] },
        {
          key: 'in_hrbp',
          approver: 'record_department_hrbp',
          formFields: ['departmentId', 'place'],
          editableFields: ['place'],
          editMode: 'with_approve',
        },
        { key: 'recheck', approver: 'latest_record_department_head', historySameAssigneeSkip: true },
      ],
    });
    const real = realApi(w);
    let instance = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    let response = await real.act(s.outHead.userId, current(instance).id, 'approve', instance.revision);
    expect(response.status, await response.clone().text()).toBe(200);
    instance = await w.detail(instance.id);
    response = await real.act(s.inHrbp.userId, current(instance).id, 'approve', instance.revision, {
      fields: { place: '新地点' },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    instance = await w.detail(instance.id);
    expect(instance.status).toBe('running');
    expect(current(instance)).toMatchObject({
      nodeKey: 'recheck',
      assigneeUserId: w.exceptionAdmin,
      isExceptionAdmin: true,
      origin: 'blind_review',
    });
  });
});

describe('C-非4 / X-13：异常管理员本人也看不到变化字段；日志按字段权限投影', () => {
  it('不循环给自己建任务，详情不显示同意 / 驳回；日志不暴露不可见的变化字段名', async () => {
    const w = await approvalWorld(database().db, 'apv-admin-blind');
    const s = await transferScene(w);
    const world = await permissionAdmin(w);
    const visible = ['id', 'departmentId', 'effectiveDate'];
    await grantFieldAccess(world, s.outHead.userId, { view: visible });
    await grantFieldAccess(world, w.exceptionAdmin, { view: visible });
    await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!, TRANSFER_NODES[2]!] });
    const real = realApi(w);
    const instance = await w.submit(
      await w.application(s.subject.employeeId, { departmentId: s.to, place: '外地', remarks: '机密' }),
    );
    const blocked = await real.act(s.outHead.userId, current(instance).id, 'approve', instance.revision);
    expect(blocked.status).toBe(403);
    let view = await real.detail(w.exceptionAdmin, instance.id);
    const adminTask = current(view);
    expect(adminTask).toMatchObject({ assigneeUserId: w.exceptionAdmin, isExceptionAdmin: true });
    expect(view.actions).not.toContain('approve');
    expect(view.actions).not.toContain('reject');
    expect(view.actions).toContain('transfer');
    const again = await real.act(w.exceptionAdmin, adminTask.id, 'approve', view.revision);
    expect(await reasonOf(again)).toMatchObject({ status: 403, reason: 'APPROVAL_BLIND_REVIEW' });
    view = await real.detail(w.exceptionAdmin, instance.id);
    expect(view.tasks.filter((task) => task.origin === 'blind_review')).toHaveLength(1);
    expect(current(view).id).toBe(adminTask.id);
    const blindLog = view.logs.find((log) => log.event === 'blind_review_exception_admin')!;
    expect(blindLog.detail.fields).toEqual([]);
  });
});
