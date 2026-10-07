/// <reference lib="dom" />
// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const workspacePath = resolve('apps/web/src/approval/ApprovalPage.tsx');
const INSTANCE = '11000000-0000-4000-8000-000000000001';
const TASK = '22000000-0000-4000-8000-000000000001';
const API = '/api/tenant/approval';
const TIMEZONE = 'Asia/Shanghai';

function detail(overrides: Record<string, unknown> = {}) {
  return {
    id: INSTANCE,
    title: '合成审批显示用例',
    status: 'running',
    revision: 1,
    currentNodeKey: 'manager',
    taskId: TASK,
    retrieveTaskId: null,
    timezone: TIMEZONE,
    createdAt: '2026-10-07T12:34:56.000Z',
    completedAt: '2026-10-07T13:34:56.000Z',
    tasks: [{ id: TASK, status: 'approved', nodeName: '经理审批', actedAt: '2026-10-07T14:34:56.000Z' }],
    logs: [{ event: 'approve', detail: {}, createdAt: '2026-10-07T15:34:56.000Z' }],
    recordsHidden: false,
    commentNotice: '合成意见提示',
    form: { values: {}, editMode: 'none', editableFields: [] },
    addSignTypes: ['before', 'after'],
    actions: ['reject', 'addSign'],
    ...overrides,
  };
}
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let current: ReturnType<typeof detail>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  current = detail();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = String(input);
      const body =
        url === `${API}/instances/${INSTANCE}`
          ? current
          : url.includes('/logs?')
            ? { items: [{ event: 'transfer', detail: {}, createdAt: '2026-10-07T16:34:56.000Z' }] }
            : {
                timezone: TIMEZONE,
                items: [
                  { instanceId: INSTANCE, taskId: TASK, title: current.title, createdAt: '2026-10-07T12:34:56.000Z' },
                ],
              };
      return new Response(JSON.stringify(body));
    }),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function mount() {
  const { ApprovalWorkspace } = await import(workspacePath);
  await act(async () =>
    root.render(createElement(ApprovalWorkspace, { tenantId: 'synthetic-tenant', instanceId: INSTANCE })),
  );
  await vi.waitFor(() => expect(host.querySelector('.approval-detail h2')?.textContent).toBe(current.title));
}
async function click(label: string) {
  const button = Array.from(host.querySelectorAll('button')).find((item) => item.textContent?.trim() === label);
  expect(button, label).toBeTruthy();
  await act(async () => button!.click());
}
function signOptions() {
  return Array.from(host.querySelectorAll<HTMLSelectElement>('[aria-label="加签方式"] option')).map(
    (item) => item.value,
  );
}

describe('AC-APV-UI-02 / 03：租户时区、驳回文案与绑定节点加签类型', () => {
  it('列表、创建/完成、处理任务、当前日志与分页日志均使用接口租户时区', async () => {
    await mount();
    expect(host.querySelector('.approval-list time')?.textContent).toBe('2026-10-07 20:34:56 Asia/Shanghai');
    const times = Array.from(host.querySelectorAll('.approval-detail time')).map((item) => item.textContent);
    expect(host.querySelector('.approval-summary')?.textContent).toContain('2026-10-07 20:34:56 Asia/Shanghai');
    expect(host.querySelector('.approval-summary')?.textContent).toContain('2026-10-07 21:34:56 Asia/Shanghai');
    expect(times).toContain('2026-10-07 22:34:56 Asia/Shanghai');
    expect(times).toContain('2026-10-07 23:34:56 Asia/Shanghai');
    await click('查看日志历史');
    expect(host.querySelector('.approval-log time')?.textContent).toBe('2026-10-08 00:34:56 Asia/Shanghai');
  });
  it('租户采用有夏令时的时区时按事件日期换算，不能依赖浏览器时区', async () => {
    current = detail({ timezone: 'America/New_York', completedAt: '2026-12-07T12:34:56.000Z' });
    await mount();
    expect(host.querySelector('.approval-summary')?.textContent).toContain('2026-10-07 08:34:56 America/New_York');
    expect(host.querySelector('.approval-summary')?.textContent).toContain('2026-12-07 07:34:56 America/New_York');
  });
  it('驳回动作按钮使用原站文案 驳回到发起人', async () => {
    await mount();
    await click('驳回到发起人');
    expect(host.querySelector('legend')?.textContent).toBe('驳回到发起人');
  });
  it.each([
    { name: '单人节点', types: ['before', 'after'], expected: ['before', 'after'] },
    { name: '会签节点', types: ['before', 'parallel'], expected: ['before', 'parallel'] },
    { name: '旧响应缺少元数据', types: undefined, expected: ['before', 'after'] },
  ])('$name ：只显示服务端允许的加签类型', async ({ types, expected }) => {
    current = detail({ addSignTypes: types });
    await mount();
    await click('加签');
    expect(signOptions()).toEqual(expected);
  });
});
