/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * AC-FE-F568（F-566 卡外遗留）合同行内催办按内核 outcome 区分提示：
 * - 命令在登记阶段就没发出（DEC-954 等锁超时、DEC-955 不支持锁）：显示内核 refused 的真实原因，零写请求；
 * - 别页已登记同一流程实例（race）：显示竞争原因，零写请求；登记冲突但占槽命令已落定（无 race / refused）：不提示，可再催办；
 * - 只有已发出、回执无法核对时才提示“服务端回执无法核对，结果未知”，催办按钮锁定。
 * 挂真实合同行操作（RowActions → 审批模块存储 → CommandStatus），接口夹具同真实返回形态：
 * 列表 GET /api/tenant/approval/instances 返回 { items, page, pageSize }（queries.ts listInstances），
 * 详情与催办回执同 respondDetail（催办不推进版本）。别的标签页 A 的登记做法同 AC-FE-F566。期望值手写。
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { holdLock, installWebLocks } from './support/web-locks.js';

let uninstallLocks = installWebLocks();
const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { MemoryRouter } = requireWeb('react-router');
// 行内提示走 antd 静态 message：与入口 main.tsx 一样装 React 19 兼容补丁，提示才会渲染。
requireWeb('@ant-design/v5-patch-for-react-19');
const { message } = requireWeb('antd');
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { RowActions } = await import(resolve('apps/web/src/contracts/RowActions.tsx'));

const RECORDS = 'italent.commands.pending:approval';
const CONTRACT = '5680a000-0000-4000-8000-000000000001';
const INSTANCE = '5680b000-0000-4000-8000-000000000002';
const LIST_PATH = '/api/tenant/approval/instances';
const DETAIL_PATH = `${LIST_PATH}/${INSTANCE}`;
const URGE_PATH = `${DETAIL_PATH}/urge`;
const LOCK_WAIT_MS = 3000;
const LOCK_BUSY = '检测到你在另一个标签页打开了此单据，请关闭后重试。';
const UNSUPPORTED = '当前浏览器环境不支持安全保存（需 https 访问），命令未发出。';
const OTHER_TAB = '其他标签页有该对象未确认的命令，本次命令未发出；请等待结果或先查询结果。';
const RESULT_UNKNOWN = '服务端回执无法核对，结果未知';
const KERNEL_UNKNOWN = '处理中 / 结果待确认。当前表单已锁定，请勿重新创建命令。';
const URGED = '已催办';
const STATE_CHANGED = '流程状态已变化，请刷新后重试';

// 与 GET /api/tenant/approval/instances?role=initiated&businessId= 的列表行同形（queries.ts listInstances）。
const listRow = {
  id: INSTANCE,
  title: '合成员工的合同续签申请',
  status: 'in_review',
  approvalType: 'contract_renew',
  businessId: CONTRACT,
  currentNodeKey: 'n1',
  revision: 6,
  createdAt: '2026-11-20T01:00:00.000Z',
};
// 与 GET /api/tenant/approval/instances/:id 同形（respondDetail）：本人发起、审批中，可催办。
const detail = (revision = 6, id = INSTANCE) => ({
  id,
  title: listRow.title,
  status: 'in_review',
  approvalType: listRow.approvalType,
  revision,
  createdAt: listRow.createdAt,
  actions: ['urge'],
  recordsHidden: false,
  form: { values: { effectiveDate: '2026-12-01' }, originals: {} },
  tasks: [{ id: '5680c000-0000-4000-8000-000000000003', nodeName: '部门负责人审批', status: 'pending' }],
  logs: [{ event: 'start', actorUserId: 'u1', actorName: '合成发起人', createdAt: listRow.createdAt }],
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let posts: string[];
let tenantId: string;
/** 催办回执：默认是催办后的详情（实例不变、版本不变）。 */
let urgeReply: () => Response;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  posts = [];
  tenantId = randomUUID();
  urgeReply = () => Response.json(detail());
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://local');
      const method = init.method ?? 'GET';
      if (method === 'POST' && url.pathname === URGE_PATH) {
        posts.push(new Headers(init.headers).get('idempotency-key') ?? '');
        return urgeReply();
      }
      if (method === 'GET' && url.pathname === LIST_PATH)
        return Response.json({
          items: url.searchParams.get('role') === 'initiated' ? [listRow] : [],
          page: 1,
          pageSize: 1,
        });
      if (method === 'GET' && url.pathname === DETAIL_PATH) return Response.json(detail());
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
  // 行内提示挂在 antd 全局 message 容器里：只清提示、不清 body，否则后续用例的提示渲染到已脱离的容器。
  // happy-dom 里离场动画不会结束，已清的提示停在离场态，读页面时排除（见 text）。
  await act(async () => message.destroy());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  uninstallLocks();
  uninstallLocks = installWebLocks();
  localStorage.clear();
  sessionStorage.clear();
});

/** 页面文字：合同行操作区（含 CommandStatus）+ 仍在显示的行内提示（离场中的旧提示不算）。 */
const text = () =>
  [host, ...Array.from(document.querySelectorAll('.ant-message-notice-wrapper:not(.ant-message-move-up-leave)'))]
    .map((node) => node.textContent ?? '')
    .join('');
/** 逐个时间片推进（每片都在 act 里刷新 DOM），直到条件成立；超过 2 秒按超时失败。 */
async function until(done: () => boolean) {
  for (let tick = 0; tick < 100 && !done(); tick += 1)
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
  expect(done(), `页面文字：${text()}`).toBe(true);
}
const urgeButton = () =>
  Array.from(host.querySelectorAll('button')).find((item) => item.textContent?.replace(/\s/g, '') === '催办') as
    HTMLButtonElement | undefined;
async function render() {
  const session = { tenantId, identityKey: 'synthetic-user', displayName: '合成用户', source: 'server' };
  await act(async () =>
    root.render(
      h(
        SessionProvider,
        { session },
        h(MemoryRouter, { initialEntries: ['/'] }, h(RowActions, { row: { id: CONTRACT }, onChanged: () => {} })),
      ),
    ),
  );
  await until(() => !!urgeButton());
}
const clickUrge = () => act(async () => urgeButton()!.click());
const scoped = (name: string) => JSON.stringify([tenantId, 'synthetic-user', name]);
/** 别的标签页 A 在锁内登记了同一流程实例的命令（结果未知，占着本槽）。 */
const registerA = () =>
  localStorage.setItem(
    RECORDS,
    JSON.stringify([
      { key: scoped(DETAIL_PATH), slots: [scoped(DETAIL_PATH)], commandId: 'synthetic-command-a', revision: 6 },
    ]),
  );

describe('AC-FE-F568 合同行内催办：命令在登记阶段未发出时显示真实原因', () => {
  it('他页一直持锁、等锁超时（DEC-954）：提示锁占用原文，不提示结果未知，零请求；他页关闭后可再催办', async () => {
    await render();
    const release = await holdLock(RECORDS);
    try {
      const spy = vi.spyOn(navigator.locks, 'request');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await clickUrge();
      await vi.waitFor(() => expect(spy).toHaveBeenCalled());
      await act(() => vi.advanceTimersByTimeAsync(LOCK_WAIT_MS));
    } finally {
      vi.useRealTimers();
    }
    await until(() => text().includes(LOCK_BUSY));
    expect(posts).toEqual([]);
    expect(text()).not.toContain(RESULT_UNKNOWN);
    expect(text()).not.toContain(KERNEL_UNKNOWN);
    expect(urgeButton()!.disabled).toBe(false);

    release();
    await clickUrge();
    await until(() => text().includes(URGED));
    expect(posts).toHaveLength(1);
  });

  it('浏览器不支持 Web Locks（DEC-955）：提示不支持安全保存原文，不提示结果未知，零请求', async () => {
    await render();
    uninstallLocks();
    await clickUrge();
    await until(() => text().includes(UNSUPPORTED));
    expect(posts).toEqual([]);
    expect(text()).not.toContain(RESULT_UNKNOWN);
    expect(urgeButton()!.disabled).toBe(false);
  });

  it('别页已登记同一流程实例（race）：提示其他标签页原因，不提示结果未知，零请求，催办锁定', async () => {
    await render();
    registerA();
    await clickUrge();
    await until(() => text().includes(OTHER_TAB));
    expect(posts).toEqual([]);
    expect(text()).not.toContain(RESULT_UNKNOWN);
    expect(urgeButton()!.disabled).toBe(true);
  });

  it('登记冲突但占槽命令已在本页处理拒绝前落定（无 race / refused）：不提示结果未知与其他标签页，可再催办', async () => {
    await render();
    const release = await holdLock(RECORDS); // A 持锁登记
    const request = navigator.locks.request.bind(navigator.locks);
    // 跨标签页交错：B 的登记读到 A 的记录被拒之后、B 处理这次拒绝之前，A 已收到回执并删掉记录。
    const spy = vi.spyOn(navigator.locks, 'request').mockImplementationOnce((...args: unknown[]) =>
      (request as (...rest: unknown[]) => Promise<unknown>)(...args).catch((cause: unknown) => {
        localStorage.removeItem(RECORDS);
        throw cause;
      }),
    );
    await clickUrge();
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    registerA();
    release();
    await until(() => urgeButton()!.disabled === false);
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
    expect(posts).toEqual([]);
    expect(text()).not.toContain(RESULT_UNKNOWN);
    expect(text()).not.toContain(OTHER_TAB);

    await clickUrge();
    await until(() => text().includes(URGED));
    expect(posts).toHaveLength(1);
  });
});

describe('AC-FE-F568 合同行内催办：已发出后的结果', () => {
  it('已发出、回执无法核对（实例不符）：提示结果未知，催办锁定，只发出一次', async () => {
    urgeReply = () => Response.json(detail(6, '5680d000-0000-4000-8000-000000000004'));
    await render();
    await clickUrge();
    await until(() => text().includes(RESULT_UNKNOWN));
    expect(posts).toHaveLength(1);
    expect(text()).toContain(KERNEL_UNKNOWN);
    expect(text()).not.toContain(URGED);
    expect(urgeButton()!.disabled).toBe(true);
  });

  it('正例：已发出、服务端明确拒绝（4xx）：显示服务端原文，不提示结果未知，可再催办', async () => {
    urgeReply = () =>
      Response.json({ error: { code: 'APPROVAL_STATE_CHANGED', message: STATE_CHANGED } }, { status: 409 });
    await render();
    await clickUrge();
    await until(() => text().includes(STATE_CHANGED));
    expect(posts).toHaveLength(1);
    expect(text()).not.toContain(RESULT_UNKNOWN);
    expect(urgeButton()!.disabled).toBe(false);
  });

  it('正例：催办成功：提示已催办，只发出一次，恢复记录已清', async () => {
    await render();
    await clickUrge();
    await until(() => text().includes(URGED));
    expect(posts).toHaveLength(1);
    expect(text()).not.toContain(RESULT_UNKNOWN);
    expect(localStorage.getItem(RECORDS)).toBeNull();
    expect(urgeButton()!.disabled).toBe(false);
  });
});
