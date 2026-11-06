/**
 * AC-APV-F478-s1 任务出口记录（设计 §3.2）：任务以同意 / 不同意族结束时写 decision_exit，
 * 其余结束方式（前加签挂起、驳回、转交）保持为空。第 1 轮审查 P2-1：后加签原审批人漏写出口。
 * 所有租户数据读取放进 withTenant（DEC-568）。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  APV,
  approveCurrent,
  disagreeCurrent,
  pendingOf,
  routeScene,
  taskPost,
  type RouteScene,
} from './AC-APV-F478-support.js';

const testDb = useTestDb();

interface TaskExit {
  readonly status: string;
  readonly decision_exit: string | null;
}

async function exitOf(s: RouteScene, taskId: string): Promise<TaskExit> {
  return withTenant(s.w.db, s.w.tenant.id, async (tx) => {
    const result = await tx.execute(
      sql`SELECT status,decision_exit FROM approval_tasks WHERE tenant_id=${s.w.tenant.id} AND id=${taskId}::uuid`,
    );
    return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows)[0] as TaskExit;
  });
}

const addSignable = { actions: { addSign: true, reject: true, rejectToPrevious: true, transfer: true } };

async function startSingle(s: RouteScene, nodeExits: readonly ('approve' | 'disagree')[] = ['approve']) {
  await s.w.publishedProcess({
    nodes: s.nodes({ n1: { ...addSignable, exits: nodeExits }, n2: { exits: ['approve'] } }).slice(0, 2),
  });
  return s.start(s.depts.d1);
}

describe('AC-APV-F478 任务出口记录', () => {
  it('后加签：原审批人任务 approved 且 decision_exit=approve（审查 P2-1）', async () => {
    const s = await routeScene(testDb().db, 'f478-exit-after');
    const view = await startSingle(s);
    const task = pendingOf(view)[0]!;
    const signer = await s.w.member('后加签人');
    const response = await s.w.request(task.assigneeUserId, 'POST', `${APV}/tasks/${task.id}/add-sign`, {
      ifMatch: view.revision,
      body: { userIds: [signer], type: 'after', comment: '请再看' },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await exitOf(s, task.id)).toEqual({ status: 'approved', decision_exit: 'approve' });
    // 加签人办理同意后同样记 approve
    const after = await s.w.detail(view.id);
    const signerTask = pendingOf(after)[0]!;
    expect(signerTask.assigneeUserId).toBe(signer);
    await s.w.json(await s.w.taskAction(signer, signerTask.id, 'approve', after.revision, { comment: '同意' }));
    expect(await exitOf(s, signerTask.id)).toEqual({ status: 'approved', decision_exit: 'approve' });
  });

  it('前加签：原审批人任务挂起，出口仍为空', async () => {
    const s = await routeScene(testDb().db, 'f478-exit-before');
    const view = await startSingle(s);
    const task = pendingOf(view)[0]!;
    const signer = await s.w.member('前加签人');
    const response = await s.w.request(task.assigneeUserId, 'POST', `${APV}/tasks/${task.id}/add-sign`, {
      ifMatch: view.revision,
      body: { userIds: [signer], type: 'before', comment: '先看' },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await exitOf(s, task.id)).toEqual({ status: 'add_signed', decision_exit: null });
  });

  it('不同意写 disagree 出口', async () => {
    const s = await routeScene(testDb().db, 'f478-exit-disagree');
    const view = await startSingle(s, ['approve', 'disagree']);
    const task = pendingOf(view)[0]!;
    await disagreeCurrent(s, view);
    expect(await exitOf(s, task.id)).toEqual({ status: 'disagreed', decision_exit: 'disagree' });
  });

  it('同意写 approve 出口；下一节点驳回到上一步，该任务 rejected 且无出口', async () => {
    const s = await routeScene(testDb().db, 'f478-exit-approve');
    const view = await startSingle(s);
    const approved = pendingOf(view)[0]!;
    const next = await approveCurrent(s, view);
    expect(await exitOf(s, approved.id)).toEqual({ status: 'approved', decision_exit: 'approve' });
    const second = pendingOf(next)[0]!;
    await s.w.json(await taskPost(s, next, 'reject-previous', { comment: '退回' }));
    expect(await exitOf(s, second.id)).toEqual({ status: 'rejected', decision_exit: null });
  });

  it('驳回与转交不写出口', async () => {
    const s = await routeScene(testDb().db, 'f478-exit-reject-transfer');
    const view = await startSingle(s);
    const task = pendingOf(view)[0]!;
    const target = await s.w.member('转交目标');
    const moved = await s.w.request(task.assigneeUserId, 'POST', `${APV}/tasks/${task.id}/transfer`, {
      ifMatch: view.revision,
      body: { toUserId: target, comment: '转给你' },
    });
    expect(moved.status, await moved.clone().text()).toBe(200);
    expect(await exitOf(s, task.id)).toEqual({ status: 'transferred', decision_exit: null });
    const after = await s.w.detail(view.id);
    const mine = pendingOf(after)[0]!;
    const rejected = await s.w.request(target, 'POST', `${APV}/tasks/${mine.id}/reject`, {
      ifMatch: after.revision,
      body: { comment: '驳回' },
    });
    expect(rejected.status, await rejected.clone().text()).toBe(200);
    expect(await exitOf(s, mine.id)).toEqual({ status: 'rejected', decision_exit: null });
  });
});
