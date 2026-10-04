/**
 * PR #35 第二轮清单 主题 F：员工子集变更审批。
 * 9 按申请的 targetRevision 读子集历史版本：原值不随审批落地漂移；源记录被删除后仍能查看、撤回并给出冲突；
 * 22 DEC-099 被驳回后在同一张单上修正重提，修正内容追加为新版本、历史保留。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, transferScene, type ApprovalWorld, type InstanceView } from './AC-APV-support.js';

const database = useTestDb();
const BASE = '/api/tenant/approval';

function rowsOf<T>(value: unknown): T[] {
  return (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];
}

function current(view: InstanceView) {
  const tasks = view.tasks.filter((task) => task.status === 'pending');
  expect(tasks).toHaveLength(1);
  return tasks[0]!;
}

async function scene(label: string) {
  const w = await approvalWorld(database().db, label);
  const s = await transferScene(w);
  const settings = await w.request(w.hr.id, 'PUT', '/api/tenant/settings/personnel.self_service_fields', {
    ifMatch: 0,
    body: { value: { education: ['school'] } },
  });
  expect(settings.status).toBe(200);
  await w.publishedProcess({
    approvalType: 'personnel_change',
    conditions: { items: [{ no: 1, field: 'request.subset', operator: 'eq', value: 'education' }] },
    nodes: [{ key: 'head', approver: 'latest_record_department_head', formFields: ['school'] }],
  });
  const path = `/api/tenant/personnel/employees/${s.subject.employeeId}/subsets/education`;
  const record = await w.json<{ id: string; revision: number }>(
    await w.request(w.hr.id, 'POST', path, { ifMatch: 0, body: { school: '甲校', educationLevel: '本科' } }),
    201,
  );
  const request = async (values: Record<string, unknown>, target = record) => {
    const response = await w.request(s.subject.userId, 'POST', '/api/tenant/personnel/change-requests', {
      ifMatch: 0,
      body: {
        employeeId: s.subject.employeeId,
        subset: 'education',
        recordId: target.id,
        targetRevision: target.revision,
        values,
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const created = (await response.json()) as { id: string };
    return w.instanceOf(created.id, s.subject.userId);
  };
  return { w, s, path, record, request };
}

async function versions(w: ApprovalWorld, requestId: string) {
  return withTenant(w.db, w.tenant.id, async (tx) =>
    rowsOf<{ version_no: number; values: Record<string, unknown> }>(
      await tx.execute(sql`SELECT version_no,values FROM personnel_change_request_versions
        WHERE request_id=${requestId}::uuid ORDER BY version_no`),
    ),
  );
}

describe('清单 9：员工子集审批按申请的 targetRevision 读历史版本', () => {
  it('审批落地后详情里的原值仍是申请时的版本，不漂移成新值', async () => {
    const { w, s, request } = await scene('apv-sub-original');
    const view = await request({ school: '乙校' });
    expect(view.form).toMatchObject({ values: { school: '乙校' }, originals: { school: '甲校' } });
    const done = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision),
    );
    expect(done.status).toBe('approved');
    expect((await w.detail(view.id, s.outHead.userId)).form.originals).toEqual({ school: '甲校' });
  });

  it('源记录被删除后：详情仍可查看，同意给出冲突，发起人可撤回且待办消失', async () => {
    const { w, s, path, record, request } = await scene('apv-sub-deleted');
    const view = await request({ school: '乙校' });
    const removed = await w.request(w.hr.id, 'DELETE', `${path}/${record.id}`, { ifMatch: record.revision });
    expect(removed.status, await removed.clone().text()).toBe(200);
    const opened = await w.detail(view.id, s.outHead.userId);
    expect(opened.form.originals).toEqual({ school: '甲校' });
    const approve = await w.taskAction(s.outHead.userId, current(opened).id, 'approve', opened.revision);
    expect(approve.status).toBe(409);
    const withdrawn = await w.json<InstanceView>(
      await w.instanceAction(s.subject.userId, view.id, 'withdraw', opened.revision),
    );
    expect(withdrawn.status).toBe('withdrawn');
    expect((await w.todos(s.outHead.userId)).items).toEqual([]);
  });
});

describe('清单 22：员工信息变更被驳回后同单修正重提（DEC-099）', () => {
  it('修正内容追加为新版本，历史保留；重提后同一实例继续审批并按修正值落地', async () => {
    const { w, s, request } = await scene('apv-sub-correct');
    const view = await request({ school: '错别字大学' });
    const returned = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, current(view).id, 'reject', view.revision, { comment: '学校名称有误' }),
    );
    expect(returned.status).toBe('returned');
    const outside = await w.request(s.subject.userId, 'POST', `${BASE}/instances/${view.id}/resubmit`, {
      ifMatch: returned.revision,
      body: { fields: { educationLevel: '博士' } },
    });
    expect(outside.status).toBe(403);
    const resubmitted = await w.json<InstanceView>(
      await w.request(s.subject.userId, 'POST', `${BASE}/instances/${view.id}/resubmit`, {
        ifMatch: returned.revision,
        body: { fields: { school: '正确大学' } },
      }),
    );
    expect(resubmitted).toMatchObject({ id: view.id, status: 'running', form: { values: { school: '正确大学' } } });
    expect((await versions(w, view.businessId)).map((row) => row.values)).toEqual([
      { school: '错别字大学' },
      { school: '正确大学' },
    ]);
    const done = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, current(resubmitted).id, 'approve', resubmitted.revision),
    );
    expect(done.status).toBe('approved');
    const education = await w.json<{ items: { school: string }[] }>(
      await w.request(w.hr.id, 'GET', `/api/tenant/personnel/employees/${s.subject.employeeId}/subsets/education`),
    );
    expect(education.items.map((item) => item.school)).toEqual(['正确大学']);
  });
});
