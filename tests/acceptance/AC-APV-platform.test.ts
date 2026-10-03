/**
 * 审批中心平台约定：租户隔离、业务与审计 / outbox 同事务、权限目录登记真实字段与按钮、
 * 人员自助变更申请接入审批（R1-T12 挂接点，DEC-085）。
 */
import { auditEvents, eq, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { objectCatalog } from '../../apps/api/src/modules/permission/catalog.js';
import { approvalWorld, TRANSFER_NODES, transferScene, type InstanceView } from './AC-APV-support.js';

const database = useTestDb();
const BASE = '/api/tenant/approval';

function rowsOf<T>(value: unknown): T[] {
  return (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];
}

describe('租户隔离（硬规则 7）', () => {
  it('另一租户看不到流程、实例与待办，也不能对其操作', async () => {
    const db = database().db;
    const a = await approvalWorld(db, 'apv-tenant-a');
    const b = await approvalWorld(db, 'apv-tenant-b');
    const s = await transferScene(a);
    const process = await a.publishedProcess({ nodes: TRANSFER_NODES });
    const view = await a.submit(await a.application(s.subject.employeeId, { departmentId: s.to }));
    expect((await b.request(b.hr.id, 'GET', `${BASE}/processes/${process.id}`)).status).toBe(404);
    expect((await b.request(b.hr.id, 'GET', `${BASE}/instances/${view.id}`)).status).toBe(404);
    expect((await b.json<{ items: unknown[] }>(await b.request(b.hr.id, 'GET', `${BASE}/processes`))).items).toEqual(
      [],
    );
    const cross = await b.request(b.hr.id, 'POST', `${BASE}/tasks/${view.tasks[0]!.id}/approve`, {
      ifMatch: view.revision,
      body: {},
    });
    expect(cross.status).toBe(404);
    // 用户 outHead 不是租户 B 的成员：带租户 B 上下文访问一律拒绝。
    const foreign = await b.api.request('GET', `${BASE}/todos`, { user: s.outHead.userId, tenant: b.tenant.id });
    expect(foreign.status).toBe(403);
  });
});

describe('审计与 outbox 同事务（AGENTS §10）', () => {
  it('流程发布、提交、审批动作都写字段级审计与 outbox 事件', async () => {
    const w = await approvalWorld(database().db, 'apv-audit');
    const s = await transferScene(w);
    const process = await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!] });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    view = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, view.tasks[0]!.id, 'approve', view.revision, { comment: '同意' }),
    );
    const audits = await withTenant(w.db, w.tenant.id, (tx) => tx.select().from(auditEvents));
    expect(audits.filter((a) => a.objectId === process.id).map((a) => a.action)).toEqual(
      expect.arrayContaining(['approval.process.create', 'approval.process.publish']),
    );
    const instanceAudits = audits.filter((a) => a.objectId === view.id);
    expect(instanceAudits.map((a) => a.action)).toEqual(
      expect.arrayContaining(['approval.instance.start', 'approval.task.approve', 'approval.instance.complete']),
    );
    expect(instanceAudits.find((a) => a.action === 'approval.task.approve')).toMatchObject({
      actorUserId: s.outHead.userId,
      before: expect.objectContaining({ status: 'pending' }),
      after: expect.objectContaining({ status: 'approved', comment: '同意' }),
    });
    const outbox = await withTenant(w.db, w.tenant.id, async (tx) =>
      rowsOf<{ event_type: string; state: string }>(
        await tx.execute(sql`SELECT event_type,state FROM approval_outbox WHERE object_id=${view.id}::uuid`),
      ),
    );
    expect(outbox.map((row) => row.event_type)).toEqual(
      expect.arrayContaining(['approval.instance.started', 'approval.instance.approved']),
    );
    expect(outbox.every((row) => row.state === 'pending')).toBe(true);
  });
});

describe('权限目录（DEC-080）', () => {
  it('审批中心对象登记真实字段与按钮', () => {
    expect(objectCatalog.get('TenantBase.ApprovalProcess')?.buttons.map((b) => b.code)).toEqual(
      expect.arrayContaining(['create', 'update', 'publish', 'newVersion', 'discard', 'simulate']),
    );
    expect(objectCatalog.get('TenantBase.ApprovalInstance')?.buttons.map((b) => b.code)).toEqual(
      expect.arrayContaining(['adminTransfer', 'adminIntervene', 'adminLogs']),
    );
    expect(objectCatalog.get('TenantBase.ApprovalProcess')?.fields.map((f) => f.code)).toEqual(
      expect.arrayContaining(['code', 'approvalType', 'priority', 'exceptionAdminUserId', 'nodes', 'conditions']),
    );
  });

  it('没有流程配置权限的用户不能建流程；没有管理员按钮的用户不能转交他人任务', async () => {
    const db = database().db;
    const w = await approvalWorld(db, 'apv-deny');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: TRANSFER_NODES });
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const { tenantApi } = await import('./support/tenant-api.js');
    const deny = tenantApi(db, { authorize: () => false, clock: w.clock });
    const created = await deny.request('POST', `${BASE}/processes`, {
      ...w.as(w.hr.id),
      ifMatch: 0,
      body: { code: 'X', name: 'X', approvalType: 'transfer', priority: 0, nodes: TRANSFER_NODES },
    });
    expect(created.status).toBe(403);
    const transfer = await deny.request('POST', `${BASE}/instances/${view.id}/admin-transfer`, {
      ...w.as(w.hr.id),
      ifMatch: view.revision,
      body: { taskId: view.tasks[0]!.id, toUserId: s.inHead.userId, reason: '无权' },
    });
    expect(transfer.status).toBe(403);
    // 待办按接收人过滤，不依赖身份权限。
    const mine = await deny.request('GET', `${BASE}/todos`, w.as(s.outHead.userId));
    expect(mine.status).toBe(200);
    expect(((await mine.json()) as { items: unknown[] }).items).toHaveLength(1);
  });
});

describe('R1-T12 挂接点：人员自助变更申请走审批', () => {
  it('提交即发起“员工子集变更”审批；审批通过后落地，来源为申请 ID；驳回不落地', async () => {
    const w = await approvalWorld(database().db, 'apv-self-service');
    const s = await transferScene(w);
    expect(
      (
        await w.request(w.hr.id, 'PUT', '/api/tenant/settings/personnel.self_service_fields', {
          ifMatch: 0,
          body: { value: { education: ['school'] } },
        })
      ).status,
    ).toBe(200);
    await w.publishedProcess({
      approvalType: 'personnel_change',
      conditions: { items: [{ no: 1, field: 'request.subset', operator: 'eq', value: 'education' }] },
      nodes: [{ key: 'head', approver: 'latest_record_department_head', formFields: ['school'] }],
    });
    const submit = async (school: string) => {
      const response = await w.request(s.subject.userId, 'POST', '/api/tenant/personnel/change-requests', {
        ifMatch: 0,
        body: { employeeId: s.subject.employeeId, subset: 'education', values: { school } },
      });
      expect(response.status, await response.clone().text()).toBe(201);
      const request = (await response.json()) as { id: string };
      return w.instanceOf(request.id, s.subject.userId);
    };
    const view = await submit('自助大学');
    expect(view).toMatchObject({ approvalType: 'personnel_change', subjectEmployeeId: s.subject.employeeId });
    expect(view.tasks[0]).toMatchObject({ assigneeUserId: s.outHead.userId });
    const done = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, view.tasks[0]!.id, 'approve', view.revision),
    );
    expect(done.status).toBe('approved');
    const education = await w.json<{ items: { school: string; sourceType: string; sourceId: string }[] }>(
      await w.request(w.hr.id, 'GET', `/api/tenant/personnel/employees/${s.subject.employeeId}/subsets/education`),
    );
    expect(education.items).toEqual([
      expect.objectContaining({ school: '自助大学', sourceType: 'self_service', sourceId: view.businessId }),
    ]);

    const rejected = await submit('驳回大学');
    const returned = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, rejected.tasks[0]!.id, 'reject', rejected.revision, { comment: '不通过' }),
    );
    expect(returned.status).toBe('returned');
    const withdrawn = await w.json<InstanceView>(
      await w.instanceAction(s.subject.userId, returned.id, 'withdraw', returned.revision),
    );
    expect(withdrawn.status).toBe('withdrawn');
    const stored = await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`SELECT status FROM personnel_change_requests WHERE id=${rejected.businessId}::uuid`),
    );
    expect(rowsOf<{ status: string }>(stored)[0]).toMatchObject({ status: 'withdrawn' });
    const audits = await withTenant(w.db, w.tenant.id, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.objectId, rejected.businessId)),
    );
    expect(audits.length).toBeGreaterThan(0);
  });
});
