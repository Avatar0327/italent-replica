/**
 * AC-F476-03 / 04（P3 部分）：同一人在同一轮同一节点重新激活、同一人跨节点办理——
 * 每次成功办理各落一份，已办读该人最后一次人工办理，待办中读现值；旧份不被覆盖。
 */
import { approverSource } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { flowWorld, oaNodes } from './AC-OA-approval-support.js';
import { rename } from './AC-OA-items-support.js';
import { NAME_A, NAME_C, type Scenario, copiesOf, copiesOfActor, post, seenBy } from './AC-F476-support.js';

const testDb = useTestDb();
const EDITABLE = ['subject', 'orgItems.name'];
const edit = (itemId: string, value: string) => ({ fields: { 'orgItems.name': [{ itemId, value }] } });

describe('AC-F476-03/04 同轮重新激活与跨节点同一人', () => {
  it('驳回上一步后同一轮 n1 再次激活：HRBP 两次同意各一份（A、C），待办中读现值，办完读最后一份', async () => {
    const w = await flowWorld(testDb().db, 'f476-03p3-reactivate', {
      nodes: oaNodes([{ editableFields: EDITABLE }, { actions: { rejectToPrevious: true } }]),
    });
    const { id, itemId } = await w.draft(rename(w.a, { name: NAME_A }));
    await w.submitted(id);
    const s: Scenario = { id, itemId, instanceId: (await w.instance(id)).id };
    await w.acted(id, w.hrbp, 'approve');
    const back = await post(w, id, w.head, 'reject-previous', { comment: '合成意见' });
    expect(back.status, await back.clone().text()).toBe(200);
    const live = await seenBy(w, s, w.hrbp.userId);
    expect([live.mode, live.centerNames]).toEqual(['live', [NAME_A]]); // 重新待办：读现值，不读上一次的份
    expect((await w.act(id, w.hrbp, 'edit', edit(itemId, NAME_C))).status).toBe(200);
    await w.acted(id, w.hrbp, 'approve');
    const mine = await copiesOfActor(w, s.instanceId, w.hrbp);
    expect(mine.map((c) => c.round)).toEqual([mine[0]!.round, mine[0]!.round]);
    expect(mine.map((c) => c.text.includes(NAME_C))).toEqual([false, true]);
    expect(new Set(mine.map((c) => c.task_id)).size).toBe(2);
    const done = await seenBy(w, s, w.hrbp.userId);
    expect([done.mode, done.centerNames]).toEqual(['frozen', [NAME_C]]);
    expect((await copiesOf(w, s.instanceId)).filter((c) => c.actor_user_id === w.head.userId)).toHaveLength(1);
  });

  it('同一人跨节点（n1、n2 都是 HRBP）：n2 待办读现值，办完读 n2 的份，n1 的份仍在', async () => {
    const hrbp = approverSource('approval_subject_org_hrbp');
    const w = await flowWorld(testDb().db, 'f476-03p3-cross-node', {
      nodes: oaNodes([
        { editableFields: EDITABLE },
        { approver: hrbp, editMode: 'separate', editableFields: EDITABLE },
      ]),
    });
    const { id, itemId } = await w.draft(rename(w.a, { name: NAME_A }));
    await w.submitted(id);
    const s: Scenario = { id, itemId, instanceId: (await w.instance(id)).id };
    await w.acted(id, w.hrbp, 'approve');
    expect((await w.act(id, w.hrbp, 'edit', edit(itemId, NAME_C))).status).toBe(200);
    const pending = await seenBy(w, s, w.hrbp.userId);
    expect([pending.mode, pending.centerNames]).toEqual(['live', [NAME_C]]);
    await w.acted(id, w.hrbp, 'approve');
    const mine = await copiesOfActor(w, s.instanceId, w.hrbp);
    expect(mine.map((c) => c.node_key)).toEqual(['n1', 'n2']);
    expect(mine.map((c) => c.text.includes(NAME_C))).toEqual([false, true]);
    const done = await seenBy(w, s, w.hrbp.userId);
    expect([done.mode, done.centerNames]).toEqual(['frozen', [NAME_C]]);
  });
});
