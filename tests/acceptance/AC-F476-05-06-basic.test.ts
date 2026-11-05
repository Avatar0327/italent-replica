/**
 * AC-F476-05 / 06 的 P1 基本保证：每个“普通成功动作”都在同一事务里落一份办理份（P3 再做复杂链路与故障注入收口）。
 * 同意 / 不同意 / 驳回 / 驳回到上一步 / 跳转 / 转交 / 前加签 / 后加签各一份；并加签发起时不捕获；
 * 申请人撤回、催办、抄送、发起人读取不产生办理份。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { flowWorld, oaNodes } from './AC-OA-approval-support.js';
import { copiesOf, post } from './AC-F476-support.js';

const testDb = useTestDb();
const ACTIONS = { transfer: true, addSign: true, rejectToPrevious: true, jump: true, copySend: true };
const nodes = () => oaNodes([{ actions: ACTIONS }, { actions: ACTIONS }]);

async function started(label: string) {
  const w = await flowWorld(testDb().db, label, { nodes: nodes() });
  const { id } = await w.draft();
  await w.submitted(id);
  return { w, id, instanceId: (await w.instance(id)).id };
}

describe('AC-F476-05 / 06 基本保证：成功动作各落一份', () => {
  it.each([
    ['approve', 'approve'],
    ['disagree', 'disagree'],
    ['reject', 'reject'],
  ] as const)('%s → 一份人工办理份，锚定该动作的日志', async (path) => {
    const { w, id, instanceId } = await started(`f476-${path}`);
    const task = (await w.instance(id)).tasks.find((t) => t.status === 'pending')!;
    const res = await post(w, id, w.hrbp, path, { comment: '合成意见' });
    expect(res.status, await res.clone().text()).toBe(200);
    const copies = await copiesOf(w, instanceId);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({
      task_id: task.id,
      actor_user_id: w.hrbp.userId,
      handling_kind: 'human',
      node_key: 'n1',
      business_type: 'org_adjustment',
      content_schema_version: 1,
    });
    expect(copies[0]!.payload_bytes).toBeGreaterThan(0);
  });

  it('驳回到上一步（n2 → n1）与跳转（n1 → n2）各一份', async () => {
    const { w, id, instanceId } = await started('f476-prev-jump');
    const jump = await post(w, id, w.hrbp, 'jump', { toNodeKey: 'n2', comment: '合成意见' });
    expect(jump.status, await jump.clone().text()).toBe(200);
    expect(await copiesOf(w, instanceId)).toHaveLength(1);
    const back = await post(w, id, w.head, 'reject-previous', { comment: '合成意见' });
    expect(back.status, await back.clone().text()).toBe(200);
    const copies = await copiesOf(w, instanceId);
    expect(copies.map((c) => [c.node_key, c.actor_user_id])).toEqual([
      ['n1', w.hrbp.userId],
      ['n2', w.head.userId],
    ]);
  });

  it('转交：转出人一份；接手人在自己办理前没有份', async () => {
    const { w, id, instanceId } = await started('f476-transfer');
    const taker = await w.person('接手人', w.subject);
    const res = await post(w, id, w.hrbp, 'transfer', { toUserId: taker.userId, comment: '合成意见' });
    expect(res.status, await res.clone().text()).toBe(200);
    const copies = await copiesOf(w, instanceId);
    expect(copies).toHaveLength(1);
    expect(copies[0]!.actor_user_id).toBe(w.hrbp.userId);
    expect(copies.some((c) => c.actor_user_id === taker.userId)).toBe(false);
  });

  it('前加签：原任务关闭时落一份；后加签：同意日志是唯一锚点（只一份）；并加签发起不落', async () => {
    for (const [type, expected] of [
      ['before', 1],
      ['after', 1],
      ['parallel', 0],
    ] as const) {
      const { w, id, instanceId } = await started(`f476-sign-${type}`);
      const signer = await w.person(`加签人${type}`, w.subject);
      const res = await post(w, id, w.hrbp, 'add-sign', { userIds: [signer.userId], type, comment: '合成意见' });
      expect(res.status, `${type}: ${await res.clone().text()}`).toBe(200);
      const copies = await copiesOf(w, instanceId);
      expect(copies, type).toHaveLength(expected);
      if (expected) expect(copies[0]!.actor_user_id).toBe(w.hrbp.userId);
    }
  });

  it('申请人撤回、抄送不产生办理份', async () => {
    const { w, id, instanceId } = await started('f476-nocopy');
    const cc = await w.person('抄送人', w.subject);
    const sent = await post(w, id, w.hrbp, 'cc', { userIds: [cc.userId], comment: '合成意见' });
    expect(sent.status, await sent.clone().text()).toBe(200);
    expect(await copiesOf(w, instanceId)).toHaveLength(0);
    const out = await w.instanceAction(id, 'withdraw');
    expect(out.status, await out.clone().text()).toBe(200);
    expect(await copiesOf(w, instanceId)).toHaveLength(0);
  });
});
