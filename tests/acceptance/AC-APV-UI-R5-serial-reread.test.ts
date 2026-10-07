/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * 第 5 轮（DEC-277 结构性简化）：同一实例的读写请求串行执行；任何收紧信号（字段消失、recordsHidden、403）
 * 先清空已展示数据再整页重读；重读失败保持清空并提示“数据已更新，请重试”。
 * 每个用例用 MutationObserver 监视 DOM，断言撤权字段与应隐藏的历史在收紧后的任何渲染帧都不出现。
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
const DETAIL = `/api/tenant/approval/instances/${INSTANCE}`;
const FIELD = '合成已撤权工作地点';
const COMMENT = '合成应被隐藏的历史意见';
const HIDDEN_NOTICE = '审批记录已隐藏';
const STALE_NOTICE = '数据已更新，请重试';

function detail(overrides: Record<string, unknown> = {}) {
  return {
    id: INSTANCE,
    title: '合成串行重读申请',
    status: 'running',
    approvalType: 'transfer',
    revision: 7,
    currentNodeKey: 'hidden',
    taskId: TASK,
    round: 1,
    createdAt: '2026-10-07T12:34:56.000Z',
    tasks: [
      { id: DONE_TASK, nodeName: '经理审批', status: 'approved', comment: COMMENT, actedAt: '2026-10-07T13:00:00Z' },
      { id: TASK, nodeName: '隐藏节点', status: 'pending' },
    ],
    logs: [{ id: 'approve-event', event: 'approve', detail: { comment: COMMENT } }],
    recordsHidden: false,
    form: { values: { place: FIELD, reason: '合成申请理由' }, editMode: 'none', editableFields: [] },
    actions: ['approve'],
    ...overrides,
  };
}
/** 撤销 place 查看权并推进状态后的完整详情（服务端裁剪后的真实形态）。 */
function trimmed(overrides: Record<string, unknown> = {}) {
  return detail({
    status: 'approved',
    revision: 8,
    actions: [],
    taskId: null,
    form: { values: { reason: '合成申请理由' }, editMode: 'none', editableFields: [] },
    ...overrides,
  });
}
function hiddenDetail(overrides: Record<string, unknown> = {}) {
  return detail({
    tasks: [{ id: TASK, nodeName: '隐藏节点', status: 'pending' }],
    logs: [],
    recordsHidden: true,
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
const forbidden = () => response({ error: { code: 'FORBIDDEN', message: '合成不得外泄的拒绝原因' } }, 403);
const unavailable = () => response({ error: { code: 'SERVICE_UNAVAILABLE', message: '合成服务暂不可用' } }, 503);
const PAGES: Record<string, unknown> = {
  tasks: { items: [{ id: DONE_TASK, nodeName: '经理审批', status: 'approved', comment: COMMENT }], page: 1 },
  logs: { items: [{ id: 'approve-event', event: 'approve', detail: { comment: COMMENT } }], page: 1 },
};
const HIDDEN_PAGE = { items: [], recordsHidden: true, page: 1, pageSize: 20 };

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let reads: number;
let writes: string[];
let histories: string[];
let lists: number;
let onRead: (index: number) => Response | Promise<Response>;
let onWrite: (index: number) => Response | Promise<Response>;
let onHistory: (index: number) => Response | Promise<Response>;
let onList: (index: number) => Response | Promise<Response>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  reads = 0;
  writes = [];
  histories = [];
  lists = 0;
  onRead = () => response(detail());
  onWrite = () => response(trimmed());
  onHistory = () => response(PAGES.tasks);
  onList = () => response({ items: [], page: 1, pageSize: 20 });
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
      return onList(++lists);
    }),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

/** 监视 DOM：收紧后任何一次插入或文本变更都不得带出被禁内容（含中间渲染帧）。 */
function watch(...words: string[]) {
  const leaked = new Set<string>();
  const check = (text: string | null) => {
    for (const word of words) if (text?.includes(word)) leaked.add(word);
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => check(node.textContent));
      if (record.type === 'characterData') check(record.target.textContent);
    }
  });
  observer.observe(host, { childList: true, subtree: true, characterData: true });
  return {
    expectClean() {
      expect([...leaked]).toEqual([]);
      for (const word of words) expect(host.textContent).not.toContain(word);
    },
    leaked,
    stop: () => observer.disconnect(),
  };
}
async function mount() {
  const { ApprovalWorkspace } = await import(path);
  await act(async () => root.render(createElement(ApprovalWorkspace, { tenantId: 'synthetic', instanceId: INSTANCE })));
  expect(panel().textContent).toContain(FIELD);
  expect(panel().textContent).toContain(COMMENT);
}
function panel() {
  return host.querySelector('.approval-detail')!;
}
function summary() {
  return panel()?.querySelector('.approval-summary')?.textContent ?? '';
}
function buttons() {
  return Array.from(host.querySelectorAll('button'));
}
async function click(label: string) {
  const button = buttons().find((item) => item.textContent?.trim() === label);
  expect(button, label).toBeTruthy();
  await act(async () => button!.click());
}
/** 已清空：详情面板仍在，但没有任何单据内容，只有提示与重试 / 关闭按钮。 */
function expectCleared() {
  expect(panel()).not.toBeNull();
  expect(panel().querySelector('.approval-summary')).toBeNull();
  expect(panel().textContent).not.toContain(FIELD);
  expect(panel().textContent).not.toContain(COMMENT);
  expect(panel().textContent).not.toContain('合成申请理由');
}
const kinds = [
  { kind: 'tasks', label: '查看任务历史' },
  { kind: 'logs', label: '查看日志历史' },
];

describe('DEC-277 ①：同一实例读写串行，迟到的旧响应丢弃', () => {
  it('监视器基线：正常挂载时能看到字段与意见（证明监视器有区分力）', async () => {
    const guard = watch(FIELD, COMMENT);
    await mount();
    expect([...guard.leaked].sort()).toEqual([COMMENT, FIELD].sort());
    guard.stop();
  });

  it.each(
    kinds.flatMap(({ kind, label }) => [
      { kind, label, outcome: '普通成功' },
      { kind, label, outcome: 'recordsHidden' },
      { kind, label, outcome: '503' },
    ]),
  )('$kind 历史（$outcome）：详情刷新在途时历史排队不发出；裁剪详情先采用，撤权字段此后不再出现', async (test) => {
    const pendingRead = deferred();
    const history = deferred();
    const reread = deferred();
    onRead = (index) => (index === 2 ? pendingRead.promise : index === 3 ? reread.promise : response(detail()));
    onHistory = () => history.promise;
    await mount();
    await click('刷新详情');
    expect(reads).toBe(2);
    await click(test.label);
    // 串行：详情在途，历史只能排队。
    expect(histories).toHaveLength(0);

    const guard = watch(FIELD);
    await act(async () => pendingRead.finish(response(trimmed())));
    expect(summary()).toContain('已同意');
    expect(panel().textContent).not.toContain(FIELD);
    expect(histories).toHaveLength(1);
    await act(async () =>
      history.finish(
        test.outcome === '普通成功'
          ? response(PAGES[test.kind])
          : test.outcome === 'recordsHidden'
            ? response(HIDDEN_PAGE)
            : unavailable(),
      ),
    );
    if (test.outcome === '普通成功') {
      expect(panel().textContent).toContain('第 1 页');
      expect(summary()).toContain('已同意');
      expect(reads).toBe(2);
    } else if (test.outcome === '503') {
      expect(panel().textContent).toContain('合成服务暂不可用');
      expect(summary()).toContain('已同意');
      expect(reads).toBe(2);
    } else {
      // 收紧信号：先清空再整页重读；重读在途期间没有任何单据内容。
      expectCleared();
      expect(reads).toBe(3);
      const comments = watch(COMMENT);
      await act(async () => reread.finish(response(hiddenDetail({ status: 'approved', revision: 8, actions: [] }))));
      expect(panel().textContent).toContain(HIDDEN_NOTICE);
      expect(summary()).toContain('已同意');
      comments.expectClean();
    }
    guard.expectClean();
  });

  it('写请求在途时历史排队；写响应先整体采用，历史返回隐藏后清空并整页重读', async () => {
    const write = deferred();
    const history = deferred();
    const reread = deferred();
    onWrite = () => write.promise;
    onHistory = () => history.promise;
    onRead = (index) => (index === 2 ? reread.promise : response(detail()));
    await mount();
    await click('同意');
    await click('确认提交');
    expect(writes).toHaveLength(1);
    await click('查看日志历史');
    expect(histories).toHaveLength(0);
    await act(async () =>
      write.finish(response(detail({ revision: 8, status: 'approved', actions: [], taskId: null }))),
    );
    expect(summary()).toContain('已同意');
    expect(histories).toHaveLength(1);
    await act(async () => history.finish(response(HIDDEN_PAGE)));
    expectCleared();
    expect(reads).toBe(2);
    const guard = watch(COMMENT);
    await act(async () => reread.finish(response(hiddenDetail({ revision: 8, status: 'approved', actions: [] }))));
    expect(panel().textContent).toContain(HIDDEN_NOTICE);
    expect(summary()).toContain('已同意');
    guard.expectClean();
  });

  it('列表 403 清空工作区后，在途的详情响应迟到也不回填', async () => {
    const pendingRead = deferred();
    onRead = (index) => (index === 2 ? pendingRead.promise : response(detail()));
    await mount();
    await click('刷新详情');
    onList = () => forbidden();
    await click('刷新');
    expect(host.textContent).toContain('无权访问');
    const guard = watch(FIELD, COMMENT, '合成串行重读申请');
    await act(async () => pendingRead.finish(response(detail())));
    guard.expectClean();
    expect(host.querySelector('.approval-detail')).toBeNull();
  });
});

describe('DEC-277 ② / ③：收紧信号先清空再整页重读，重读失败保持清空', () => {
  it.each(
    kinds.flatMap(({ kind, label }) => [
      { kind, label, signal: 'recordsHidden' },
      { kind, label, signal: '403' },
    ]),
  )('$kind 历史先发、详情后发排队；历史返回 $signal 即清空，重读 503 时保持清空并提示重试', async (test) => {
    const history = deferred();
    const reread = deferred();
    onHistory = () => history.promise;
    onRead = (index) => (index === 2 ? reread.promise : response(detail()));
    await mount();
    await click(test.label);
    expect(histories).toHaveLength(1);
    await click('刷新详情');
    expect(reads).toBe(1);

    const guard = watch(FIELD, COMMENT);
    await act(async () => history.finish(test.signal === '403' ? forbidden() : response(HIDDEN_PAGE)));
    expectCleared();
    expect(panel().textContent).not.toContain('合成不得外泄的拒绝原因');
    // 排队中的手动刷新已随通道重置丢弃，只有一次整页重读。
    expect(reads).toBe(2);
    await act(async () => reread.finish(unavailable()));
    expectCleared();
    expect(panel().textContent).toContain(STALE_NOTICE);
    expect(reads).toBe(2);
    guard.expectClean();

    onRead = () => response(hiddenDetail());
    await click('刷新详情');
    expect(reads).toBe(3);
    expect(panel().textContent).toContain(HIDDEN_NOTICE);
    expect(panel().textContent).not.toContain(STALE_NOTICE);
    guard.expectClean();
  });

  it.each([{ signal: 'recordsHidden' }, { signal: '403' }])(
    '连续两次刷新：前次返回 $signal 后，后次失败不能回退显示旧数据',
    async ({ signal }) => {
      const first = deferred();
      onRead = (index) => (index === 2 ? first.promise : index === 3 ? unavailable() : response(detail()));
      await mount();
      await click('刷新详情');
      await click('刷新详情');
      expect(reads).toBe(2);
      const guard = watch(FIELD, COMMENT);
      await act(async () => first.finish(signal === '403' ? forbidden() : response(hiddenDetail({ revision: 8 }))));
      if (signal === '403') {
        // 完整详情读取被拒：按当前证据清单关闭，排队的第二次刷新随之丢弃。
        expect(host.querySelector('.approval-detail')).toBeNull();
        expect(host.textContent).toContain('无权访问');
        expect(reads).toBe(2);
      } else {
        expect(reads).toBe(3);
        expect(panel().textContent).toContain(HIDDEN_NOTICE);
        expect(panel().textContent).toContain('合成服务暂不可用');
      }
      guard.expectClean();
    },
  );

  it('写请求 403 是收紧信号：清空草稿并整页重读，重读成功后显示最新详情与提示', async () => {
    onWrite = () => forbidden();
    onRead = (index) => (index === 1 ? response(detail()) : response(trimmed({ status: 'running', actions: [] })));
    await mount();
    await click('同意');
    const input = host.querySelector<HTMLTextAreaElement>('[aria-label="审批意见"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '合成未提交草稿');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const guard = watch(FIELD);
    await click('确认提交');
    expect(writes).toHaveLength(1);
    expect(reads).toBe(2);
    expect(panel().textContent).toContain(STALE_NOTICE);
    expect(panel().textContent).toContain('合成申请理由');
    expect(host.querySelector('[aria-label="审批意见"]')).toBeNull();
    expect(panel().textContent).not.toContain('合成未提交草稿');
    expect(panel().textContent).not.toContain('合成不得外泄的拒绝原因');
    guard.expectClean();
  });
});
