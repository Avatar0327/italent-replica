/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * 第 4 轮（Astra 第 3 轮 P2）：历史接口返回 recordsHidden 收紧披露后，更早发出的详情 GET 与写响应
 * 都不得把审批意见与历史恢复出来（DEC-115 / DEC-057；AC-APV-UI-02 / 04）。
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
let onRead: (index: number) => Response | Promise<Response>;
let onWrite: (index: number) => Response | Promise<Response>;
let onHistory: () => Response | Promise<Response>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  reads = 0;
  writes = [];
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
      if (/\/(tasks|logs)\?/.test(url)) return onHistory();
      return response({ items: [], page: 1, pageSize: 20 });
    }),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
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
function expectHidden() {
  expect(panel().textContent).toContain(HIDDEN_NOTICE);
  expect(panel().textContent).not.toContain(SECRET);
  expect(buttons().some((button) => /查看(任务|日志)历史/.test(button.textContent ?? ''))).toBe(false);
}
const histories = [
  { kind: 'tasks', label: '查看任务历史' },
  { kind: 'logs', label: '查看日志历史' },
];

describe('AC-APV-UI-02 / AC-APV-UI-04 历史接口收紧披露后，迟到的详情与写响应不得恢复历史', () => {
  it.each(histories)('$kind 分页返回隐藏后，更早发出的刷新 GET 迟到也不能恢复意见与历史', async ({ label }) => {
    const oldRead = deferred();
    onRead = (index) => (index === 1 ? response(detail()) : oldRead.promise);
    await mount();
    await click('刷新详情');
    expect(reads).toBe(2);
    await click(label);
    expectHidden();
    const hidden = panel().textContent;

    await act(async () => oldRead.finish(response(detail())));
    expectHidden();
    expect(panel().textContent).toBe(hidden);
  });

  it.each(histories)('$kind 分页返回隐藏后，更早发出的转交 POST 迟到也不能恢复意见与历史', async ({ label }) => {
    const write = deferred();
    const recheck = deferred();
    onWrite = () => write.promise;
    onRead = (index) => (index === 1 ? response(detail()) : recheck.promise);
    await mount();
    await startTransfer();
    await click(label);
    expectHidden();

    // 转交在服务端早于“进入隐藏节点”处理，响应仍带全部历史；迟到到达时不得放宽披露。
    await act(async () => write.finish(response(detail({ revision: 8, actions: [], currentNodeKey: 'recipient' }))));
    expectHidden();
    expect(panel().textContent).toContain('操作已完成');
    // 写响应作废后重新读取当前状态，由服务端裁决；结果仍隐藏。
    expect(reads).toBe(2);
    await act(async () =>
      recheck.finish(response(hiddenDetail({ revision: 8, actions: [], currentNodeKey: 'recipient' }))),
    );
    expectHidden();
    expect(panel().textContent).not.toContain('审批中 · recipient');
  });

  it('刷新详情已采用后，更早发出的历史分页 GET 迟到返回 403 不得清单', async () => {
    const oldHistory = deferred();
    onHistory = () => oldHistory.promise;
    await mount();
    await click('查看日志历史');
    await click('刷新详情');
    expect(reads).toBe(2);
    expect(panel().textContent).toContain(SECRET);

    await act(async () => oldHistory.finish(response({ error: { code: 'FORBIDDEN' } }, 403)));
    expect(host.querySelector('.approval-detail')).not.toBeNull();
    expect(panel().textContent).toContain(SECRET);
    expect(panel().textContent).not.toContain('无权访问');
  });

  it('重放原命令成功后，更早发出的回查 GET 迟到返回 403 不得清掉已成功的详情（P3）', async () => {
    const staleRecheck = deferred();
    const retry = deferred();
    onWrite = (index) =>
      index === 1
        ? response({ error: { code: 'INTERNAL', details: { reason: 'RESULT_UNKNOWN' } } }, 503)
        : retry.promise;
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
    expect(writes).toHaveLength(2);
    await act(async () =>
      retry.finish(
        response(detail({ status: 'approved', revision: 8, actions: [], taskId: null, tasks: [], logs: [] })),
      ),
    );
    expect(panel().querySelector('.approval-summary')?.textContent).toContain('已同意');

    await act(async () => staleRecheck.finish(response({ error: { code: 'FORBIDDEN' } }, 403)));
    expect(host.querySelector('.approval-detail')).not.toBeNull();
    expect(panel().querySelector('.approval-summary')?.textContent).toContain('已同意');
    expect(panel().textContent).not.toContain('无权访问');
  });
});
