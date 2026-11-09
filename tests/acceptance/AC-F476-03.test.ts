/**
 * AC-F476-03（P1 部分）：多轮办理。同一人在不同轮次各有自己的办理份；在办（有 pending 任务）读现值，
 * 办完后读最新一份；旧轮次的份不被改写。选择按 (instance, task, handling log) 定位，不靠任务数量上限。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { flowWorld } from './AC-OA-approval-support.js';
import {
  NAME_A,
  NAME_B,
  NAME_C,
  SUBJECT_B,
  SUBJECT_A,
  changeTo,
  copiesOfActor,
  handledThenChanged,
  seenBy,
} from './AC-F476-support.js';

const testDb = useTestDb();

describe('AC-F476-03 多轮办理', () => {
  it('重提后待办人读现值 B；办完读本轮的份；旧轮的份仍是 A；下一次改单后读最新一份', async () => {
    const w = await flowWorld(testDb().db, 'f476-03');
    const s = await handledThenChanged(w);
    await w.submitted(s.id); // 驳回后重提，沿原实例
    const pending = (await w.instance(s.id)).tasks.filter((t) => t.status === 'pending');
    expect(pending.map((t) => t.assigneeUserId)).toEqual([w.hrbp.userId]);

    // 在办：有自己的 pending 任务 → 现值（B），不因第一轮的份回到 A
    const live = await seenBy(w, s, w.hrbp.userId);
    expect(live.mode).toBe('live');
    expect(live.centerNames).toEqual([NAME_B]);
    expect(live.orgNames).toEqual([NAME_B]);

    await w.acted(s.id, w.hrbp, 'approve');
    await w.acted(s.id, w.head, 'reject');
    await changeTo(w, s, NAME_C, 'ZZ_第三次主题');

    const mine = await copiesOfActor(w, s.instanceId, w.hrbp);
    expect(mine.map((c) => c.round)).toHaveLength(2);
    expect(mine[0]!.text).toContain(NAME_A);
    expect(mine[0]!.text).not.toContain(NAME_B);
    expect(mine[1]!.text).toContain(NAME_B);
    expect(mine[1]!.text).not.toContain(NAME_C);

    const frozen = await seenBy(w, s, w.hrbp.userId);
    expect(frozen.mode).toBe('frozen');
    expect(frozen.centerNames).toEqual([NAME_B]);
    expect(frozen.orgNames).toEqual([NAME_B]);
    expect(frozen.centerSubject).toBe(SUBJECT_B);
    // 发起人读最新现值
    expect((await seenBy(w, s, w.hr.id)).centerNames).toEqual([NAME_C]);
  });

  it('另一位已办人（负责人）只有自己的份：第一轮 A、第二轮之前没有办理就不读别人的份', async () => {
    const w = await flowWorld(testDb().db, 'f476-03-other');
    const s = await handledThenChanged(w);
    await w.submitted(s.id);
    // 本轮负责人还没轮到：他自己的第一轮份是 A，当前没有 pending 任务 → 读自己最新一份（A），而不是 hrbp 的份或现值
    const head = await seenBy(w, s, w.head.userId);
    expect(head.centerNames).toEqual([NAME_A]);
    expect(head.centerSubject).toBe(SUBJECT_A);
    expect((await copiesOfActor(w, s.instanceId, w.head)).length).toBe(1);
  });
});
