/**
 * astra R6-P2-01：申请修改（草稿修改、驳回后修改重提、审批节点独立编辑、编辑与同意合一）都是人工意图，
 * 迟到重建必须以审批生效的最终载荷为初始输入，不能把第一版初稿当成输入、把修改当成计算输出跳过。
 */
import { randomUUID } from 'node:crypto';
import { runEmploymentActivations } from '@italent/api';
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { activateWithJudgement } from '../../apps/api/src/modules/employment/activation-checks.js';
import { pendingActivations } from '../../apps/api/src/modules/employment/activation-store.js';
import { lockTransferParticipants } from '../../apps/api/src/modules/employment/transfer-locks.js';
import { approvalWorld, type ApprovalWorld, type InstanceView } from './AC-APV-support.js';
import { cmd } from './support/tenant-api.js';

const database = useTestDb();
const EMPLOYMENT = '/api/tenant/employment';
type Entry = 'draft-edit' | 'reject-resubmit' | 'node-edit' | 'edit-with-approve';
const cases = (['draft-edit', 'reject-resubmit', 'node-edit', 'edit-with-approve'] as Entry[]).flatMap((entry) =>
  [false, true].map((chain) => ({ entry, chain })),
);

interface Business {
  readonly id: string;
  readonly revision: number;
  readonly status: string;
}
interface RecordView {
  readonly id: string;
  readonly kind: string;
  readonly isCurrent: boolean;
  readonly effectiveDate: string;
  readonly fields: Record<string, unknown>;
}

function pendingTask(view: InstanceView) {
  const tasks = view.tasks.filter((task) => task.status === 'pending');
  expect(tasks).toHaveLength(1);
  return tasks[0]!;
}

async function records(w: ApprovalWorld, employeeId: string, asOf: string) {
  return (
    await w.json<{ items: RecordView[] }>(
      await w.request(w.hr.id, 'GET', `${EMPLOYMENT}/employees/${employeeId}/records?asOf=${asOf}`),
    )
  ).items;
}

async function patchBusiness(w: ApprovalWorld, id: string, fields: Record<string, unknown>) {
  const business = await w.business(id);
  return w.json<Business>(
    await w.request(w.hr.id, 'PATCH', `${EMPLOYMENT}/businesses/${id}`, {
      ifMatch: business.revision,
      body: { fields },
    }),
  );
}

/** 只落地指定的待生效业务（审批通过的组织调整申请），不执行同员工迟到的直接调动。 */
async function activateOnly(w: ApprovalWorld, employeeId: string, businessId: string, at: string) {
  await withTenant(w.db, w.tenant.id, async (tx) => {
    const ctx = {
      tenantId: w.tenant.id,
      userId: w.hr.id,
      timezone: w.tenant.timezone,
      now: new Date(at),
      commandId: randomUUID(),
      expectedRevision: 0,
    };
    await lockTransferParticipants(tx, ctx, employeeId);
    const target = (await pendingActivations(tx, ctx, employeeId)).find((item) => item.id === businessId);
    expect(target, `待生效业务 ${businessId} 必须存在`).toBeDefined();
    expect(await activateWithJudgement(tx, ctx, target!)).toBeNull();
  });
}

/** 通过真实审批入口把 10-09 组织调整申请从“初稿 A”改成“最终 B”并审批生效。 */
async function approvedAdjustment(w: ApprovalWorld, entry: Entry, employeeId: string, head: string) {
  const draft = await w.application(
    employeeId,
    { place: '初稿 A' },
    { kind: 'org_adjustment', effectiveDate: '2026-10-09' },
  );
  if (entry === 'draft-edit') await patchBusiness(w, draft.id, { place: '最终 B' });
  let view = await w.submit(await w.business(draft.id));
  if (entry === 'reject-resubmit') {
    view = await w.json(
      await w.taskAction(head, pendingTask(view).id, 'reject', view.revision, { comment: '请改地点' }),
    );
    expect(await w.business(draft.id)).toMatchObject({ status: 'rejected' });
    await patchBusiness(w, draft.id, { place: '最终 B' });
    view = await w.submit(await w.business(draft.id));
  }
  if (entry === 'node-edit') {
    const edited = await w.taskAction(head, pendingTask(view).id, 'edit', view.revision, {
      fields: { place: '最终 B' },
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    view = await w.instanceOf(draft.id);
  }
  const approved = await w.taskAction(head, pendingTask(view).id, 'approve', view.revision, {
    comment: '同意',
    ...(entry === 'edit-with-approve' ? { fields: { place: '最终 B' } } : {}),
  });
  expect(approved.status, await approved.clone().text()).toBe(200);
  expect(await w.business(draft.id)).toMatchObject({ status: 'approved' });
  await activateOnly(w, employeeId, draft.id, '2026-10-09T01:00:00Z');
  return draft.id;
}

it.each(cases)('AC-ORG-32 R6-P2-01 申请修改是重建输入 / $entry / 后接F-007=$chain', async ({ entry, chain }) => {
  const w = await approvalWorld(database().db, `r7app-${entry}-${chain}`);
  const org = await w.org('申请部门');
  // DEC-230 直线经理审批人：不走组织负责人夹具，组织 revision 保持可用于后续 F-007 改名。
  const head = await w.person('直线经理', org);
  const subject = await w.person('申请员工', org, { place: '原地点', directManagerId: head.employeeId });
  await w.publishedProcess({
    approvalType: 'org_adjustment',
    isFallback: true,
    conditions: { items: [], expression: '' },
    nodes: [
      {
        key: 'head',
        approver: 'direct_manager',
        formFields: ['departmentId', 'effectiveDate', 'place'],
        editableFields: ['place'],
        editMode: entry === 'edit-with-approve' ? 'with_approve' : 'separate',
      },
    ],
  });
  const employee = await w.json<{ revision: number }>(
    await w.request(w.hr.id, 'GET', `${EMPLOYMENT}/employees/${subject.employeeId}`),
  );
  const transfer = await w.json<Business>(
    await w.request(w.hr.id, 'POST', `${EMPLOYMENT}/employees/${subject.employeeId}/businesses`, {
      ifMatch: employee.revision,
      body: {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-10-05',
        fields: { remarks: '仅改备注的迟到调动' },
      },
    }),
    201,
  );
  const adjustmentId = await approvedAdjustment(w, entry, subject.employeeId, head.userId);
  const asOf = '2026-10-09';
  expect((await records(w, subject.employeeId, asOf)).find((r) => r.id === adjustmentId)?.fields.place).toBe('最终 B');
  let renamedId: string | undefined;
  if (chain) {
    const before = new Set((await records(w, subject.employeeId, asOf)).map((r) => r.id));
    const current = await w.json<{ revision: number }>(
      await w.request(w.hr.id, 'GET', `/api/tenant/org/organizations/${org}`),
    );
    const renamed = await w.request(w.hr.id, 'PATCH', `/api/tenant/org/organizations/${org}`, {
      ifMatch: current.revision,
      body: { name: '申请部门改名', effectiveDate: asOf, addEmployment: true },
    });
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    const added = (await records(w, subject.employeeId, asOf)).filter((r) => !before.has(r.id));
    expect(added).toHaveLength(1);
    renamedId = added[0]!.id;
    expect(added[0]!.fields.place).toBe('最终 B');
  }
  const run = await runEmploymentActivations(
    w.db,
    cmd(),
    { tenantId: w.tenant.id },
    { clock: () => new Date('2026-10-10T01:00:00Z') },
  );
  expect(run.runs[0]).toMatchObject({ failed: [], errors: [] });
  const rebuilt = await records(w, subject.employeeId, asOf);
  for (const id of [adjustmentId, ...(renamedId ? [renamedId] : [])])
    expect.soft(rebuilt.find((r) => r.id === id)?.fields, `组织调整 ${id}`).toMatchObject({
      place: '最终 B',
      departmentId: org,
      remarks: null,
    });
  expect((await records(w, subject.employeeId, '2026-10-10')).find((r) => r.isCurrent)).toMatchObject({
    id: transfer.id,
    effectiveDate: '2026-10-10',
    fields: { remarks: '仅改备注的迟到调动', place: '原地点' },
  });
});
