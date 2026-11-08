/// <reference lib="dom" />
/**
 * AC-APV-F478-25（F-478 S5，设计 §4）页面 + 真实后端：审批详情页的 fetch 直接转发真实 createApp（PGlite / 真 PG 同库）。
 * - 通用流程节点按接口 exits 渲染“同意 / 不同意”，标签与接口 label 一致；提交请求体带所选 exit；
 * - 他人先办理（会签任一人同意，另一人已办）造成 409 时提示重读，等待与重读后都不自动重提；
 * - 路径条按接口 path 显示已经过 / 当前 / 不经过（及待办）。
 * 合成数据；租户数据读写都经 approvalWorld 的接口调用（DEC-568）。
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { useTestDb } from '@italent/testkit';
import { Window } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APV, approveCurrent, approveTo, otherwise, pendingOf, routeScene, when } from './AC-APV-F478-support.js';
import { publishRouted, type RouteScene } from './AC-APV-F478-support.js';
import { detailOf, type DetailWithExits } from './AC-APV-F478-s2-support.js';
import type { NodeInput } from './AC-APV-support.js';

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
// Node 自带 Event / EventTarget，页面事件须用 happy-dom 的实现。
Object.assign(globalThis, { window: domWindow, document: domWindow.document, Event: domWindow.Event });

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { ApprovalDetail } = await import(resolve('apps/web/src/approval/ApprovalDetail.tsx'));

const testDb = useTestDb();
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
  vi.unstubAllGlobals();
});

interface ApiCall {
  readonly method: string;
  readonly path: string;
  readonly body?: Record<string, unknown>;
  readonly status: number;
  readonly result: Record<string, unknown>;
}

/** 页面以 user 身份打开：fetch 转发到真实后端，保留命令 ID 与 If-Match。 */
function forward(s: RouteScene, user: string): ApiCall[] {
  const calls: ApiCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, options: RequestInit = {}) => {
      const url = new URL(input, 'http://localhost');
      const headers = new Headers(options.headers);
      expect(headers.get('x-tenant-id')).toBe(s.w.tenant.id);
      const method = options.method ?? 'GET';
      const body =
        options.body === undefined ? undefined : (JSON.parse(String(options.body)) as Record<string, unknown>);
      const response = await s.w.request(user, method, `${url.pathname}${url.search}`, {
        body,
        ifMatch: headers.get('if-match') ?? undefined,
        idempotencyKey: headers.get('idempotency-key') ?? undefined,
        headers: { origin: 'http://localhost' },
      });
      calls.push({ method, path: url.pathname, body, status: response.status, result: await response.clone().json() });
      return response;
    }),
  );
  return calls;
}

async function settleUntil(condition: () => boolean, message = () => host.textContent ?? '未渲染') {
  const deadline = Date.now() + 10_000;
  while (!condition() && Date.now() < deadline) {
    await act(async () => new Promise((done) => setTimeout(done, 10)));
  }
  expect(condition(), message()).toBe(true);
}
const wait = (ms: number) => act(async () => new Promise((done) => setTimeout(done, ms)));

async function openDetail(s: RouteScene, instanceId: string, taskId: string) {
  const session = {
    tenantId: s.w.tenant.id,
    identityKey: `synthetic-${taskId}`,
    tenantName: '合成租户',
    timezone: 'Asia/Shanghai',
    displayName: '合成审批人',
    source: 'server',
  };
  const row = { id: instanceId, title: '合成调动申请', approvalType: 'transfer', status: 'pending', taskId };
  const page = h(ApprovalDetail, { row, layout: 'page', todo: true, onClose() {}, onChanged() {} });
  await act(async () => root.render(h(SessionProvider, { session }, page)));
  await settleUntil(() => !!host.querySelector('.approval-progress'));
}

const squash = (text?: string | null) => text?.replace(/\s/g, '') ?? '';
const headButtons = () => [...host.querySelectorAll<HTMLButtonElement>('.approval-detail-head button')];
const headLabels = () => headButtons().map((node) => squash(node.textContent));
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const steps = () =>
  [...host.querySelectorAll('.approval-progress .ant-steps-item')].map((item) => [
    squash(item.querySelector('.ant-steps-item-title')?.textContent),
    squash(item.querySelector('.ant-steps-item-description')?.textContent),
  ]);
async function press(node: HTMLButtonElement | undefined | null, label: string) {
  expect(node, `按钮 ${label}`).toBeTruthy();
  expect(node!.disabled, `按钮 ${label} 可点`).toBe(false);
  await act(async () => node!.click());
}
const pressHead = (label: string) =>
  press(
    headButtons().find((node) => squash(node.textContent) === label),
    label,
  );
const saveButton = () =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => squash(node.textContent) === '保存');
async function saveDialog() {
  await settleUntil(() => !!saveButton() && !saveButton()!.disabled);
  await press(saveButton(), '保存');
}
const posts = (calls: ApiCall[]) => calls.filter((call) => call.method === 'POST');

/**
 * N1 单人（同意 / 不同意出口）→ 同意且部门 = D1 走 N3，否则走 N2；N3 会签任一人同意（审批人 n3、n4）。
 * 发起转入 D1：N1 当前、N2 不经过、N3 待办。
 */
async function scene(label: string) {
  const s = await routeScene(testDb().db, label);
  const [n1, n2, n3] = s.nodes({ n1: { exits: ['approve', 'disagree'] } });
  const joint: NodeInput = {
    ...n3!,
    kind: 'countersign',
    approver: undefined,
    approvers: [
      { type: 'specified', value: s.people.n3.userId },
      { type: 'specified', value: s.people.n4.userId },
    ],
    transitionRule: { type: 'any' },
  };
  await publishRouted(s.w, [n1!, n2!, joint], { n1: [approveTo(when(1, 'eq', s.depts.d1, 'n3'), otherwise('n2'))] });
  return { s, view: await s.start(s.depts.d1) };
}

describe('AC-APV-F478-25 办理页按接口 exits 渲染并提交 exit（真实后端）', () => {
  it('N1 审批人：按钮文案与接口 exits.label 一致，路径条当前 / 不经过 / 待办，点同意提交 exit 并推进到 N3', async () => {
    const { s, view } = await scene('f478-25-exits');
    const task = pendingOf(view)[0]!;
    const calls = forward(s, task.assigneeUserId);
    await openDetail(s, view.id, task.id);
    const read = calls.find((call) => call.method === 'GET' && call.path === `${APV}/instances/${view.id}`)!;
    const exits = read.result.exits as DetailWithExits['exits'];
    expect(exits.map((exit) => exit.code)).toEqual(['approve', 'disagree']);
    expect(headLabels().slice(1, 3)).toEqual(exits.map((exit) => exit.label));
    expect(steps()).toEqual([
      ['开始', ''],
      ['节点n1', '当前'],
      ['节点n2', '不经过'],
      ['节点n3', '待办'],
      ['结束', ''],
    ]);
    await pressHead(exits[0]!.label);
    await saveDialog();
    await settleUntil(() => posts(calls).length === 1 && posts(calls)[0]!.status !== 0);
    const [sent] = posts(calls);
    expect(sent!.path).toBe(`${APV}/tasks/${task.id}/approve`);
    expect(sent!.body).toMatchObject({ exit: 'approve' });
    expect(sent!.status, JSON.stringify(sent!.result)).toBe(200);
    const after = await detailOf(s.w, view.id, s.w.hr.id);
    expect(after.currentNodeKey).toBe('n3');
  });

  it('N1 已办后 N3 审批人打开：路径条显示已经过 / 不经过 / 当前', async () => {
    const { s, view } = await scene('f478-25-passed');
    const atJoint = await approveCurrent(s, view);
    const task = pendingOf(atJoint).find((item) => item.assigneeUserId === s.people.n3.userId)!;
    forward(s, task.assigneeUserId);
    await openDetail(s, view.id, task.id);
    expect(steps()).toEqual([
      ['开始', ''],
      ['节点n1', '已经过'],
      ['节点n2', '不经过'],
      ['节点n3', '当前'],
      ['结束', ''],
    ]);
  });
});

describe('AC-APV-F478-25 他人先办理造成 409：提示重读，不自动重提（真实后端）', () => {
  it('会签任一人同意：n4 打开页面后 n3 先同意；n4 提交得 409，提示重读，等待与重读后都只有一次 POST', async () => {
    const { s, view } = await scene('f478-25-race');
    const atJoint = await approveCurrent(s, view);
    const mine = pendingOf(atJoint).find((item) => item.assigneeUserId === s.people.n4.userId)!;
    const other = pendingOf(atJoint).find((item) => item.assigneeUserId === s.people.n3.userId)!;
    const calls = forward(s, mine.assigneeUserId);
    await openDetail(s, view.id, mine.id);
    const label = headLabels()[1]!;
    await pressHead(label);
    await settleUntil(() => !!dialog());
    // 另一名会签人先办理：节点按“任一人同意”结算，实例推进并换了 revision
    const first = await s.w.taskAction(other.assigneeUserId, other.id, 'approve', atJoint.revision, {
      comment: '先办',
    });
    expect(first.status, await first.clone().text()).toBe(200);
    await saveDialog();
    await settleUntil(() => posts(calls).length === 1);
    expect(posts(calls)[0]!.status).toBe(409);
    expect(posts(calls)[0]!.body).toMatchObject({ exit: 'approve' });
    await settleUntil(
      () => squash(dialog()?.textContent).includes('重读'),
      () => dialog()?.textContent ?? '无弹窗',
    );
    expect(document.body.textContent).not.toMatch(/REVISION_CONFLICT|APPROVAL_/);
    await wait(300);
    expect(posts(calls)).toHaveLength(1);
    const reread = [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
      squash(node.textContent).includes('重读'),
    );
    const gets = calls.filter((call) => call.method === 'GET').length;
    await press(reread, '重读');
    await settleUntil(() => calls.filter((call) => call.method === 'GET').length > gets);
    await wait(300);
    expect(posts(calls)).toHaveLength(1);
    // 重读后页面按最新详情：本人已没有可办理的出口，路径条显示已结束的路径
    await settleUntil(() => !headLabels().includes(label));
    expect(steps()).toEqual([
      ['开始', ''],
      ['节点n1', '已经过'],
      ['节点n2', '不经过'],
      ['节点n3', '已经过'],
      ['结束', ''],
    ]);
    expect((await detailOf(s.w, view.id, s.w.hr.id)).status).toBe('approved');
  });
});
