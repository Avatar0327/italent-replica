/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * AC-FE-F566（F-562 卡外遗留，DEC-954）审批动作弹窗：只显示内核 refused 带出的本次拒绝。
 * 登记冲突、而占槽命令在本页处理拒绝前已落定时，内核不带 race 也不带 refused（store.ts submitTo），
 * 弹窗里的 CommandStatus 不能残留“其他标签页有该对象未确认的命令”；真正的等锁超时（refused）仍显示 DEC-954 文案。
 * 挂真实审批详情（ApprovalDetail → FormOverlay → CommandStatus），每次 DOM 提交后记下页面文字，提交处理中
 * 内核短暂发布的 rejected 条目也不能把旧告警渲染出来。别的标签页 A 的登记做法同 AC-FE-F562。期望值手写。
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { holdLock, installWebLocks } from './support/web-locks.js';

installWebLocks();
const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act, Profiler } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { MemoryRouter } = requireWeb('react-router');
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { ApprovalDetail } = await import(resolve('apps/web/src/approval/ApprovalDetail.tsx'));

const RECORDS = 'italent.commands.pending:approval';
const INSTANCE = 'instance-566';
const TASK = 'task-566';
const DETAIL_PATH = `/api/tenant/approval/instances/${INSTANCE}`;
const APPROVE_PATH = `/api/tenant/approval/tasks/${TASK}/approve`;
const OTHER_TAB = '其他标签页有该对象未确认的命令，本次命令未发出；请等待结果或先查询结果。';
const LOCK_BUSY = '检测到你在另一个标签页打开了此单据，请关闭后重试。';
const LOCK_WAIT_MS = 3000;
const RESULT_FAILED = '已确认原命令未执行成功，输入已保留，请核对后重新提交。';
const UNCERTAIN = '结果尚未确认，请先回查记录，勿重复提交';
const COMMENT = '合成审批意见';

// 与 GET /api/tenant/approval/instances/:id 同形（disclosure.detailView）：本人当前可办理的离职审批，只有同意。
const detail = (revision: number) => ({
  id: INSTANCE,
  title: '合成员工的离职申请',
  status: 'in_review',
  approvalType: 'leave',
  revision,
  createdAt: '2026-11-20T01:00:00Z',
  actions: ['approve'],
  recordsHidden: false,
  form: { values: { effectiveDate: '2026-11-30', lastWorkDate: '2026-11-29', kind: 'leave' }, originals: {} },
  tasks: [{ id: TASK, nodeName: '部门负责人审批', status: 'pending', assigneeUserId: 'synthetic-user' }],
  logs: [{ event: 'start', actorUserId: 'u1', actorName: '合成发起人', createdAt: '2026-11-20T01:00:00Z' }],
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let posts: { key: string; body: unknown }[];
/** 每次 DOM 提交后的页面文字（含弹窗里的 CommandStatus），用来证明中途也没渲染过旧告警。 */
let commits: string[];
let tenantId: string;
const changed = vi.fn();

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  posts = [];
  commits = [];
  tenantId = randomUUID();
  changed.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const path = new URL(String(input), 'http://local').pathname;
      if (init.method === 'POST' && path === APPROVE_PATH) {
        posts.push({
          key: new Headers(init.headers).get('idempotency-key') ?? '',
          body: JSON.parse(String(init.body)),
        });
        // 动作回执是动作后的详情：实例不变、版本推进过 If-Match 6。
        return Response.json({ ...detail(7), status: 'approved', actions: [] });
      }
      if ((init.method ?? 'GET') === 'GET' && path === DETAIL_PATH) return Response.json(detail(6));
      // GET /api/tenant/commands/:commandId/result（F-120 审批真实投影：摘要三项为 null）：A 的命令已确认执行失败。
      if (path === '/api/tenant/commands/synthetic-command-a/result') {
        return Response.json({
          commandId: 'synthetic-command-a',
          status: 'failed',
          commandType: 'POST /api/tenant/approval/tasks/:id/approve',
          businessType: null,
          businessId: null,
          revision: null,
          httpStatus: 409,
          completedAt: '2026-11-25T08:00:00.000Z',
        });
      }
      return Response.json({ error: { code: 'NOT_FOUND', message: '合成' } }, { status: 404 });
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

/** Profiler 在每次提交的布局阶段回调（DOM 含弹窗 portal 已写完），读到的就是这次提交的页面。 */
const record = () => commits.push(document.body.textContent ?? '');
async function render() {
  const session = { tenantId, identityKey: 'synthetic-user', displayName: '合成用户', source: 'server' };
  const row = { id: INSTANCE, title: '合成员工的离职申请', approvalType: 'leave', status: 'in_review', taskId: TASK };
  await act(async () =>
    root.render(
      h(
        SessionProvider,
        { session },
        h(
          MemoryRouter,
          { initialEntries: ['/'] },
          h(
            Profiler,
            { id: 'approval-detail', onRender: record },
            h(ApprovalDetail, { row, layout: 'page', todo: true, onClose: () => undefined, onChanged: changed }),
          ),
        ),
      ),
    ),
  );
}
const buttonIn = (scope: ParentNode, label: string) =>
  Array.from(scope.querySelectorAll('button')).find(
    (item) => item.textContent?.replace(/\s/g, '') === label,
  ) as HTMLButtonElement;
const modal = () => document.querySelector('.ant-modal') as HTMLElement | null;
const comment = () => modal()?.querySelector('textarea') as HTMLTextAreaElement | null;
const save = () => buttonIn(modal()!.querySelector('.ant-modal-footer')!, '保存');
/** 打开“同意”弹窗并填写意见。 */
async function openApprove() {
  await act(async () => buttonIn(host, '同意').click());
  await act(async () => {
    const node = comment()!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(node, COMMENT);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
/** 点保存后等表单校验走完、本次登记已排在锁后。 */
async function clickSaveAndQueue(request: ReturnType<typeof vi.spyOn>) {
  await act(async () => save().click());
  await vi.waitFor(() => expect(request).toHaveBeenCalled());
}
/** 逐个时间片推进（每片都在 act 里刷新 DOM），直到条件成立；超过 2 秒按超时失败。 */
async function until(done: () => boolean) {
  for (let tick = 0; tick < 100 && !done(); tick += 1)
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
  expect(done()).toBe(true);
}
/** 等这次提交处理完（保存按钮不再处于加载中）。 */
const settled = () => until(() => !save().classList.contains('ant-btn-loading'));
const scoped = (name: string) => JSON.stringify([tenantId, 'synthetic-user', name]);
/** 别的标签页 A 在锁内登记同一审批单的命令（结果未知，占着本条目）。 */
const registerA = () =>
  localStorage.setItem(
    RECORDS,
    JSON.stringify([
      { key: scoped(DETAIL_PATH), slots: [scoped(DETAIL_PATH)], commandId: 'synthetic-command-a', revision: 6 },
    ]),
  );

describe('AC-FE-F566 审批动作登记冲突后占槽命令已落定', () => {
  it('B 登记被 A 的记录拒绝、处理拒绝前 A 已落定（内核不带 refused）：弹窗不残留其他标签页提示，可再提交', async () => {
    await render();
    await openApprove();
    const release = await holdLock(RECORDS); // A 持锁登记
    const request = navigator.locks.request.bind(navigator.locks);
    // 跨标签页交错：B 的登记读到 A 的记录被拒之后、B 处理这次拒绝之前，A 已收到回执并删掉记录。
    const spy = vi.spyOn(navigator.locks, 'request').mockImplementationOnce((...args: unknown[]) =>
      (request as (...rest: unknown[]) => Promise<unknown>)(...args).catch((cause: unknown) => {
        localStorage.removeItem(RECORDS);
        throw cause;
      }),
    );
    await clickSaveAndQueue(spy);
    const before = commits.length;
    registerA();
    release();
    await settled();
    expect(posts).toEqual([]);
    // 提交处理中每一次 DOM 提交都没出现过其他标签页告警（弹窗 CommandStatus 与表单提示区）。
    expect(commits.length).toBeGreaterThan(before);
    expect(commits.filter((page) => page.includes(OTHER_TAB))).toEqual([]);
    expect(document.body.textContent).not.toContain(OTHER_TAB);
    expect(document.body.textContent).not.toContain(UNCERTAIN);
    // 本次未发出：弹窗保留、输入保留、没有锁定。
    expect(comment()?.value).toBe(COMMENT);
    expect(save().disabled).toBe(false);
    expect(changed).not.toHaveBeenCalled();

    // 没有锁定的命令：再提交照常发出一次。
    await act(async () => save().click());
    await until(() => changed.mock.calls.length === 1);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({ comment: COMMENT });
    expect(document.body.textContent).not.toContain(OTHER_TAB);
  });
});

describe('AC-FE-F566 审批动作正例', () => {
  it('他页一直持锁、等锁超时（refused）：弹窗显示 DEC-954 文案，零请求、输入保留；他页关闭后可再提交', async () => {
    await render();
    await openApprove();
    const release = await holdLock(RECORDS);
    try {
      const spy = vi.spyOn(navigator.locks, 'request');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await clickSaveAndQueue(spy);
      await act(() => vi.advanceTimersByTimeAsync(LOCK_WAIT_MS));
      vi.useRealTimers();
      await settled();
    } catch (cause) {
      release();
      throw cause;
    }
    expect(posts).toEqual([]);
    expect(modal()?.textContent).toContain(LOCK_BUSY);
    expect(document.body.textContent).not.toContain(OTHER_TAB);
    expect(document.body.textContent).not.toContain(UNCERTAIN);
    expect(comment()?.value).toBe(COMMENT);
    expect(save().disabled).toBe(false);

    release();
    await act(async () => save().click());
    await until(() => changed.mock.calls.length === 1);
    expect(posts).toHaveLength(1);
  });

  it('A 未确认时 B 提交被竞争拒绝，主动查询结果确认失败：弹窗照常显示已确认失败的告警', async () => {
    await render();
    await openApprove();
    registerA();
    await act(async () => save().click());
    await until(() => !!buttonIn(modal()!, '查询结果'));
    expect(posts).toEqual([]);
    await act(async () => buttonIn(modal()!, '查询结果').click());
    await until(() => !!modal()?.textContent?.includes(RESULT_FAILED));
    expect(posts).toEqual([]);
  });

  it('单标签正常提交：发出一次、关闭弹窗，无提示、恢复记录已清', async () => {
    await render();
    await openApprove();
    await act(async () => save().click());
    await until(() => changed.mock.calls.length === 1);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({ comment: COMMENT });
    expect(modal()).toBeNull();
    expect(document.body.textContent).not.toContain(OTHER_TAB);
    expect(localStorage.getItem(RECORDS)).toBeNull();
  });
});
