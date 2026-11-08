/**
 * F-478 S2 详情 path：单人节点的 exit 只在“本次激活确实结算并流转出去”时披露，值取该次结算的出口（R4）。
 * 任务上的同意票（后加签时本人先写的同意、前加签人与转交接任人的同意）是中间票，加签链没走完、被驳回、被跳转截断都不披露。
 * 一格一条真实 HTTP 用例：加签 / 转交 / 办理 / 管理员跳转都走公开接口，详情读 path。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approveCurrent, pendingOf, routeScene, taskPost, type RouteScene } from './AC-APV-F478-support.js';
import { detailOf, publishViaHttp } from './AC-APV-F478-s2-support.js';

const testDb = useTestDb();

const ACTIONS = { rejectToPrevious: true, jump: true, retrieve: true, reject: true, addSign: true, transfer: true };

interface Chain {
  readonly s: RouteScene;
  readonly id: string;
  /** 节点原审批人、加签人 C / D、转交接任人 X。 */
  readonly a: string;
  readonly c: string;
  readonly d: string;
  readonly x: string;
}

type Act = 'approve' | 'disagree' | 'reject' | 'transfer' | 'add-sign';

/** 以 userId 办理其当前待办（每次重取详情，取最新 revision）。 */
async function step(chain: Pick<Chain, 's' | 'id'>, userId: string, action: Act, body: Record<string, unknown> = {}) {
  const view = await chain.s.w.detail(chain.id);
  const task = pendingOf(view).find((candidate) => candidate.assigneeUserId === userId);
  expect(task, `${action} 前 ${userId} 应有待办`).toBeDefined();
  const payload = action === 'reject' ? { comment: '驳回', ...body } : body;
  const response = await chain.s.w.taskAction(userId, task!.id, action, view.revision, payload);
  expect(response.status, await response.clone().text()).toBe(200);
}

/** N1 开启加签 / 转交 / 驳回 / 不同意；可选先“同意→撤回”让 N1 重开；A 随后加签给 C、D（type 前 / 后）。 */
async function chainScene(label: string, type: 'after' | 'before', retrieve = false): Promise<Chain> {
  const s = await routeScene(testDb().db, label);
  await publishViaHttp(s.w, s.nodes({ n1: { exits: ['approve', 'disagree'], actions: ACTIONS } }).slice(0, 3), {});
  let view = await s.start(s.depts.d1);
  const first = pendingOf(view)[0]!;
  if (retrieve) {
    view = await approveCurrent(s, view);
    await s.w.json(await taskPost(s, view, 'retrieve', {}, first.id, first.assigneeUserId));
  }
  const c = (await s.w.person('加签人C', s.home)).userId;
  const d = (await s.w.person('加签人D', s.home)).userId;
  const x = (await s.w.person('转交接任人X', s.home)).userId;
  const chain = { s, id: view.id, a: first.assigneeUserId, c, d, x };
  await step(chain, chain.a, 'add-sign', { userIds: [c, d], type });
  return chain;
}

/** 详情里 N1 的 path 步骤与实例状态。 */
async function n1Of(chain: Pick<Chain, 's' | 'id'>) {
  const detail = await detailOf(chain.s.w, chain.id);
  return { status: detail.status, n1: detail.path!.find((candidate) => candidate.nodeKey === 'n1')! };
}

async function expectNoExit(chain: Chain, status: string) {
  const { status: actual, n1 } = await n1Of(chain);
  expect(actual).toBe(status);
  expect(n1).not.toHaveProperty('exit');
}

describe('F-478 S2 详情 path：加签链的出口取本次激活的结算结果', () => {
  it('格 1 后加签 C、D：C 转交 X、X 同意、D 驳回 → returned，N1 无 exit', async () => {
    const chain = await chainScene('f478-chain-1', 'after');
    await step(chain, chain.c, 'transfer', { toUserId: chain.x });
    await step(chain, chain.x, 'approve');
    await step(chain, chain.d, 'reject');
    await expectNoExit(chain, 'returned');
  });

  it('格 2 同 1，D 不同意 → disapproved，N1 exit=disagree', async () => {
    const chain = await chainScene('f478-chain-2', 'after');
    await step(chain, chain.c, 'transfer', { toUserId: chain.x });
    await step(chain, chain.x, 'approve');
    await step(chain, chain.d, 'disagree');
    const { status, n1 } = await n1Of(chain);
    expect(status).toBe('disapproved');
    expect(n1).toMatchObject({ state: 'passed', exit: 'disagree' });
  });

  it('格 3 同 1，D 同意 → 流转到 N2，N1 exit=approve', async () => {
    const chain = await chainScene('f478-chain-3', 'after');
    await step(chain, chain.c, 'transfer', { toUserId: chain.x });
    await step(chain, chain.x, 'approve');
    await step(chain, chain.d, 'approve');
    const { status, n1 } = await n1Of(chain);
    expect(status).toBe('running');
    expect(n1).toMatchObject({ state: 'passed', exit: 'approve' });
  });

  it('格 4 后加签 C、D：C 同意、D 待办时管理员跳转到 N3 → N1 无 exit（加签链被截断）', async () => {
    const chain = await chainScene('f478-chain-4', 'after');
    await step(chain, chain.c, 'approve');
    const admin = await chain.s.w.member('流程管理员');
    const view = await chain.s.w.detail(chain.id);
    const jumped = await chain.s.w.instanceAction(admin, chain.id, 'admin-intervene', view.revision, {
      kind: 'jump',
      toNodeKey: 'n3',
      reason: '跳过',
    });
    expect(jumped.status, await jumped.clone().text()).toBe(200);
    expect((await chain.s.w.detail(chain.id)).currentNodeKey).toBe('n3');
    const { n1 } = await n1Of(chain);
    expect(n1).not.toHaveProperty('exit');
  });

  it('格 5 前加签 C、D：C 转交 X，X、D 同意后原审批人 同意 / 不同意 / 驳回 → approve / disagree / 无 exit', async () => {
    const cases = [
      ['approve', 'running', 'approve'],
      ['disagree', 'disapproved', 'disagree'],
      ['reject', 'returned', undefined],
    ] as const;
    for (const [action, status, exit] of cases) {
      const chain = await chainScene(`f478-chain-5-${action}`, 'before');
      await step(chain, chain.c, 'transfer', { toUserId: chain.x });
      await step(chain, chain.x, 'approve');
      await step(chain, chain.d, 'approve');
      await step(chain, chain.a, action);
      const view = await n1Of(chain);
      expect(view.status).toBe(status);
      if (exit) expect(view.n1).toMatchObject({ state: 'passed', exit });
      else expect(view.n1).not.toHaveProperty('exit');
    }
  });

  it('格 6 撤回后多人后加签：C 转交 X、X 与 D 都同意 → exit=approve；同组合 D 驳回 → 无 exit', async () => {
    const approved = await chainScene('f478-chain-6-approve', 'after', true);
    await step(approved, approved.c, 'transfer', { toUserId: approved.x });
    await step(approved, approved.x, 'approve');
    await step(approved, approved.d, 'approve');
    const done = await n1Of(approved);
    expect(done.status).toBe('running');
    expect(done.n1).toMatchObject({ state: 'passed', exit: 'approve' });

    const rejected = await chainScene('f478-chain-6-reject', 'after', true);
    await step(rejected, rejected.c, 'transfer', { toUserId: rejected.x });
    await step(rejected, rejected.x, 'approve');
    await step(rejected, rejected.d, 'reject');
    await expectNoExit(rejected, 'returned');
  });

  it('格 8 前加签 C、D：C 同意、D 待办时管理员跳转到 N3 → N1 无 exit（前加签链被截断）', async () => {
    const chain = await chainScene('f478-chain-8', 'before');
    await step(chain, chain.c, 'approve');
    const admin = await chain.s.w.member('流程管理员');
    const view = await chain.s.w.detail(chain.id);
    const jumped = await chain.s.w.instanceAction(admin, chain.id, 'admin-intervene', view.revision, {
      kind: 'jump',
      toNodeKey: 'n3',
      reason: '跳过',
    });
    expect(jumped.status, await jumped.clone().text()).toBe(200);
    expect((await chain.s.w.detail(chain.id)).currentNodeKey).toBe('n3');
    expect((await n1Of(chain)).n1).not.toHaveProperty('exit');
  });
});
