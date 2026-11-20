/// <reference lib="dom" />
/**
 * AC-FE-F110-14（F-110 第 2 轮返工 P2-1）审批详情页 + 真实后端：审批动作在命令台账里存的是 { instanceId }
 * （approval/actions.ts ok()），F-120 摘要只取响应体的 id / revision / kind（command-result/service.ts summaryOf），
 * 所以审批命令查到的 businessId / businessType / revision 三项都是 null。
 * 命令 ID 匹配的 succeeded 不要求摘要带这些字段：按槽内原实例读回详情并核对（实例一致、版本推进过本次提交）后解锁。
 * 回执丢失用“后端已执行、页面收到 503”模拟；期望值手写；租户数据读写都经接口（DEC-568）。
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { useTestDb } from '@italent/testkit';
import { Window } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { approvalWorld, transferScene } from './AC-APV-support.js';
import { installWebLocks } from './support/web-locks.js';

// F-110 第 3 轮：调动 / 审批命令登记恢复记录须拿跨标签页锁，测试环境装一份 Web Locks。
installWebLocks();

// API / PGlite 保留 Node 的 URL、Request、Response、fetch；antd 渲染所需的其余 DOM 全局取自 happy-dom，只补 Node 没有的。
const domWindow = new Window({ url: 'http://localhost' });
for (const key of Object.getOwnPropertyNames(domWindow)) {
  if (key in globalThis) continue;
  const value = (domWindow as unknown as Record<string, unknown>)[key];
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: typeof value === 'function' && /^[a-z]/.test(key) ? value.bind(domWindow) : value,
  });
}
// Node 自带 Event / EventTarget，页面事件须用 happy-dom 的实现；Node 26 的 Web Storage 未配置时为 undefined，改用 happy-dom 的。
Object.assign(globalThis, { window: domWindow, document: domWindow.document, Event: domWindow.Event });
for (const key of ['localStorage', 'sessionStorage'] as const)
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: domWindow[key] });

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { ApprovalDetail } = await import(resolve('apps/web/src/approval/ApprovalDetail.tsx'));

const testDb = useTestDb();
const BASE = '/api/tenant/approval';
const LOCKED = '本单有未确认的“同意”操作，请打开核对结果；确认前不能发起其他操作。';
const UNKNOWN = '处理中 / 结果待确认。当前表单已锁定，请勿重新创建命令。';
// 核对不通过（回执无效）时内核保持只读，页面显示读取失败提示。
const READ_FAILED = '读取失败，输入已保留，请重新读取。';
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  sessionStorage.clear();
  localStorage.clear();
  vi.unstubAllGlobals();
});

interface Call {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly result: unknown;
}
type World = Awaited<ReturnType<typeof approvalWorld>>;
type Reply = (path: string, init: RequestInit) => Response | undefined;

/** 页面以 user 身份打开，fetch 转发真实后端；同意的回执丢失：后端照常执行，页面收到 503。 */
function forward(w: World, user: string, override?: Reply): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, options: RequestInit = {}) => {
      const url = new URL(input, 'http://localhost');
      const replaced = override?.(url.pathname, options);
      if (replaced) return replaced;
      const headers = new Headers(options.headers);
      const method = options.method ?? 'GET';
      const response = await w.request(user, method, `${url.pathname}${url.search}`, {
        body: options.body === undefined ? undefined : (JSON.parse(String(options.body)) as Record<string, unknown>),
        ifMatch: headers.get('if-match') ?? undefined,
        idempotencyKey: headers.get('idempotency-key') ?? undefined,
        headers: { origin: 'http://localhost' },
      });
      calls.push({ method, path: url.pathname, status: response.status, result: await response.clone().json() });
      if (method === 'POST' && url.pathname.endsWith('/approve'))
        return Response.json({ error: { code: 'UNAVAILABLE', message: '合成服务暂不可用' } }, { status: 503 });
      return response;
    }),
  );
  return calls;
}

async function settleUntil(condition: () => boolean, message = () => document.body.textContent ?? '未渲染') {
  const deadline = Date.now() + 10_000;
  while (!condition() && Date.now() < deadline) {
    await act(async () => new Promise((done) => setTimeout(done, 10)));
  }
  expect(condition(), message()).toBe(true);
}
const squash = (text?: string | null) => text?.replace(/\s/g, '') ?? '';
const button = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((node) => squash(node.textContent) === label);
async function press(label: string) {
  await settleUntil(
    () => !!button(label) && !button(label)!.disabled,
    () => `按钮 ${label}：${document.body.textContent}`,
  );
  await act(async () => button(label)!.click());
}
const text = () => document.body.textContent ?? '';

async function scene(label: string) {
  const w = await approvalWorld(testDb().db, label);
  const s = await transferScene(w);
  await w.publishedProcess({
    nodes: [
      { key: 'out_head', approver: { type: 'department', value: 'latest_record_department_head' } },
      { key: 'in_head', approver: { type: 'department', value: 'record_department_head' } },
    ],
  });
  const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
  return { w, s, view, task: w.pending(view)[0]! };
}

async function openDetail(w: World, instanceId: string, taskId: string) {
  const session = {
    tenantId: w.tenant.id,
    identityKey: `synthetic-${randomUUID()}`,
    tenantName: '合成租户',
    timezone: 'Asia/Shanghai',
    displayName: '合成审批人',
    source: 'server',
  };
  const row = { id: instanceId, title: '合成调动申请', approvalType: 'transfer', status: 'pending', taskId };
  const page = h(ApprovalDetail, { row, layout: 'page', todo: true, onClose() {}, onChanged() {} });
  await act(async () => root.render(h(SessionProvider, { session }, page)));
  await settleUntil(() => !!button('同意'));
}

/** 点同意保存 → 回执丢失（结果未知）→ 关闭弹窗，详情页给出锁定提示与“查询结果”。 */
async function approveUnknown(w: World, instanceId: string, taskId: string) {
  await openDetail(w, instanceId, taskId);
  await press('同意');
  await press('保存');
  await settleUntil(() => text().includes(UNKNOWN));
  await press('取消');
  await settleUntil(() => text().includes(LOCKED) && !!button('查询结果'));
}

describe('AC-FE-F110-14 审批查询结果：F-120 摘要三项为 null 时按原实例读回核对', () => {
  it('后端已同意、回执丢失：查到的摘要三项为 null；按原实例读回版本已推进即解锁，不提示读取失败，不再发写入', async () => {
    const { w, s, view, task } = await scene('f110-14-null');
    const calls = forward(w, s.outHead.userId);
    await approveUnknown(w, view.id, task.id);
    const approve = calls.filter((call) => call.method === 'POST');
    expect(approve.map((call) => [call.path, call.status])).toEqual([[`${BASE}/tasks/${task.id}/approve`, 200]]);

    await press('查询结果');
    await settleUntil(() => calls.some((call) => call.path.startsWith('/api/tenant/commands/')));
    const result = calls.find((call) => call.path.startsWith('/api/tenant/commands/'))!;
    expect(result.status).toBe(200);
    expect(result.result).toEqual({
      commandId: expect.any(String),
      status: 'succeeded',
      commandType: 'POST /api/tenant/approval/tasks/:id/approve',
      businessType: null,
      businessId: null,
      revision: null,
      httpStatus: 200,
      completedAt: expect.any(String),
    });
    await settleUntil(
      () => !text().includes(LOCKED),
      () => `仍锁定：${text()}`,
    );
    expect(text()).not.toContain(READ_FAILED);
    expect(button('查询结果')).toBeUndefined();
    expect(sessionStorage.length + localStorage.length).toBe(0);
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('succeeded 但原实例读回的版本未推进过本次提交：仍锁定，提示读取失败', async () => {
    const { w, s, view, task } = await scene('f110-14-stale');
    const calls = forward(w, s.outHead.userId);
    await approveUnknown(w, view.id, task.id);
    // 读回的仍是提交时的详情（版本没推进）：不能据此确认成功。
    const before = calls.find((call) => call.method === 'GET' && call.path === `${BASE}/instances/${view.id}`)!.result;
    forward(w, s.outHead.userId, (path) =>
      path === `${BASE}/instances/${view.id}` ? Response.json(before) : undefined,
    );
    await press('查询结果');
    await settleUntil(() => text().includes(READ_FAILED));
    expect(text()).toContain(LOCKED);
  });

  it('succeeded 摘要带了别的实例 ID：仍锁定，提示读取失败（有值就核对，不因可缺省放过串号）', async () => {
    const { w, s, view, task } = await scene('f110-14-foreign');
    forward(w, s.outHead.userId);
    await approveUnknown(w, view.id, task.id);
    forward(w, s.outHead.userId, (path) => {
      if (!path.startsWith('/api/tenant/commands/')) return undefined;
      return Response.json({
        commandId: decodeURIComponent(path.split('/').at(-2)!),
        status: 'succeeded',
        commandType: 'POST /api/tenant/approval/tasks/:id/approve',
        businessType: null,
        businessId: randomUUID(),
        revision: null,
        httpStatus: 200,
        completedAt: '2026-11-20T01:02:03.000Z',
      });
    });
    await press('查询结果');
    await settleUntil(() => text().includes(READ_FAILED));
    expect(text()).toContain(LOCKED);
  });
});
