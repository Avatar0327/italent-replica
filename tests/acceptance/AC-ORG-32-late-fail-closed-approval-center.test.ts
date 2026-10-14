/**
 * S1-P2-01 同类入口：审批中心「编辑并同意」在最后节点通过时同事务调用 transitions.approve 落地；迟到落地同样按
 * DEC-278③ 判定 [计划日, 批准日)，区间内有未落地申请时流程通过、申请停在审批通过并记 REBUILD_REQUIRED 待 HR，
 * 任职不写入（编辑的字段仍保存在申请载荷上）。
 */
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { approvalWorld, transferScene } from './AC-APV-support.js';

const database = useTestDb();

it('编辑并同意：迟到落地区间内有草稿申请 → 流程通过、申请保持审批通过并记需重建，任职不变', async () => {
  const w = await approvalWorld(database().db, 'apv-late-rebuild');
  const s = await transferScene(w);
  const as = { user: w.hr.id, tenant: w.tenant.id };
  await w.publishedProcess({
    nodes: [
      {
        key: 'out_head',
        approver: 'latest_record_department_head',
        formFields: ['departmentId', 'place', 'remarks', 'effectiveDate'],
        editableFields: ['remarks'],
        editMode: 'with_approve',
      },
    ],
  });
  const late = await w.application(
    s.subject.employeeId,
    { departmentId: s.to, place: '原地点' },
    { effectiveDate: '2026-10-05' },
  );
  let view = await w.submit(late);
  const draft = await w.application(s.subject.employeeId, { place: '区间内草稿' }, { effectiveDate: '2026-10-08' });
  const records = async () =>
    w.json<{ items: { id: string }[] }>(
      await w.api.request(
        'GET',
        `/api/tenant/employment/employees/${s.subject.employeeId}/records?asOf=2026-10-10`,
        as,
      ),
    );
  const before = await records();
  w.setNow('2026-10-10T01:00:00Z');
  const task = view.tasks.find((item) => item.status === 'pending')!;
  view = await w.json(
    await w.taskAction(s.outHead.userId, task.id, 'approve', view.revision, { fields: { remarks: '合并编辑' } }),
  );
  expect(view.status).toBe('approved');
  const business = await w.json<{
    status: string;
    fields: Record<string, unknown>;
    activation: { status: string; failureReason: string | null } | null;
  }>(await w.api.request('GET', `/api/tenant/employment/businesses/${late.id}`, as));
  expect(business).toMatchObject({
    status: 'approved',
    fields: { remarks: '合并编辑' },
    activation: { status: 'failed', failureReason: 'REBUILD_REQUIRED' },
  });
  expect(await records()).toEqual(before);
  expect((await w.business(draft.id)).status).toBe('draft');
});
