/**
 * BE-10c 组织调整审批（R2-T08 §3 状态机、§4.1～4.4）：提交 / 撤回路由、两节点取主体组织 HRBP / 负责人、审批中编辑只给
 * 当前节点审批人、驳回 / 撤回 / 作废 / 不同意。最后一节点同意后“审批通过 + 未执行”，同一事务写执行队列与涉及集合（BE-11b 拆关口，§7.1 / §14.1）。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { flowWorld } from './AC-OA-approval-support.js';
import { BASE, bodyOf, expectError } from './AC-OA-head-support.js';

const testDb = useTestDb();

describe('AC-OA-12 状态流转：已暂存 → 审批中 → 审批通过 + 未执行', () => {
  it('提交 0 → 1；两节点同意后 2 / 1 并入队；审计记提交、通过与排期', async () => {
    const w = await flowWorld(testDb().db, 'oa12');
    const { id } = await w.draft();
    const before = await w.state(id);
    expect(before).toMatchObject({ approval: 0, execution: 1 });
    const submitted = await w.submitted(id);
    expect(submitted).toMatchObject({ approvalStatus: 1, revision: before.revision + 1 });
    expect(await w.state(id)).toMatchObject({ approval: 1, execution: 1, queued: 0 });
    await w.acted(id, w.hrbp, 'approve');
    expect((await w.state(id)).approval).toBe(1);
    await w.acted(id, w.head, 'approve');
    const approved = await w.state(id);
    expect(approved).toMatchObject({ approval: 2, execution: 1 });
    expect(approved.queued, '审批通过即入队（BE-11b）').toBeGreaterThan(0);
    expect((await w.instance(id)).status).toBe('approved');
    expect(await w.audits(id)).toEqual(
      expect.arrayContaining([
        'org-adjustment.submit',
        'org-adjustment.approved',
        'org-adjustment.execution.scheduled',
      ]),
    );
  });

  it('提交带旧 revision → 409 且不建实例；重放同一命令得同一结果', async () => {
    const w = await flowWorld(testDb().db, 'oa12-replay');
    const { id } = await w.draft();
    const revision = await w.revisionOf(id);
    await expectError(await w.submit(id, revision - 1), 409, 'REVISION_CONFLICT');
    expect(await w.instances(id)).toEqual([]);
    const commandId = randomUUID();
    const send = () =>
      w.call('POST', `${BASE}/${id}/submit`, { ifMatch: revision, body: {}, idempotencyKey: commandId });
    const first = await send();
    expect(first.status, await first.clone().text()).toBe(200);
    const again = await send();
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(await first.json());
    expect(await w.instances(id)).toHaveLength(1);
  });
});

describe('AC-OA-13 流程 OrganizationProcess：两节点取审批主体组织 HRBP / 负责人', () => {
  it('节点 1 待办给主体组织 HRBP，节点 2 给负责人；实例流程编码与标题', async () => {
    const w = await flowWorld(testDb().db, 'oa13');
    const { id } = await w.draft();
    await w.submitted(id);
    const first = await w.instance(id);
    expect(first.processCode).toBe('OrganizationProcess');
    expect(first.subjectEmployeeId).toBeNull();
    const pending = () => first.tasks.filter((t) => t.status === 'pending');
    expect(pending()).toEqual([expect.objectContaining({ nodeKey: 'n1', assigneeUserId: w.hrbp.userId })]);
    await w.acted(id, w.hrbp, 'approve');
    const second = await w.instance(id);
    expect(second.tasks.filter((t) => t.status === 'pending')).toEqual([
      expect.objectContaining({ nodeKey: 'n2', assigneeUserId: w.head.userId }),
    ]);
  });
});

describe('AC-OA-14 审批中编辑只给当前节点审批人（OA-R7）', () => {
  it('当前审批人改头与明细：revision + 1，实例 businessVersion 同步；申请人走本模块 409、别人 403', async () => {
    const w = await flowWorld(testDb().db, 'oa14');
    const { id, itemId } = await w.draft();
    await w.submitted(id);
    const before = await w.state(id);
    const versionBefore = await w.businessVersion(id);
    expect(versionBefore).toBe(`revision:${before.revision}`);

    await expectError(
      await w.patch(id, { subject: '申请人改' }, before.revision),
      409,
      'CONFLICT',
      'ORG_ADJUSTMENT_IN_REVIEW',
    );
    const view = await w.instance(id);
    const task = view.tasks.find((t) => t.status === 'pending')!;
    const stranger = await w.call(
      'POST',
      `/api/tenant/approval/tasks/${task.id}/edit`,
      { ifMatch: view.revision, body: { fields: { subject: '别人改' } } },
      w.head.userId,
    );
    await expectError(stranger, 403, 'FORBIDDEN', 'APPROVAL_NOT_ASSIGNEE');

    const edited = await w.act(id, w.hrbp, 'edit', {
      fields: { subject: '审批人改', 'orgItems.name': [{ itemId, value: '审批人改的名称' }] },
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    const after = await w.state(id);
    expect(after).toMatchObject({ approval: 1, revision: before.revision + 1 });
    expect(await w.businessVersion(id)).toBe(`revision:${after.revision}`);
    expect((await w.stored(id))!.subject).toBe('审批人改');
    expect((await w.rows(id)).find((r) => r.id === itemId)?.name).toBe('审批人改的名称');
    const form = (await w.instance(id)).form.values;
    expect(form.subject).toBe('审批人改');
    expect(form['orgItems.name']).toEqual([{ itemId, value: '审批人改的名称' }]);
  });

  it('审批人改节点不可编辑的字段 → 403，单据不变；改不存在的明细行 → 400', async () => {
    const w = await flowWorld(testDb().db, 'oa14-scope');
    const { id } = await w.draft();
    await w.submitted(id);
    const before = await w.state(id);
    const notEditable = await w.act(id, w.hrbp, 'edit', { fields: { effectiveDate: '2026-12-01' } });
    await expectError(notEditable, 403, 'FORBIDDEN', 'APPROVAL_FIELD_NOT_EDITABLE');
    const unknown = await w.act(id, w.hrbp, 'edit', {
      fields: { 'orgItems.name': [{ itemId: randomUUID(), value: '不存在' }] },
    });
    expect(unknown.status, await unknown.clone().text()).toBe(400);
    expect(await w.state(id)).toEqual(before);
  });
});

describe('AC-OA-15 驳回 / 撤回 / 作废 / 不同意', () => {
  it('驳回 → 6，申请人可改，同实例重提回到 1；作废已驳回单 → 5，实例结束，不可再改', async () => {
    const w = await flowWorld(testDb().db, 'oa15-reject');
    const { id } = await w.draft();
    await w.submitted(id);
    await w.acted(id, w.hrbp, 'reject');
    expect((await w.state(id)).approval).toBe(6);
    const first = await w.instance(id);
    expect(first.status).toBe('returned');
    const patched = await w.patch(id, { content: '驳回后补充' }, await w.revisionOf(id));
    expect(patched.status, await patched.clone().text()).toBe(200);
    await w.submitted(id);
    const resumed = await w.instances(id);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({ id: first.id, status: 'running' });
    expect((await w.state(id)).approval).toBe(1);

    await w.acted(id, w.hrbp, 'reject');
    const voided = await w.voidIt(id, await w.revisionOf(id));
    expect(voided.status, await voided.clone().text()).toBe(200);
    expect((await w.state(id)).approval).toBe(5);
    expect((await w.instance(id)).status).toBe('cancelled');
    const late = await w.patch(id, { content: '作废后' }, await w.revisionOf(id));
    await expectError(late, 409, 'CONFLICT', 'ORG_ADJUSTMENT_NOT_EDITABLE');
    await expectError(await w.submit(id), 409, 'CONFLICT', 'ORG_ADJUSTMENT_NOT_EDITABLE');
  });

  it('审批中心重提已驳回单：按提交口径重判，回到 1', async () => {
    const w = await flowWorld(testDb().db, 'oa15-resubmit');
    const { id } = await w.draft();
    await w.submitted(id);
    await w.acted(id, w.hrbp, 'reject');
    const res = await w.instanceAction(id, 'resubmit');
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await w.state(id)).approval).toBe(1);
    expect((await w.instance(id)).status).toBe('running');
  });

  it('撤回只限申请人本人 → 0、实例 withdrawn；撤回后可再提交（同一实例）', async () => {
    const w = await flowWorld(testDb().db, 'oa15-withdraw');
    const { id } = await w.draft();
    await w.submitted(id);
    const before = await w.state(id);
    await expectError(
      await w.withdraw(id, before.revision, w.hrbp.userId),
      403,
      'FORBIDDEN',
      'ORG_ADJUSTMENT_NOT_APPLICANT',
    );
    expect(await w.state(id)).toEqual(before);
    const res = await w.withdraw(id);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await w.state(id)).toMatchObject({ approval: 0, revision: before.revision + 1 });
    const withdrawn = await w.instance(id);
    expect(withdrawn.status).toBe('withdrawn');
    expect(await w.audits(id)).toContain('org-adjustment.withdraw');
    await expectError(await w.withdraw(id), 409, 'CONFLICT', 'ORG_ADJUSTMENT_NOT_IN_REVIEW');
    await w.submitted(id);
    expect(await w.instance(id)).toMatchObject({ id: withdrawn.id, status: 'running' });
  });

  it('审批中心撤回同样回到 0', async () => {
    const w = await flowWorld(testDb().db, 'oa15-center-withdraw');
    const { id } = await w.draft();
    await w.submitted(id);
    const res = await w.instanceAction(id, 'withdraw');
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await w.state(id)).approval).toBe(0);
  });

  it('不同意 → 3 审批未通过（终态）：不可再改、再提交', async () => {
    const w = await flowWorld(testDb().db, 'oa15-disagree');
    const { id } = await w.draft();
    await w.submitted(id);
    await w.acted(id, w.hrbp, 'disagree');
    expect(await w.state(id)).toMatchObject({ approval: 3, execution: 1, queued: 0 });
    expect((await w.instance(id)).status).toBe('disapproved');
    const late = await w.patch(id, { content: '不同意后' }, await w.revisionOf(id));
    await expectError(late, 409, 'CONFLICT', 'ORG_ADJUSTMENT_NOT_EDITABLE');
    const body = await bodyOf(await w.submit(id));
    expect(body.error?.details?.reason).toBe('ORG_ADJUSTMENT_NOT_EDITABLE');
    expect(await w.audits(id)).toContain('org-adjustment.disapproved');
  });
});
