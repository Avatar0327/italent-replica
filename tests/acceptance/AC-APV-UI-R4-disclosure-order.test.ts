/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * 第 4 轮（Astra 第 3 轮 P2）历史隐藏交错用例，第 5 轮按 DEC-277 改为串行语义：
 * 详情 / 写请求在途时历史排队；历史返回 recordsHidden 或 403 即为收紧信号，先清空再整页重读，
 * 更早的详情或写响应因串行不可能在其后到达（DEC-115 / DEC-057；AC-APV-UI-02 / 04）。
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const path = resolve('apps/web/src/approval/ApprovalPage.tsx');
const INSTANCE = '10000000-0000-4000-8000-000000000001';
const DONE_TASK = '20000000-0000-4000-8000-000000000001';
const TASK = '20000000-0000-4000-8000-000000000002';
const USER = '30000000-0000-4000-8000-00000000000a';
const DETAIL = `/api/tenant/approval/instances/${INSTANCE}`;
const SECRET = '合成应被隐藏的历史意见';
const HIDDEN_NOTICE = '审批记录已隐藏';
const STALE_NOTICE = '数据已更新，请重试';

function detail(overrides: Record<string, unknown> = {}) {
  return {
    id: INSTANCE,
    title: '合成披露收紧申请',
    status: 'running',
    approvalType: 'transfer',
    revision: 7,
    currentNodeKey: 'hidden',
    taskId: TASK,
    round: 1,
    createdAt: '2026-10-07T12:34:56.000Z',
    tasks: [
      { id: DONE_TASK, nodeName: '经理审批', status: 'approved', comment: SECRET, actedAt: '2026-10-07T13:00:00Z' },
      { id: TASK, nodeName: '隐藏节点', status: 'pending' },
    ],
    logs: [{ id: 'approve-event', event: 'approve', detail: { comment: SECRET } }],
    recordsHidden: false,
    form: { values: { reason: '合成申请理由' }, editMode: 'none', editableFields: [] },
    actions: ['transfer'],
    ...overrides,
  };
}
function hiddenDetail(overrides: Record<string, unknown> = {}) {
  return detail({
    tasks: [{ id: TASK, nodeName: '隐藏节点', status: 'pending' }],
    logs: [],
    recordsHidden: true,
    ...overrides,
  });
}
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}
function deferred() {
  let finish!: (value: Response) => void;
  const promise = new Promise<Response>((resolve) => (finish = resolve));
  return { promise, finish };
}
const HIDDEN_PAGE = { items: [], recordsHidden: true, page: 1, pageSize: 20 };

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let reads: number;
let writes: string[];
let histories: string[];
let onRead: (index: number) => Response | Promise<Response>;
let onWrite: (index: number) => Response | Promise<Response>;
let onHistory: (index: number) => Response | Promise<Response>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  reads = 0;
  writes = [];
  histories = [];
  onRead = () => response(detail());
  onWrite = () => response(detail());
  onHistory = () => response(HIDDEN_PAGE);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, options: RequestInit = {}) => {
      const url = String(input);
      if (options.method === 'POST') {
        writes.push(url);
        return onWrite(writes.length);
      }
      if (url === DETAIL) return onRead(++reads);
      if (/\/(tasks|logs)\?/.test(url)) {
        histories.push(url);
        return onHistory(histories.length);
      }
      return response({ items: [], page: 1, pageSize: 20 });
    }),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
function watch(word: string) {
  let leaked = false;
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => {
        if (node.textContent?.includes(word)) leaked = true;
      });
      if (record.type === 'characterData' && record.target.textContent?.includes(word)) leaked = true;
    }
  });
  observer.observe(host, { childList: true, subtree: true, characterData: true });
  return {
    expectClean() {
      expect(leaked).toBe(false);
      expect(host.textContent).not.toContain(word);
    },
  };
}
async function mount() {
  const { ApprovalWorkspace } = await import(path);
  await act(async () => root.render(createElement(ApprovalWorkspace, { tenantId: 'synthetic', instanceId: INSTANCE })));
  expect(panel().textContent).toContain(SECRET);
  expect(panel().textContent).not.toContain(HIDDEN_NOTICE);
}
function panel() {
  return host.querySelector('.approval-detail')!;
}
function buttons() {
  return Array.from(host.querySelectorAll('button'));
}
async function click(label: string) {
  const button = buttons().find((item) => item.textContent?.trim() === label);
  expect(button, label).toBeTruthy();
  await act(async () => button!.click());
}
async function startTransfer() {
  await click('转交');
  const input = host.querySelector<HTMLInputElement>('[aria-label="接收人用户账号 ID"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, USER);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('确认提交');
  expect(writes).toHaveLength(1);
}
function expectCleared() {
  expect(panel()).not.toBeNull();
  expect(panel().querySelector('.approval-summary')).toBeNull();
  expect(panel().textContent).not.toContain(SECRET);
}
function expectHidden() {
  expect(panel().textContent).toContain(HIDDEN_NOTICE);
  expect(panel().textContent).not.toContain(SECRET);
  expect(buttons().some((button) => /查看(任务|日志)历史/.test(button.textContent ?? ''))).toBe(false);
}
const histories_ = [
  { kind: 'tasks', label: '查看任务历史' },
  { kind: 'logs', label: '查看日志历史' },
];

describe('AC-APV-UI-02 / AC-APV-UI-04 历史接口收紧披露：串行、清空与整页重读', () => {
  it.each(histories_)(
    '$kind：刷新 GET 在途时历史排队；GET 返回后历史发出并返回隐藏，随即清空并整页重读',
    async ({ label }) => {
      const oldRead = deferred();
      const reread = deferred();
      onRead = (index) => (index === 2 ? oldRead.promise : index === 3 ? reread.promise : response(detail()));
      await mount();
      await click('刷新详情');
      expect(reads).toBe(2);
      await click(label);
      expect(histories).toHaveLength(0);

      await act(async () => oldRead.finish(response(detail())));
      expect(histories).toHaveLength(1);
      expectCleared();
      expect(reads).toBe(3);
      const guard = watch(SECRET);
      await act(async () => reread.finish(response(hiddenDetail())));
      expectHidden();
      guard.expectClean();
    },
  );

  it.each(histories_)(
    '$kind：转交 POST 在途时历史排队；写响应整体采用后历史返回隐藏，随即清空并整页重读',
    async ({ label }) => {
      const write = deferred();
      const reread = deferred();
      onWrite = () => write.promise;
      onRead = (index) => (index === 2 ? reread.promise : response(detail()));
      await mount();
      await startTransfer();
      await click(label);
      expect(histories).toHaveLength(0);

      await act(async () => write.finish(response(detail({ revision: 8, actions: [], currentNodeKey: 'recipient' }))));
      expect(histories).toHaveLength(1);
      expectCleared();
      expect(reads).toBe(2);
      const guard = watch(SECRET);
      await act(async () =>
        reread.finish(response(hiddenDetail({ revision: 8, actions: [], currentNodeKey: 'recipient' }))),
      );
      expectHidden();
      expect(panel().textContent).toContain('recipient');
      guard.expectClean();
    },
  );

  it('历史分页 403 是收紧信号：清空并整页重读；排队的手动刷新丢弃，重读成功后显示最新详情与提示', async () => {
    const history = deferred();
    onHistory = () => history.promise;
    onRead = (index) => (index === 1 ? response(detail()) : response(hiddenDetail()));
    await mount();
    await click('查看日志历史');
    await click('刷新详情');
    expect(reads).toBe(1);
    const guard = watch(SECRET);
    await act(async () => history.finish(response({ error: { code: 'FORBIDDEN' } }, 403)));
    expect(reads).toBe(2);
    expectHidden();
    expect(panel().textContent).toContain(STALE_NOTICE);
    expect(panel().textContent).not.toContain('无权访问');
    guard.expectClean();
  });

  it('回查 GET 返回 403 时按当前证据清单关闭，排队的重试原命令不再发出（原 P3 场景的串行形态）', async () => {
    const staleRecheck = deferred();
    onWrite = () => response({ error: { code: 'INTERNAL', details: { reason: 'RESULT_UNKNOWN' } } }, 503);
    onRead = (index) => (index <= 2 ? response(detail({ actions: ['approve'] })) : staleRecheck.promise);
    await mount();
    await click('同意');
    await click('确认提交');
    expect(writes).toHaveLength(1);
    expect(panel().textContent).toContain('操作结果待确认');
    expect(reads).toBe(2);
    await click('重新回查');
    expect(reads).toBe(3);
    await click('重试原命令');
    expect(writes).toHaveLength(1);
    await act(async () => staleRecheck.finish(response({ error: { code: 'FORBIDDEN' } }, 403)));
    expect(host.querySelector('.approval-detail')).toBeNull();
    expect(host.textContent).toContain('无权访问');
    expect(writes).toHaveLength(1);
  });
});
