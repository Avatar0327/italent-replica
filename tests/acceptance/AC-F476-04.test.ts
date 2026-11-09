/**
 * AC-F476-04（P1 部分）：编辑并同意冻结“编辑后候选态”（C）；单独“编辑”不入办理份；
 * 校验失败 / 基线冲突 / 盲审 / revision 冲突的办理不产生办理份、也不推进。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { flowWorld, oaNodes } from './AC-OA-approval-support.js';
import {
  NAME_A,
  NAME_B,
  NAME_C,
  SUBJECT_B,
  changeTo,
  copiesOf,
  copiesOfActor,
  post,
  seenBy,
} from './AC-F476-support.js';
import { rename } from './AC-OA-items-support.js';

const testDb = useTestDb();
const WITH_APPROVE = () => oaNodes([{ editMode: 'with_approve', editableFields: ['subject', 'orgItems.name'] }]);
const SEPARATE = () => oaNodes([{ editMode: 'separate', editableFields: ['subject', 'orgItems.name'] }]);

describe('AC-F476-04 编辑并同意', () => {
  it('同意时随 fields 把名称改成 C：办理份冻结 C；申请人事后改回 B，HRBP 的已办仍是 C', async () => {
    const w = await flowWorld(testDb().db, 'f476-04-with', { nodes: WITH_APPROVE() });
    const { id, itemId } = await w.draft(rename(w.a, { name: NAME_A }));
    await w.submitted(id);
    const res = await w.act(id, w.hrbp, 'approve', { fields: { 'orgItems.name': [{ itemId, value: NAME_C }] } });
    expect(res.status, await res.clone().text()).toBe(200);
    await w.acted(id, w.head, 'reject');
    const instanceId = (await w.instance(id)).id;
    await changeTo(w, { id, itemId }, NAME_B, SUBJECT_B);

    const seen = await seenBy(w, { id, itemId, instanceId }, w.hrbp.userId);
    expect(seen.centerNames).toEqual([NAME_C]);
    expect(seen.orgNames).toEqual([NAME_C]);
    const mine = await copiesOfActor(w, instanceId, w.hrbp);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain(NAME_C);
    expect(mine[0]!.text).not.toContain(NAME_A);
    expect(mine[0]!.text).not.toContain(NAME_B);
  });

  it('单独“编辑”不产生办理份；随后同意只产生一份，且含编辑结果', async () => {
    const w = await flowWorld(testDb().db, 'f476-04-sep', { nodes: SEPARATE() });
    const { id, itemId } = await w.draft(rename(w.a, { name: NAME_A }));
    await w.submitted(id);
    const instanceId = (await w.instance(id)).id;
    const edit = await w.act(id, w.hrbp, 'edit', { fields: { 'orgItems.name': [{ itemId, value: NAME_C }] } });
    expect(edit.status, await edit.clone().text()).toBe(200);
    expect(await copiesOf(w, instanceId)).toHaveLength(0);
    await w.acted(id, w.hrbp, 'approve');
    const mine = await copiesOfActor(w, instanceId, w.hrbp);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain(NAME_C);
  });

  it('基线冲突（409）与旧 revision（409）都不产生办理份，待办不动', async () => {
    const w = await flowWorld(testDb().db, 'f476-04-fail', { nodes: WITH_APPROVE() });
    const { id } = await w.draft(rename(w.a, { name: NAME_A }));
    await w.submitted(id);
    const instanceId = (await w.instance(id)).id;
    await w.touchOrg(w.a);
    const conflict = await post(w, id, w.hrbp, 'approve', { comment: '合成意见' });
    expect(conflict.status).toBe(409);
    const view = await w.instance(id);
    const task = view.tasks.find((t) => t.status === 'pending')!;
    const stale = await w.call(
      'POST',
      `/api/tenant/approval/tasks/${task.id}/approve`,
      { ifMatch: view.revision + 7, body: { comment: '合成意见' } },
      w.hrbp.userId,
    );
    expect(stale.status).toBe(409);
    expect(await copiesOf(w, instanceId)).toHaveLength(0);
    expect((await w.instance(id)).tasks.filter((t) => t.status === 'pending')).toHaveLength(1);
  });
});
