/**
 * AC-F476-06（P3 部分）：非办理出口与组合链路不伪造“亲自办理”。
 * 会签成员被结束而未办理 / 管理员转交（接管）/ 撤回后再转交：旧份保留，没办理的人不凭空多出份，
 * 没办理的人仍读现值（设计 §1.3「撤回」「会签结束」「管理员转交」行）。
 */
import { approverSource, ORG_ADJUSTMENT_FORM_FIELDS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { NodeInput } from './AC-APV-support.js';
import { flowWorld, oaNodes } from './AC-OA-approval-support.js';
import { rename } from './AC-OA-items-support.js';
import { APPROVAL, NAME_A, NAME_C, type Scenario, copiesOf, post, seenBy } from './AC-F476-support.js';

const testDb = useTestDb();
const EDITABLE = ['subject', 'orgItems.name'];

async function started(label: string, nodes: NodeInput[]) {
  const w = await flowWorld(testDb().db, label, { nodes });
  const { id, itemId } = await w.draft(rename(w.a, { name: NAME_A }));
  await w.submitted(id);
  const scenario: Scenario = { id, itemId, instanceId: (await w.instance(id)).id };
  return { w, scenario };
}

describe('AC-F476-06 组合链路', () => {
  it('会签任一人同意即通过：被结束而未办理的成员没有份，读现值，不冒认', async () => {
    const joint: NodeInput = {
      key: 'n1',
      name: '会签',
      kind: 'countersign',
      approvers: [approverSource('approval_subject_org_hrbp'), approverSource('approval_subject_org_head')],
      formFields: ORG_ADJUSTMENT_FORM_FIELDS,
      transitionRule: { type: 'any' },
    };
    const { w, scenario } = await started('f476-06-ended', [joint]);
    await w.acted(scenario.id, w.hrbp, 'approve');
    const view = await w.instance(scenario.id);
    expect(view.tasks.find((t) => t.assigneeUserId === w.head.userId)?.status).toBe('ended');
    const copies = await copiesOf(w, scenario.instanceId);
    expect(copies.map((c) => [c.actor_user_id, c.handling_kind])).toEqual([[w.hrbp.userId, 'human']]);
    expect((await seenBy(w, scenario, w.hrbp.userId)).mode).toBe('frozen');
    expect((await seenBy(w, scenario, w.head.userId)).mode).toBe('live');
  });

  it('撤回后再转交：旧同意份保留，转交另落一份（含撤回后的编辑）；接手人读现值', async () => {
    const actions = { retrieve: true, transfer: true };
    const { w, scenario } = await started(
      'f476-06-retrieve-transfer',
      oaNodes([{ actions, editableFields: EDITABLE }]),
    );
    await w.acted(scenario.id, w.hrbp, 'approve');
    const reopened = await w.instance(scenario.id);
    const old = reopened.tasks.find((t) => t.nodeKey === 'n1')!;
    const retrieve = await w.call(
      'POST',
      `${APPROVAL}/tasks/${old.id}/retrieve`,
      { ifMatch: reopened.revision, body: {} },
      w.hrbp.userId,
    );
    expect(retrieve.status, await retrieve.clone().text()).toBe(200);
    expect(await copiesOf(w, scenario.instanceId)).toHaveLength(1); // 撤回本身不落份
    const edit = await w.act(scenario.id, w.hrbp, 'edit', {
      fields: { 'orgItems.name': [{ itemId: scenario.itemId, value: NAME_C }] },
    });
    expect(edit.status, await edit.clone().text()).toBe(200);
    const taker = await w.person('接手人', w.subject);
    const moved = await post(w, scenario.id, w.hrbp, 'transfer', { toUserId: taker.userId, comment: '合成意见' });
    expect(moved.status, await moved.clone().text()).toBe(200);
    const mine = (await copiesOf(w, scenario.instanceId)).filter((c) => c.actor_user_id === w.hrbp.userId);
    expect(mine.map((c) => c.action)).toEqual(['approve', 'transfer']);
    expect(mine[0]!.text).toContain(NAME_A);
    expect(mine[1]!.text).toContain(NAME_C);
    // 已办读取选最后一次人工办理（转交，含 C），接手人没有办理，读现值
    const hrbp = await seenBy(w, scenario, w.hrbp.userId);
    expect([hrbp.mode, hrbp.centerNames]).toEqual(['frozen', [NAME_C]]);
    const taken = await seenBy(w, scenario, taker.userId);
    expect([taken.mode, taken.centerNames]).toEqual(['live', [NAME_C]]);
  });

  it('管理员转交：原待办人没办理，不落份、读现值；接手人办理后才有自己的份', async () => {
    const { w, scenario } = await started('f476-06-admin-transfer', oaNodes());
    const view = await w.instance(scenario.id);
    const task = view.tasks.find((t) => t.status === 'pending')!;
    const taker = await w.person('接管人', w.subject);
    const admin = await w.person('流程管理员', w.subject);
    const res = await w.call(
      'POST',
      `${APPROVAL}/instances/${view.id}/admin-transfer`,
      { ifMatch: view.revision, body: { taskId: task.id, toUserId: taker.userId, reason: '合成原因' } },
      admin.userId,
    );
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await copiesOf(w, scenario.instanceId)).toHaveLength(0);
    expect((await seenBy(w, scenario, w.hrbp.userId)).mode).toBe('live');
    await w.acted(scenario.id, taker, 'approve');
    const copies = await copiesOf(w, scenario.instanceId);
    expect(copies.map((c) => c.actor_user_id)).toEqual([taker.userId]);
    expect((await seenBy(w, scenario, taker.userId)).mode).toBe('frozen');
  });
});
