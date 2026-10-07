/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * 第 6 轮（DEC-288）：展示缓存与命令状态分离、结果未知沿用原幂等键、重读前只显示占位、
 * 表单按字段集合版本整体重建。用 React Profiler 在每次 commit 后快照整棵 DOM，断言已裁剪的字段名 / 值
 * 在收紧之后的任何一次提交里都不出现（含原样保留的旧节点）。
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement, act, Profiler } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const path = resolve('apps/web/src/approval/ApprovalPage.tsx');
const INSTANCE = '10000000-0000-4000-8000-000000000001';
const TASK = '20000000-0000-4000-8000-000000000002';
const RETRIEVE = '20000000-0000-4000-8000-000000000003';
const USER = '30000000-0000-4000-8000-00000000000a';
const DETAIL = `/api/tenant/approval/instances/${INSTANCE}`;
const FIELD = 'place';
const VALUE = '合成已撤权工作地点值';
const STALE_NOTICE = '数据已更新，请重试';

function editLog(fields: readonly string[]) {
  return { id: 'edit-event-1', event: 'edit', detail: { fields } };
}
function detail(overrides: Record<string, unknown> = {}) {
  return {
    id: INSTANCE,
    title: '合成字段集合版本申请',
    status: 'running',
    approvalType: 'transfer',
    revision: 7,
    currentNodeKey: 'manager',
    taskId: TASK,
    retrieveTaskId: RETRIEVE,
    round: 1,
    createdAt: '2026-10-07T12:34:56.000Z',
    tasks: [{ id: TASK, nodeName: '经理审批', status: 'pending' }],
    logs: [editLog([FIELD])],
    recordsHidden: false,
    form: { values: { place: VALUE, reason: '合成申请理由' }, editMode: 'none', editableFields: [] },
    actions: ['approve'],
    ...overrides,
  };
}
/** 撤销 place 查看权后的完整详情：表单无 place，同一编辑日志的字段名裁为空。 */
function trimmed(overrides: Record<string, unknown> = {}) {
  return detail({
    logs: [editLog([])],
    form: { values: { reason: '合成申请理由' }, editMode: 'none', editableFields: [] },
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
const unknownResult = () =>
  response({ error: { code: 'SERVICE_UNAVAILABLE', details: { reason: 'RESULT_UNKNOWN' } } }, 503);
const LOG_PAGE = { items: [editLog([FIELD])], page: 1, pageSize: 20 };
const HIDDEN_PAGE = { items: [], recordsHidden: true, page: 1, pageSize: 20 };

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let frames: string[];
let reads: number;
let writes: { url: string; options: RequestInit }[];
let histories: string[];
let onRead: (index: number) => Response | Promise<Response>;
let onWrite: (index: number) => Response | Promise<Response>;
let onHistory: (index: number) => Response | Promise<Response>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  frames = [];
  reads = 0;
  writes = [];
  histories = [];
  onRead = () => response(detail());
  onWrite = () => response(detail({ revision: 8, status: 'approved', actions: [] }));
  onHistory = () => response(LOG_PAGE);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, options: RequestInit = {}) => {
      const url = String(input);
      if (options.method === 'POST') {
        writes.push({ url, options });
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
async function mount() {
  const { ApprovalWorkspace } = await import(path);
  await act(async () =>
    root.render(
      createElement(
        Profiler,
        { id: 'approval', onRender: () => frames.push(host.textContent ?? '') },
        createElement(ApprovalWorkspace, { tenantId: 'synthetic', instanceId: INSTANCE }),
      ),
    ),
  );
  const editable = host.querySelector<HTMLInputElement>(`[aria-label="${FIELD}"]`);
  expect(editable?.value ?? panel().textContent).toContain(VALUE);
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
async function input(label: string, value: string) {
  const element = host.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    `[aria-label="${label}"]`,
  );
  expect(element, label).toBeTruthy();
  await act(async () => {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : element instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element!.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
/** 从 mark 起的每一次 commit 的整棵 DOM 都不得含有被禁内容。 */
function expectFramesClean(mark: number, ...words: string[]) {
  const since = frames.slice(mark);
  expect(since.length).toBeGreaterThan(0);
  for (const [index, frame] of since.entries())
    for (const word of words) expect(frame, `commit #${mark + index}`).not.toContain(word);
  for (const word of words) expect(host.textContent).not.toContain(word);
}
function expectPlaceholderOnly() {
  expect(panel()).not.toBeNull();
  expect(panel().querySelector('.approval-summary')).toBeNull();
  expect(panel().textContent).toContain('正在读取审批信息');
  expect(panel().textContent).not.toContain(FIELD);
  expect(panel().textContent).not.toContain(VALUE);
}
function header(call: { options: RequestInit }, name: string) {
  return new Headers(call.options.headers).get(name);
}

describe('DEC-288 ③ / ④：完整详情裁剪字段后，任何一次 DOM 提交都不保留旧字段名或旧值', () => {
  it('Profiler 基线：能看到正常挂载与分页行里的字段名（证明逐帧检查有区分力）', async () => {
    await mount();
    await click('查看日志历史');
    expect(frames.some((frame) => frame.includes(VALUE))).toBe(true);
    expect(frames.some((frame) => frame.includes(FIELD))).toBe(true);
  });

  it.each([{ via: 'GET 刷新' }, { via: 'POST 写响应' }])(
    '$via 返回裁剪后的完整详情：已加载的分页缓存与表单从新详情首次提交起就不再出现 place',
    async ({ via }) => {
      const pending = deferred();
      onRead = (index) => (index === 1 ? response(detail()) : pending.promise);
      onWrite = () => pending.promise;
      await mount();
      await click('查看日志历史');
      expect(panel().textContent).toContain(FIELD);
      if (via === 'POST 写响应') await click('同意');
      await click(via === 'GET 刷新' ? '刷新详情' : '确认提交');
      // 响应未到：旧内容仍是合法展示；从裁剪后的详情到达起，逐次提交都不得再含旧字段名或旧值。
      const mark = frames.length;
      await act(async () =>
        pending.finish(
          response(
            via === 'GET 刷新' ? trimmed({ revision: 8 }) : trimmed({ revision: 8, status: 'approved', actions: [] }),
          ),
        ),
      );
      expectFramesClean(mark, FIELD, VALUE);
      expect(panel().textContent).toContain('合成申请理由');
    },
  );

  it('同一条日志的字段名变少且 recordsHidden=false：视为收紧信号，清空后整页重读，旧表单值不再出现', async () => {
    const shrunk = deferred();
    const reread = deferred();
    onHistory = (index) => (index === 1 ? response(LOG_PAGE) : shrunk.promise);
    onRead = (index) => (index === 1 ? response(detail()) : reread.promise);
    await mount();
    await click('查看日志历史');
    expect(panel().textContent).toContain(FIELD);
    await click('查看日志历史');
    const mark = frames.length;
    await act(async () => shrunk.finish(response({ items: [editLog([])], page: 1, pageSize: 20 })));
    expectPlaceholderOnly();
    expect(reads).toBe(2);
    await act(async () => reread.finish(response(trimmed())));
    expectFramesClean(mark, FIELD, VALUE);
    expect(panel().textContent).toContain(STALE_NOTICE);
    expect(panel().textContent).toContain('合成申请理由');
  });

  it('字段集合版本变化时表单整体重建（草稿丢弃）；版本不变时草稿保留', async () => {
    const editable = (values: Record<string, unknown>) =>
      detail({ form: { values, editMode: 'separate', editableFields: ['place'] } });
    onRead = (index) =>
      index <= 2 ? response(editable({ place: VALUE, reason: '合成申请理由' })) : response(editable({ place: VALUE }));
    await mount();
    await input(FIELD, '合成未保存的草稿');
    await click('刷新详情');
    expect(host.querySelector<HTMLInputElement>(`[aria-label="${FIELD}"]`)?.value).toBe('合成未保存的草稿');
    // reason 被裁掉：字段集合版本变化，表单整体重建，place 的草稿随之丢弃。
    await click('刷新详情');
    expect(host.querySelector<HTMLInputElement>(`[aria-label="${FIELD}"]`)?.value).toBe(VALUE);
    expect(host.textContent).not.toContain('合成申请理由');
  });
});

const paths = [
  { action: 'approve', label: '同意', variant: '' },
  { action: 'approve', label: '同意', variant: 'with_approve' },
  { action: 'disagree', label: '不同意', variant: '' },
  { action: 'reject', label: '驳回到发起人', variant: '' },
  { action: 'transfer', label: '转交', variant: '' },
  { action: 'addSign', label: '加签', variant: '' },
  { action: 'cc', label: '抄送', variant: '' },
  { action: 'edit', label: '编辑', variant: '' },
  { action: 'retrieve', label: '撤回我的审批', variant: '' },
  { action: 'withdraw', label: '撤回申请', variant: '' },
  { action: 'urge', label: '催办', variant: '' },
  { action: 'resubmit', label: '重新提交', variant: '' },
  { action: 'adminTransfer', label: '管理员转交', variant: '' },
  { action: 'adminIntervene', label: '管理员干预', variant: '' },
  { action: 'adminIntervene', label: '管理员干预', variant: 'jump' },
];

describe('DEC-288 ① / ②：写结果未知 → 历史收紧 → 清空重读 → 原命令恢复（15 条写路径）', () => {
  it.each(paths)('$label $variant：重读后仍可用原幂等键重试，不发出第二个不同键的写请求', async (test) => {
    const editing = test.action === 'edit' || test.variant === 'with_approve';
    const base = detail({
      actions: [test.action],
      ...(editing
        ? {
            form: {
              values: { place: VALUE },
              editMode: test.action === 'edit' ? 'separate' : 'with_approve',
              editableFields: ['place'],
            },
          }
        : {}),
    });
    const write = deferred();
    const reread = deferred();
    onRead = (index) => (index === 1 ? response(base) : reread.promise);
    onWrite = (index) => (index === 1 ? write.promise : response(detail({ ...base, revision: 8, actions: [] })));
    onHistory = () => response(HIDDEN_PAGE);
    await mount();
    if (editing) await click(`清空 ${FIELD}`);
    await click(test.label);
    if (['approve', 'disagree', 'reject', 'transfer', 'addSign', 'cc'].includes(test.action))
      await input('审批意见', '合成意见');
    if (test.action === 'transfer') await input('接收人用户账号 ID', USER);
    if (['addSign', 'cc'].includes(test.action)) await input('用户账号 ID 列表', USER);
    if (['adminTransfer', 'adminIntervene'].includes(test.action)) {
      if (test.variant === 'jump') {
        await input('干预方式', 'jump');
        await input('目标节点 key', 'manager');
      } else {
        await input('任务 ID', TASK);
        await input('接收人用户账号 ID', USER);
      }
      await input('管理理由', '合成管理理由');
    }
    await click('确认提交');
    expect(writes).toHaveLength(1);
    await click('查看日志历史');
    expect(histories).toHaveLength(0);

    // 写结果未知：恢复层保存原命令并排队回查；排队的历史先返回隐藏 → 清空重读；回查随通道重置丢弃。
    await act(async () => write.finish(unknownResult()));
    expect(histories).toHaveLength(1);
    expectPlaceholderOnly();
    expect(reads).toBe(2);
    await act(async () => reread.finish(response({ ...base, logs: [], recordsHidden: true })));
    expect(panel().textContent).toContain('操作编号');
    await click('重试原命令');
    expect(writes).toHaveLength(2);
    expect(writes[1]!.url).toBe(writes[0]!.url);
    expect(writes[1]!.options.body).toEqual(writes[0]!.options.body);
    expect(header(writes[1]!, 'idempotency-key')).toBe(header(writes[0]!, 'idempotency-key'));
    expect(header(writes[1]!, 'if-match')).toBe(header(writes[0]!, 'if-match'));
    expect(buttons().some((button) => button.textContent === '重试原命令')).toBe(false);
    expect(panel().textContent).toContain('操作已完成');
  });
});
