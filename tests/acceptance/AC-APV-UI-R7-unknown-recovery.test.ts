/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * 第 7 轮（DEC-288 止损）组件层：客户端每个读写请求都回传最后看到的披露版本；收到 409 + DISCLOSURE_TIGHTENED
 * 立即清空详情 / 历史 / 表单并整页刷新；刷新前把结果未知 / 已发出的命令（URL、载荷、幂等键、revision）存入
 * sessionStorage，刷新后按原键先回查再重试。15 条写路径参数化覆盖“写结果未知 → 回查收到收紧 → 刷新 → 原键恢复”
 * 与“写响应直接收紧 → 刷新 → 原键恢复”。
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
const VERSION = 'x-disclosure-version';
const FIELD = 'place';
const VALUE = '合成已撤权工作地点值';

function detail(overrides: Record<string, unknown> = {}) {
  return {
    id: INSTANCE,
    title: '合成披露版本申请',
    status: 'running',
    approvalType: 'transfer',
    revision: 7,
    currentNodeKey: 'manager',
    taskId: TASK,
    retrieveTaskId: RETRIEVE,
    round: 1,
    createdAt: '2026-10-07T12:34:56.000Z',
    tasks: [{ id: TASK, nodeName: '经理审批', status: 'pending' }],
    logs: [{ id: 'edit-event-1', event: 'edit', detail: { fields: [FIELD] } }],
    recordsHidden: false,
    disclosureVersion: 'v1',
    form: { values: { place: VALUE, reason: '合成申请理由' }, editMode: 'none', editableFields: [] },
    actions: ['approve'],
    ...overrides,
  };
}
/** 整棵 DOM 的快照：文本内容 + 所有输入控件的当前值（可编辑字段的值只在 value 里）。 */
function snapshot(): string {
  const values = Array.from(host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')).map(
    (element) => element.value,
  );
  return `${host.textContent ?? ''}\u0000${values.join('\u0000')}`;
}
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}
/** 延迟交付的响应：在点击之后另起 act 交付，确保 409 的帧标记落在点击本身引起的提交之后。 */
function deferred() {
  let finish!: (value: Response) => void;
  const promise = new Promise<Response>((resolve) => (finish = resolve));
  return { promise, finish };
}
const tightened = () =>
  response(
    { error: { code: 'CONFLICT', message: '可见范围已收紧', details: { reason: 'DISCLOSURE_TIGHTENED' } } },
    409,
  );
const unknownResult = () =>
  response({ error: { code: 'SERVICE_UNAVAILABLE', details: { reason: 'RESULT_UNKNOWN' } } }, 503);
const LOG_PAGE = { items: [{ id: 'edit-event-1', event: 'edit', detail: { fields: [FIELD] } }], page: 1, pageSize: 20 };

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let frames: string[];
let reads: { url: string; options: RequestInit }[];
let writes: { url: string; options: RequestInit }[];
let histories: { url: string; options: RequestInit }[];
let onRead: (index: number) => Response | Promise<Response>;
let onWrite: (index: number) => Response | Promise<Response>;
let onHistory: (index: number) => Response | Promise<Response>;
let reload: ReturnType<typeof vi.fn<() => void>>;
let mark: number;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  sessionStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  frames = [];
  reads = [];
  writes = [];
  histories = [];
  reload = vi.fn<() => void>();
  mark = -1;
  onRead = () => response(detail());
  onWrite = () => response(detail({ revision: 8, status: 'approved', actions: [], disclosureVersion: 'v3' }));
  onHistory = () => response({ ...LOG_PAGE, disclosureVersion: 'v2' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, options: RequestInit = {}) => {
      const url = String(input);
      let result: Response;
      if (options.method === 'POST') {
        writes.push({ url, options });
        result = await onWrite(writes.length);
      } else if (url === DETAIL) {
        reads.push({ url, options });
        result = await onRead(reads.length);
      } else if (/\/(tasks|logs)\?/.test(url)) {
        histories.push({ url, options });
        result = await onHistory(histories.length);
      } else return response({ items: [], page: 1, pageSize: 20 });
      // 409 交付前记下帧序号：此后每一次 DOM 提交都不得再出现旧字段名 / 旧值。
      if (result.status === 409) mark = frames.length;
      return result;
    }),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function mount(instanceId: string | null = INSTANCE) {
  const { ApprovalWorkspace } = await import(path);
  await act(async () =>
    root.render(
      createElement(
        Profiler,
        { id: 'approval', onRender: () => frames.push(snapshot()) },
        createElement(ApprovalWorkspace, { tenantId: 'synthetic', ...(instanceId ? { instanceId } : {}), reload }),
      ),
    ),
  );
}
async function remount(instanceId: string | null) {
  await act(async () => root.unmount());
  host.remove();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await mount(instanceId);
}
function panel() {
  return host.querySelector('.approval-detail')!;
}
function buttons() {
  return Array.from(host.querySelectorAll('button'));
}
async function click(label: string) {
  // 列表区与历史区都有“上一页 / 下一页”：优先点可用的那一个。
  const matches = buttons().filter((item) => item.textContent?.trim() === label);
  const button = matches.find((item) => !item.disabled) ?? matches[0];
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
function header(call: { options: RequestInit }, name: string) {
  return new Headers(call.options.headers).get(name);
}
/** 收到 409 之后：每一帧都不含旧字段名 / 旧值，面板只剩占位，整页刷新恰好一次。 */
function expectClearedAndReloaded() {
  expect(mark).toBeGreaterThanOrEqual(0);
  const since = frames.slice(mark);
  expect(since.length).toBeGreaterThan(0);
  for (const [index, frame] of since.entries())
    for (const word of [FIELD, VALUE]) expect(frame, `commit #${mark + index}`).not.toContain(word);
  expect(panel().querySelector('.approval-summary')).toBeNull();
  expect(panel().querySelector('.approval-history')).toBeNull();
  expect(snapshot()).not.toContain(FIELD);
  expect(snapshot()).not.toContain(VALUE);
  expect(reload).toHaveBeenCalledTimes(1);
}
function expectStored(write: { url: string; options: RequestInit }) {
  expect(sessionStorage.length).toBe(1);
  const stored = sessionStorage.getItem(sessionStorage.key(0)!)!;
  for (const piece of [
    header(write, 'idempotency-key')!,
    write.url.replace('/api/tenant/approval', ''),
    '"revision":7',
  ])
    expect(stored).toContain(piece);
  expect(stored).toContain(JSON.stringify(JSON.parse(String(write.options.body))));
}

describe('DEC-288 止损 ②：每个读写请求回传最后看到的披露版本', () => {
  it('首载不带版本；详情 → 历史页 → 写响应依次更新回传的版本；放宽（版本变化但未收紧）不触发刷新', async () => {
    await mount();
    expect(header(reads[0]!, VERSION)).toBeNull();
    await click('查看日志历史');
    expect(header(histories[0]!, VERSION)).toBe('v1');
    await click('查看任务历史');
    expect(header(histories[1]!, VERSION)).toBe('v2');
    await click('同意');
    await input('审批意见', '合成意见');
    await click('确认提交');
    expect(header(writes[0]!, VERSION)).toBe('v2');
    await click('刷新详情');
    expect(header(reads[1]!, VERSION)).toBe('v3');
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(0);
  });

  it('排队的请求按发出时（而非排队时）最后看到的版本回传', async () => {
    let finish!: (value: Response) => void;
    onRead = (index) => (index === 1 ? response(detail()) : new Promise<Response>((resolve) => (finish = resolve)));
    await mount();
    await click('刷新详情');
    await click('查看日志历史');
    expect(histories).toHaveLength(0);
    await act(async () => finish(response(detail({ disclosureVersion: 'v9' }))));
    expect(histories).toHaveLength(1);
    expect(header(histories[0]!, VERSION)).toBe('v9');
  });
});

describe('DEC-288 止损 ④：收到 DISCLOSURE_TIGHTENED 立即清空并整页刷新', () => {
  it('完整详情 GET 返回 409 原因码：清空详情 / 历史 / 表单，整页刷新一次，不发出重读', async () => {
    const refresh = deferred();
    onRead = (index) => (index === 1 ? response(detail()) : refresh.promise);
    await mount();
    await click('查看日志历史');
    expect(panel().textContent).toContain(FIELD);
    await click('刷新详情');
    await act(async () => refresh.finish(tightened()));
    expectClearedAndReloaded();
    expect(reads).toHaveLength(2);
    expect(sessionStorage.length).toBe(0);
  });

  it('历史分页返回 409 原因码：清空并整页刷新；排队中的请求不再发出', async () => {
    const page = deferred();
    onHistory = () => page.promise;
    await mount();
    await click('查看日志历史');
    await click('刷新详情');
    expect(reads).toHaveLength(1);
    await act(async () => page.finish(tightened()));
    expectClearedAndReloaded();
    expect(histories).toHaveLength(1);
    expect(reads).toHaveLength(1);
  });

  it('普通 revision 409 不是收紧信号：不刷新、按既有冲突流程回查', async () => {
    onWrite = () => response({ error: { code: 'REVISION_CONFLICT', message: '已变更' } }, 409);
    await mount();
    await click('同意');
    await input('审批意见', '合成意见');
    await click('确认提交');
    expect(reload).not.toHaveBeenCalled();
    expect(reads).toHaveLength(2);
    expect(panel().textContent).toContain('单据已变化');
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
function baseFor(test: (typeof paths)[number]) {
  const editing = test.action === 'edit' || test.variant === 'with_approve';
  return detail({
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
}
async function fillAndSubmit(test: (typeof paths)[number]) {
  if (test.action === 'edit' || test.variant === 'with_approve') await click(`清空 ${FIELD}`);
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
}
/** 刷新（重新挂载，不带实例深链）后：按暂存命令回到原单，先回查（无版本头）再以原键重试。 */
async function expectRecoveredByOriginalKey(base: ReturnType<typeof detail>) {
  onRead = () =>
    response({
      ...base,
      logs: [],
      recordsHidden: true,
      disclosureVersion: 'v5',
      form: { ...base.form, values: { reason: '合成申请理由' } },
    });
  onWrite = () => response(detail({ ...base, revision: 8, actions: [], disclosureVersion: 'v6' }));
  await remount(null);
  expect(reads).toHaveLength(1);
  expect(header(reads[0]!, VERSION)).toBeNull();
  expect(panel().textContent).toContain('操作编号');
  expect(panel().textContent).toContain(header(writes[0]!, 'idempotency-key')!);
  await click('重试原命令');
  expect(writes).toHaveLength(2);
  expect(writes[1]!.url).toBe(writes[0]!.url);
  expect(writes[1]!.options.body).toEqual(writes[0]!.options.body);
  expect(header(writes[1]!, 'idempotency-key')).toBe(header(writes[0]!, 'idempotency-key'));
  expect(header(writes[1]!, 'if-match')).toBe(header(writes[0]!, 'if-match'));
  expect(header(writes[1]!, VERSION)).toBe('v5');
  expect(buttons().some((button) => button.textContent === '重试原命令')).toBe(false);
  expect(panel().textContent).toContain('操作已完成');
  expect(sessionStorage.length).toBe(0);
}

describe('DEC-288 止损 ④：写结果未知 → 回查收到收紧 → 刷新 → 按原键恢复（15 条写路径）', () => {
  it.each(paths)('$label $variant：结果未知的命令存入 sessionStorage，刷新后原键重试', async (test) => {
    const base = baseFor(test);
    const recheck = deferred();
    onRead = (index) => (index === 1 ? response(base) : recheck.promise);
    onWrite = () => unknownResult();
    await mount();
    await fillAndSubmit(test);
    expect(reads).toHaveLength(2);
    await act(async () => recheck.finish(tightened()));
    expectClearedAndReloaded();
    expect(reads).toHaveLength(2);
    expect(header(reads[1]!, VERSION)).toBe('v1');
    expectStored(writes[0]!);
    reads = [];
    reload.mockClear();
    await expectRecoveredByOriginalKey(base);
  });
});

describe('DEC-288 止损 ④：写响应直接收紧 → 刷新 → 按原键恢复（15 条写路径，已执行的写不重复执行）', () => {
  it.each(paths)('$label $variant：已发出的命令存入 sessionStorage，刷新后原键重试', async (test) => {
    const base = baseFor(test);
    const write = deferred();
    onRead = () => response(base);
    onWrite = () => write.promise;
    await mount();
    await fillAndSubmit(test);
    expect(header(writes[0]!, VERSION)).toBe('v1');
    await act(async () => write.finish(tightened()));
    expectClearedAndReloaded();
    expect(reads).toHaveLength(1);
    expectStored(writes[0]!);
    reads = [];
    reload.mockClear();
    await expectRecoveredByOriginalKey(base);
  });
});
