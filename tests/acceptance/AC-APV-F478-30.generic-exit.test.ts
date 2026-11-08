/**
 * AC-APV-F478-30 通用出口参数（设计 §4、§8）：办理请求体可选 exit（approve / disagree 族）。
 * - 同意带 exit:approve 与不带等价（含命令台账重放不重复推进）；
 * - 未知编码 400；同意接口传不同意族编码 400，反之亦然；驳回 / 驳回到上一步不接受 exit（400）；
 * - 节点没有的出口：带 exit → 409 APPROVAL_EXIT_NOT_AVAILABLE，不带 exit 保持既有 409 APPROVAL_ACTION_DISABLED；
 * - 详情 exits 与 actions 同时公布且一致，只对能办理的人公布。
 * 所有租户数据读取放进 withTenant（DEC-568）。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { APV, activationsOf, pendingOf, routeScene, taskPost, type RouteScene } from './AC-APV-F478-support.js';
import { detailOf, errorInfo } from './AC-APV-F478-s2-support.js';

const testDb = useTestDb();

async function decisionExit(s: RouteScene, taskId: string): Promise<string | null> {
  return withTenant(s.w.db, s.w.tenant.id, async (tx) => {
    const result = await tx.execute(
      sql`SELECT decision_exit FROM approval_tasks WHERE tenant_id=${s.w.tenant.id} AND id=${taskId}::uuid`,
    );
    const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
      decision_exit: string | null;
    }[];
    return rows[0]!.decision_exit;
  });
}

type Exits = readonly ('approve' | 'disagree')[];
async function started(label: string, n1Exits: Exits, withReject = true) {
  const s = await routeScene(testDb().db, label);
  await s.w.publishedProcess({
    nodes: s.nodes({ n1: { exits: n1Exits, actions: { reject: withReject, rejectToPrevious: true } } }).slice(0, 3),
  });
  return { s, view: await s.start(s.depts.d1) };
}

const decide = (
  s: RouteScene,
  view: Awaited<ReturnType<RouteScene['start']>>,
  action: 'approve' | 'disagree',
  body: Record<string, unknown>,
) => {
  const task = pendingOf(view)[0]!;
  return s.w.request(task.assigneeUserId, 'POST', `${APV}/tasks/${task.id}/${action}`, {
    ifMatch: view.revision,
    body,
  });
};

describe('AC-APV-F478-30 同意 / 不同意的 exit 参数', () => {
  it('同意带 exit:approve 与不带等价：都推进到下一节点并记 approve 出口', async () => {
    const withExit = await started('f478-30-eq-with', ['approve']);
    const without = await started('f478-30-eq-without', ['approve']);
    const first = await decide(withExit.s, withExit.view, 'approve', { comment: '同意', exit: 'approve' });
    expect(first.status, await first.clone().text()).toBe(200);
    const second = await decide(without.s, without.view, 'approve', { comment: '同意' });
    expect(second.status).toBe(200);
    for (const [s, view] of [
      [withExit.s, withExit.view],
      [without.s, without.view],
    ] as const) {
      const after = await s.w.detail(view.id);
      expect(after.currentNodeKey).toBe('n2');
      expect(await decisionExit(s, pendingOf(view)[0]!.id)).toBe('approve');
      expect((await activationsOf(s.w, view.id)).map((row) => row.node_key)).toEqual(['n1', 'n2']);
    }
  });

  it('同一命令 ID 带 exit 重放：返回首次结果，不重复推进；带与不带 exit:approve 指纹等价', async () => {
    const { s, view } = await started('f478-30-replay', ['approve']);
    const task = pendingOf(view)[0]!;
    const call = (body: Record<string, unknown>) =>
      s.w.request(task.assigneeUserId, 'POST', `${APV}/tasks/${task.id}/approve`, {
        ifMatch: view.revision,
        body,
        idempotencyKey: 'f478-30-replay-1',
      });
    const first = await call({ comment: '同意', exit: 'approve' });
    expect(first.status, await first.clone().text()).toBe(200);
    const rows = await activationsOf(s.w, view.id);
    const again = await call({ comment: '同意', exit: 'approve' });
    expect(again.status).toBe(200);
    expect(await activationsOf(s.w, view.id)).toEqual(rows);
    // 默认出口显式写出与省略等价：同键同内容不报冲突
    const omitted = await call({ comment: '同意' });
    expect(omitted.status, await omitted.clone().text()).toBe(200);
    expect(await activationsOf(s.w, view.id)).toEqual(rows);
    // 同键异内容仍然冲突
    const different = await call({ comment: '换了意见', exit: 'approve' });
    expect(different.status).toBe(409);
  });

  it('不同意带 exit:disagree 与不带等价', async () => {
    const a = await started('f478-30-dis-with', ['approve', 'disagree']);
    const b = await started('f478-30-dis-without', ['approve', 'disagree']);
    expect((await decide(a.s, a.view, 'disagree', { comment: '不同意', exit: 'disagree' })).status).toBe(200);
    expect((await decide(b.s, b.view, 'disagree', { comment: '不同意' })).status).toBe(200);
    for (const { s, view } of [a, b]) {
      expect((await s.w.detail(view.id)).status).toBe('disapproved');
      expect(await decisionExit(s, pendingOf(view)[0]!.id)).toBe('disagree');
    }
  });

  it('未知编码 → 400；同意接口传不同意族编码 → 400；不同意接口传同意族编码 → 400；状态不变', async () => {
    const { s, view } = await started('f478-30-bad', ['approve', 'disagree']);
    for (const [action, exit] of [
      ['approve', 'maybe'],
      ['approve', ''],
      ['approve', 'disagree'],
      ['disagree', 'approve'],
      ['disagree', 'maybe'],
    ] as const) {
      const response = await decide(s, view, action, { comment: 'x', exit });
      expect(response.status, `${action}:${exit}`).toBe(400);
    }
    const unchanged = await s.w.detail(view.id);
    expect(unchanged.revision).toBe(view.revision);
    expect(pendingOf(unchanged)).toHaveLength(1);
  });

  it('驳回与驳回到上一步不接受 exit（DEC-831⑥）', async () => {
    const { s, view } = await started('f478-30-reject', ['approve']);
    const rejected = await decide(s, view, 'approve', { comment: '过' });
    expect(rejected.status).toBe(200);
    const next = await s.w.detail(view.id);
    const reject = await s.w.request(
      pendingOf(next)[0]!.assigneeUserId,
      'POST',
      `${APV}/tasks/${pendingOf(next)[0]!.id}/reject`,
      {
        ifMatch: next.revision,
        body: { comment: '驳回', exit: 'approve' },
      },
    );
    expect(reject.status).toBe(400);
    const back = await taskPost(s, next, 'reject-previous', { comment: '退回', exit: 'approve' });
    expect(back.status).toBe(400);
    expect((await s.w.detail(view.id)).revision).toBe(next.revision);
  });

  it('节点没有的出口：带 exit → 409 APPROVAL_EXIT_NOT_AVAILABLE；不带 exit 保持既有 409 APPROVAL_ACTION_DISABLED', async () => {
    const { s, view } = await started('f478-30-missing', ['disagree']);
    const withExit = await decide(s, view, 'approve', { comment: '同意', exit: 'approve' });
    expect(await errorInfo(withExit)).toMatchObject({ status: 409, reason: 'APPROVAL_EXIT_NOT_AVAILABLE' });
    // 业务出口编码是已知编码，但该节点没有这个出口，同样是 409 而不是 400
    const business = await decide(s, view, 'approve', { comment: '同意', exit: 'approve_rehire' });
    expect(await errorInfo(business)).toMatchObject({ status: 409, reason: 'APPROVAL_EXIT_NOT_AVAILABLE' });
    const bare = await decide(s, view, 'approve', { comment: '同意' });
    expect(await errorInfo(bare)).toMatchObject({ status: 409, reason: 'APPROVAL_ACTION_DISABLED' });
    // 状态不变：任务仍待办，该节点的不同意仍可办理
    const unchanged = await s.w.detail(view.id);
    expect(unchanged.revision).toBe(view.revision);
    expect(pendingOf(unchanged)).toHaveLength(1);
    expect((await decide(s, unchanged, 'disagree', { comment: '不同意', exit: 'disagree' })).status).toBe(200);
  });

  it('409 之后重读再办理：改回合法出口可以提交（不吞改动）', async () => {
    const { s, view } = await started('f478-30-retry', ['disagree']);
    expect((await decide(s, view, 'approve', { comment: '同意', exit: 'approve' })).status).toBe(409);
    const fresh = await s.w.detail(view.id);
    const done = await decide(s, fresh, 'disagree', { comment: '不同意', exit: 'disagree' });
    expect(done.status, await done.clone().text()).toBe(200);
    expect((await s.w.detail(view.id)).status).toBe('disapproved');
  });
});

describe('AC-APV-F478-30 详情 exits 与 actions 一致', () => {
  it('能办理的人看到 exits（code / label / family），与 actions 的同意 / 不同意一致', async () => {
    const { s, view } = await started('f478-30-exits', ['approve', 'disagree']);
    const detail = await detailOf(s.w, view.id, pendingOf(view)[0]!.assigneeUserId);
    expect(detail.exits).toEqual([
      { code: 'approve', label: '同意', family: 'approve' },
      { code: 'disagree', label: '不同意', family: 'disagree' },
    ]);
    expect(detail.actions).toEqual(expect.arrayContaining(['approve', 'disagree']));
    const only = await started('f478-30-exits-only', ['disagree']);
    const onlyDetail = await detailOf(only.s.w, only.view.id, pendingOf(only.view)[0]!.assigneeUserId);
    expect(onlyDetail.exits).toEqual([{ code: 'disagree', label: '不同意', family: 'disagree' }]);
    expect(onlyDetail.actions).toContain('disagree');
    expect(onlyDetail.actions).not.toContain('approve');
  });

  it('没有办理权的人（发起人 / 管理员以外的查看人）exits 为空，与 actions 一致', async () => {
    const { s, view } = await started('f478-30-exits-viewer', ['approve', 'disagree']);
    const outsider = await detailOf(s.w, view.id, s.w.hr.id);
    expect(outsider.actions).not.toContain('approve');
    expect(outsider.actions).not.toContain('disagree');
    expect(outsider.exits).toEqual([]);
  });

  it('流程结束后 exits 为空；无路由的线性流程详情 exits 仍按节点出口公布', async () => {
    const { s, view } = await started('f478-30-exits-end', ['approve']);
    let current = view;
    for (let step = 0; step < 3 && pendingOf(current).length; step += 1) {
      const response = await decide(s, current, 'approve', { comment: '同意' });
      expect(response.status).toBe(200);
      current = await s.w.detail(view.id);
    }
    const finished = await detailOf(s.w, view.id, s.people.n3.userId);
    expect(finished.status).toBe('approved');
    expect(finished.exits).toEqual([]);
  });
});
