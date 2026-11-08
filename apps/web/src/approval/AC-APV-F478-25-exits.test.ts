// @vitest-environment happy-dom
/**
 * AC-APV-F478-25 组件 / 命令层（F-478 S5，设计 §4）：办理按钮按接口 exits 渲染、标签取接口 label；
 * 提交带所选 exit；409 APPROVAL_EXIT_NOT_AVAILABLE / APPROVAL_EXIT_REQUIRED / APPROVAL_TASK_CLOSED 提示重新读取，
 * 不自动重提；路径条按 path[].state 显示四种状态，不在前端推算。
 * 夹具照后端 disclosure.detailView（exits = exitsView(actions)、path = pathView）与 approvalError 错误信封
 * （顶层 code CONFLICT，机器原因在 details.reason）。标签用合成文案，证明不是前端写死的“同意 / 不同意”。
 */
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../foundation/Session.js';
import { ApprovalDetail } from './ApprovalDetail.js';
import type { ApprovalDetail as Detail } from './types.js';

const INSTANCE = '70000000-0000-4000-8000-000000000478';
const TASK = '50000000-0000-4000-8000-000000000478';
const REFRESH_HINT = '办理状态已变化，请关闭操作框，点“重新读取”后按最新详情办理。';
type Post = { path: string; body: Record<string, unknown> };
type Reply = () => Response;

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let posts: Post[];
let gets: number;
let reply: Reply | undefined;
let current: Record<string, unknown>;

function fixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: INSTANCE,
    taskId: TASK,
    title: '合成员工的通用审批',
    revision: 5,
    status: 'running',
    approvalType: 'transfer',
    createdAt: '2026-11-02T01:00:00Z',
    actions: ['approve', 'disagree', 'reject'],
    exits: [
      { code: 'approve', label: '合成同意标签', family: 'approve' },
      { code: 'disagree', label: '合成不同意标签', family: 'disagree' },
    ],
    path: [
      { nodeKey: 'n1', name: '合成节点甲', state: 'passed', exit: 'approve' },
      { nodeKey: 'n2', name: '合成节点乙', state: 'current' },
      { nodeKey: 'n3', name: '合成节点丙', state: 'not_on_path' },
      { nodeKey: 'n4', name: '合成节点丁', state: 'pending' },
    ],
    recordsHidden: false,
    form: { values: { effectiveDate: '2026-11-10' }, originals: {} },
    tasks: [
      { id: 'task-0', nodeName: '合成节点甲', status: 'approved' },
      { id: TASK, nodeName: '合成节点乙', status: 'pending' },
    ],
    logs: [],
    ...overrides,
  };
}
const conflict =
  (reason: string, message: string, extra: Record<string, unknown> = {}) =>
  () =>
    Response.json({ error: { code: 'CONFLICT', message, details: { reason, ...extra } } }, { status: 409 });

async function render(detail: Record<string, unknown>) {
  current = detail;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        if (reply) return reply();
        return Response.json({ ...current, revision: Number(current.revision) + 1, actions: [], exits: [] });
      }
      gets += 1;
      return Response.json(String(path).includes('/logs?') ? { items: [], page: 1, pageSize: 20 } : current);
    }),
  );
  const row = {
    id: String(detail.id),
    title: String(detail.title),
    approvalType: 'transfer',
    status: 'pending',
    taskId: String(detail.taskId),
  };
  await act(async () => {
    root.render(
      h(SessionProvider, {
        session: {
          tenantId: 'synthetic-tenant',
          identityKey: 'synthetic-user',
          tenantName: '合成租户',
          timezone: 'Asia/Shanghai',
          displayName: '合成用户',
          source: 'server',
        },
        children: h(ApprovalDetail, { row: row as Detail, layout: 'page', onClose() {}, onChanged() {} }),
      }),
    );
  });
  await settle();
}
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 30)));
const squash = (text?: string | null) => text?.replace(/\s/g, '');
const headButtons = () => [...host.querySelectorAll<HTMLButtonElement>('.approval-detail-head button')];
const headLabels = () => headButtons().map((node) => squash(node.textContent));
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const anyButton = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => squash(node.textContent) === text);
async function click(node: HTMLButtonElement | undefined, label: string) {
  expect(node, `按钮 ${label}`).toBeDefined();
  await act(async () => node!.click());
  await settle();
}
const clickHead = (text: string) =>
  click(
    headButtons().find((node) => squash(node.textContent) === text),
    text,
  );
const save = () => click(anyButton('保存'), '保存');
const steps = () =>
  [...host.querySelectorAll('.approval-progress .ant-steps-item')].map((item) => ({
    title: squash(item.querySelector('.ant-steps-item-title')?.textContent),
    state: squash(item.querySelector('.ant-steps-item-description')?.textContent) || undefined,
    status: ['finish', 'process', 'wait', 'error'].find((s) => item.classList.contains(`ant-steps-item-${s}`)),
  }));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  posts = [];
  gets = 0;
  reply = undefined;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('AC-APV-F478-25 办理按钮按接口 exits 渲染', () => {
  it('同意 / 不同意按钮的文案取 exits.label，按 exits 顺序排在其他动作前；不出现写死的“同意 / 不同意”', async () => {
    await render(fixture());
    expect(headLabels().slice(0, 4)).toEqual(['返回', '合成同意标签', '合成不同意标签', '驳回']);
    expect(headLabels()).not.toContain('同意');
    expect(headLabels()).not.toContain('不同意');
  });

  it('点接口给的同意出口：弹窗标题用接口标签，提交 POST /approve 且请求体带 exit', async () => {
    await render(fixture());
    await clickHead('合成同意标签');
    expect(dialog()?.textContent).toContain('合成同意标签');
    await save();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.path).toBe(`/api/tenant/approval/tasks/${TASK}/approve`);
    expect(posts[0]!.body).toMatchObject({ exit: 'approve' });
  });

  it('点接口给的不同意出口：提交 POST /disagree 且请求体带 exit: disagree', async () => {
    await render(fixture());
    await clickHead('合成不同意标签');
    await save();
    expect(posts.map(({ path, body }) => [path.split('/').at(-1), body.exit])).toEqual([['disagree', 'disagree']]);
  });

  it('只公布了不同意出口：只渲染不同意一个按钮', async () => {
    await render(
      fixture({
        actions: ['disagree'],
        exits: [{ code: 'disagree', label: '合成不同意标签', family: 'disagree' }],
      }),
    );
    expect(headLabels()).toContain('合成不同意标签');
    expect(headLabels()).not.toContain('合成同意标签');
    expect(headLabels()).not.toContain('同意');
  });

  it('旧形状（详情没有 exits）按 actions 兜底：按钮“同意 / 不同意”，请求体不带 exit', async () => {
    const { exits: _exits, path: _path, ...legacy } = fixture();
    await render(legacy);
    expect(headLabels().slice(0, 3)).toEqual(['返回', '同意', '不同意']);
    await clickHead('同意');
    await save();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).not.toHaveProperty('exit');
  });
});

describe('AC-APV-F478-25 409 提示重新读取，不自动重提', () => {
  for (const [reason, message] of [
    ['APPROVAL_EXIT_NOT_AVAILABLE', '本节点没有该出口'],
    ['APPROVAL_EXIT_REQUIRED', '本节点须选择出口'],
    ['APPROVAL_TASK_CLOSED', '该任务已处理或流程已结束'],
  ] as const) {
    it(`409 ${reason}：弹窗提示重新读取，页面不显示原因码，等待后仍只有一次请求`, async () => {
      reply = conflict(reason, message, reason === 'APPROVAL_EXIT_NOT_AVAILABLE' ? { exit: 'approve' } : {});
      await render(fixture());
      await clickHead('合成同意标签');
      await save();
      await settle();
      await settle();
      expect(posts).toHaveLength(1);
      expect(dialog()?.textContent).toContain(REFRESH_HINT);
      expect(document.body.textContent).not.toContain(reason);
    });
  }

  it('旧形状下同意结果未知（槽里无 exit），重读后详情带 exits：同意出口按钮仍可打开核对，不发第二次请求', async () => {
    // 审批命令槽按实例 / 任务存在模块级 store：本条留下结果未知的槽，换一组编号不影响其他用例
    const ids = { id: '70000000-0000-4000-8000-000000000479', taskId: '50000000-0000-4000-8000-000000000479' };
    const { exits: _exits, path: _path, ...legacy } = fixture(ids);
    reply = () => Response.json({ error: { code: 'UNAVAILABLE', message: '合成服务暂不可用' } }, { status: 503 });
    await render(legacy);
    await clickHead('同意');
    await save();
    expect(posts).toHaveLength(1);
    await click(anyButton('取消'), '取消');
    current = fixture(ids);
    await clickHead('重新读取');
    const approve = headButtons().find((node) => squash(node.textContent) === '合成同意标签');
    expect(approve?.disabled).toBe(false);
    expect(headButtons().find((node) => squash(node.textContent) === '合成不同意标签')?.disabled).toBe(true);
    expect(posts).toHaveLength(1);
  });

  it('409 后点“重新读取”：出口已不在最新详情里，再点保存不发第二次请求', async () => {
    reply = conflict('APPROVAL_EXIT_NOT_AVAILABLE', '本节点没有该出口', { exit: 'approve' });
    await render(fixture());
    await clickHead('合成同意标签');
    await save();
    expect(posts).toHaveLength(1);
    const before = gets;
    current = fixture({
      revision: 6,
      actions: ['disagree'],
      exits: [{ code: 'disagree', label: '合成不同意标签', family: 'disagree' }],
    });
    await click(anyButton('重新读取'), '重新读取');
    expect(gets).toBeGreaterThan(before);
    expect(headLabels()).not.toContain('合成同意标签');
    await save();
    expect(posts).toHaveLength(1);
  });
});

describe('AC-APV-F478-25 路径条按 path[].state 显示', () => {
  it('四种 state 依次显示已经过 / 当前 / 不经过 / 待办；节点名取接口；不再显示“后续节点需流程预测”的缺口说明', async () => {
    await render(fixture());
    expect(steps()).toEqual([
      { title: '开始', state: undefined, status: 'finish' },
      { title: '合成节点甲', state: '已经过', status: 'finish' },
      { title: '合成节点乙', state: '当前', status: 'process' },
      { title: '合成节点丙', state: '不经过', status: 'wait' },
      { title: '合成节点丁', state: '待办', status: 'wait' },
      { title: '结束', state: undefined, status: 'wait' },
    ]);
    expect(host.querySelector('.approval-path-skipped .ant-steps-item-title')?.textContent).toBe('合成节点丙');
    expect(host.textContent).not.toContain('后续节点需流程预测接口');
  });

  it('不在前端推算：任务里没有的节点、与任务顺序不同的节点都按 path 原样显示', async () => {
    await render(
      fixture({
        tasks: [],
        path: [
          { nodeKey: 'n1', name: '合成节点甲', state: 'current' },
          { nodeKey: 'n2', name: '合成节点乙', state: 'not_on_path' },
          { nodeKey: 'n3', name: '合成节点丙', state: 'pending' },
        ],
      }),
    );
    expect(steps().map(({ title, state }) => [title, state])).toEqual([
      ['开始', undefined],
      ['合成节点甲', '当前'],
      ['合成节点乙', '不经过'],
      ['合成节点丙', '待办'],
      ['结束', undefined],
    ]);
  });

  it('path 为空（审批记录对本人隐藏）或没有 path：沿用按已产生任务的进度条', async () => {
    await render(fixture({ path: [], recordsHidden: true }));
    expect(steps().map(({ title }) => title)).toEqual(['开始', '合成节点甲', '合成节点乙', '结束']);
    expect(steps().every(({ state }) => state === undefined)).toBe(true);
  });
});
