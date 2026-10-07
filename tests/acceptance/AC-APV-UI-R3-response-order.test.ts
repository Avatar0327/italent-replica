/// <reference lib="dom" />
// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const path = resolve('apps/web/src/approval/ApprovalPage.tsx');
const INSTANCE = '10000000-0000-4000-8000-000000000001';
const TASK = '20000000-0000-4000-8000-000000000001';
const USER = '30000000-0000-4000-8000-00000000000a';
const DETAIL = `/api/tenant/approval/instances/${INSTANCE}`;
const SECRET = '合成已撤权工作地点';

function detail(overrides: Record<string, unknown> = {}) {
  return {
    id: INSTANCE,
    title: '合成响应交错申请',
    status: 'running',
    approvalType: 'transfer',
    revision: 7,
    currentNodeKey: 'manager',
    taskId: TASK,
    round: 1,
    createdAt: '2026-10-07T12:34:56.000Z',
    tasks: [{ id: TASK, nodeName: '经理审批', status: 'pending' }],
    logs: [],
    recordsHidden: false,
    form: { values: { place: SECRET, reason: '合成申请理由' }, editMode: 'none', editableFields: [] },
    actions: ['approve'],
    ...overrides,
  };
}
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}
function deferred() {
  let finish!: (value: Response) => void;
  const promise = new Promise<Response>((resolve) => (finish = resolve));
  return { promise, finish };
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let initial: ReturnType<typeof detail>;
let fresh: ReturnType<typeof detail>;
let oldRead: ReturnType<typeof deferred>;
let write: ReturnType<typeof deferred>;
let reads: number;
let writes: string[];

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  initial = detail();
  fresh = detail({ form: { values: { reason: '合成申请理由' }, editMode: 'none', editableFields: [] } });
  oldRead = deferred();
  write = deferred();
  reads = 0;
  writes = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, options: RequestInit = {}) => {
      const url = String(input);
      if (options.method === 'POST') {
        writes.push(url);
        return write.promise;
      }
      if (url === DETAIL) return ++reads === 1 ? response(initial) : oldRead.promise;
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
}
function panel() {
  return host.querySelector('.approval-detail')!;
}
async function click(label: string) {
  const button = Array.from(host.querySelectorAll('button')).find((item) => item.textContent?.trim() === label);
  expect(button, label).toBeTruthy();
  await act(async () => button!.click());
}
async function startWrite(label: string) {
  await click(label);
  if (label === '转交') {
    const input = host.querySelector<HTMLInputElement>('[aria-label="接收人用户账号 ID"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, USER);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  await click('确认提交');
  expect(writes).toHaveLength(1);
}

describe('AC-APV-UI-02 / AC-APV-UI-04 读写响应代次与撤权交错', () => {
  it.each([
    { action: 'transfer', label: '转交', path: `/tasks/${TASK}/transfer`, revision: 8 },
    { action: 'urge', label: '催办', path: `/instances/${INSTANCE}/urge`, revision: 7 },
  ])('$label 成功后丢弃更早刷新GET，撤权字段和旧节点记录不能恢复（revision=$revision）', async (test) => {
    initial = detail({ actions: [test.action] });
    await mount();
    await click('刷新详情');
    expect(reads).toBe(2);

    // 刷新已读取旧快照但延迟返回；撤权后的写响应只含当前可见字段。
    fresh = detail({
      revision: test.revision,
      actions: [],
      currentNodeKey: test.action === 'transfer' ? 'recipient' : 'manager',
      tasks: [{ id: TASK, nodeName: '经理审批', status: test.action === 'transfer' ? 'transferred' : 'pending' }],
      logs: [{ id: 'new-event', event: test.action, detail: { comment: '合成最新处理记录' } }],
      form: { values: { reason: '合成申请理由' }, editMode: 'none', editableFields: [] },
    });
    await startWrite(test.label);
    expect(writes[0]).toBe(`/api/tenant/approval${test.path}`);
    await act(async () => write.finish(response(fresh)));
    expect(panel().textContent).not.toContain(SECRET);
    expect(panel().textContent).toContain('合成最新处理记录');
    const accepted = panel().textContent;

    await act(async () => oldRead.finish(response(initial)));
    expect(panel().textContent).not.toContain(SECRET);
    expect(panel().textContent).toBe(accepted);
  });

  it('同意写响应已接受后，旧GET不能倒退状态、重新公布动作或覆盖新字段', async () => {
    await mount();
    await click('刷新详情');
    fresh = detail({
      status: 'approved',
      revision: 8,
      actions: [],
      tasks: [],
      form: { values: { reason: '合成审批后内容' }, editMode: 'none', editableFields: [] },
    });
    await startWrite('同意');
    await act(async () => write.finish(response(fresh)));
    expect(panel().querySelector('.approval-summary')?.textContent).toContain('已同意');
    expect(panel().textContent).toContain('合成审批后内容');

    await act(async () => oldRead.finish(response(initial)));
    expect(panel().querySelector('.approval-summary')?.textContent).toContain('已同意');
    expect(panel().querySelector('.approval-summary')?.textContent).not.toContain('审批中');
    expect(panel().textContent).toContain('合成审批后内容');
    expect(panel().textContent).not.toContain(SECRET);
    expect(Array.from(panel().querySelectorAll('button')).some((button) => button.textContent === '同意')).toBe(false);
  });

  it('写响应已接受后，旧GET的权限错误不能清掉当前详情或显示旧错误', async () => {
    await mount();
    await click('刷新详情');
    await startWrite('同意');
    await act(async () => write.finish(response(fresh)));
    await act(async () => oldRead.finish(response({ error: { code: 'FORBIDDEN' } }, 403)));
    expect(panel()).not.toBeNull();
    expect(panel().textContent).toContain('合成申请理由');
    expect(panel().textContent).not.toContain('无权访问');
    expect(panel().textContent).not.toContain(SECRET);
  });
});
