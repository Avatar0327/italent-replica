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
 * 第 2 轮（Sol r1）：
 * - P2-1 点击时重读失败（GET 503 / 断网 / 详情缺 actions）：命令没发出，提示“审批操作读取失败”，零 POST、可重试；
 *   登录、权限、不存在保留接口提示；
 * - P2-2 过期竞争：每次 DOM 提交都不渲染旧告警；撤销被拒留下的槽、过期竞争之后再点催办按最新版本发出并成功；
 * - P2-3 催办 POST 回执无法解析（200 非 JSON）：按命令结果提示结果未知，保持原命令锁定，只发出一次。
 * 第 3 轮（Sol r2）：状态区保留恢复入口——两类未知回执可点「回查原单」、版本冲突可点「重读最新版本」，
 *   点击后读取审批详情，不增加 POST。
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { holdLock, installWebLocks } from './support/web-locks.js';

let uninstallLocks = installWebLocks();
const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act, Profiler } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { MemoryRouter } = requireWeb('react-router');
// 行内提示走 antd 静态 message：与入口 main.tsx 一样装 React 19 兼容补丁，提示才会渲染。
requireWeb('@ant-design/v5-patch-for-react-19');
const { message } = requireWeb('antd');
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { RowActions } = await import(resolve('apps/web/src/contracts/RowActions.tsx'));
const { ApprovalDetail } = await import(resolve('apps/web/src/approval/ApprovalDetail.tsx'));

const RECORDS = 'italent.commands.pending:approval';
const CONTRACT = '5680a000-0000-4000-8000-000000000001';
const INSTANCE = '5680b000-0000-4000-8000-000000000002';
const LIST_PATH = '/api/tenant/approval/instances';
const DETAIL_PATH = `${LIST_PATH}/${INSTANCE}`;
const URGE_PATH = `${DETAIL_PATH}/urge`;
const WITHDRAW_PATH = `${DETAIL_PATH}/withdraw`;
const LOCK_WAIT_MS = 3000;
const LOCK_BUSY = '检测到你在另一个标签页打开了此单据，请关闭后重试。';
const UNSUPPORTED = '当前浏览器环境不支持安全保存（需 https 访问），命令未发出。';
const OTHER_TAB = '其他标签页有该对象未确认的命令，本次命令未发出；请等待结果或先查询结果。';
const RESULT_UNKNOWN = '服务端回执无法核对，结果未知';
const KERNEL_UNKNOWN = '处理中 / 结果待确认。当前表单已锁定，请勿重新创建命令。';
const URGED = '已催办';
const STATE_CHANGED = '流程状态已变化，请刷新后重试';
const READ_FAILED = '审批操作读取失败';
const UNCERTAIN = '结果尚未确认，请先回查记录，勿重复提交';
const LOAD_FAILED = '加载失败，请稍后重试';
const DENIED = '暂无访问权限';

// 与 GET /api/tenant/approval/instances?role=initiated&businessId= 的列表行同形（queries.ts listInstances）。
const listRow = {
  id: INSTANCE,
  title: '合成员工的合同续签申请',
  status: 'running',
  approvalType: 'contract_renew',
  businessId: CONTRACT,
  currentNodeKey: 'n1',
  revision: 6,
  createdAt: '2026-11-20T01:00:00.000Z',
};
// 与 GET /api/tenant/approval/instances/:id 同形（respondDetail）：本人发起、审批中（running），可催办。
const detail = (revision = 6, id = INSTANCE, actions: string[] = ['urge']) => ({
  id,
  title: listRow.title,
  status: 'running',
  approvalType: listRow.approvalType,
  revision,
  createdAt: listRow.createdAt,
  actions,
  recordsHidden: false,
  form: { values: { effectiveDate: '2026-12-01' }, originals: {} },
  tasks: [{ id: '5680c000-0000-4000-8000-000000000003', nodeName: '部门负责人审批', status: 'pending' }],
  logs: [{ event: 'start', actorUserId: 'u1', actorName: '合成发起人', createdAt: listRow.createdAt }],
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
/** 写请求：路径、幂等键与 If-Match（命令实际提交的版本）。 */
let posts: { path: string; key: string; ifMatch: string | null }[];
/** 每次 React 提交后的页面文字（合同行操作区 + 行内提示），证明中途也没渲染过旧告警。 */
let commits: string[];
let tenantId: string;
/** 服务端当前版本：写请求 If-Match 不等于它时按 REVISION_CONFLICT 返回 409。 */
let revision: number;
/** 催办回执：默认是催办后的详情（实例不变、版本不变）。 */
let urgeReply: () => Response;
/** 详情 GET：默认按当前版本返回；用例在首载之后改它，模拟点击时重读失败。 */
let detailReply: () => Response;
let detailActions: string[];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  posts = [];
  commits = [];
  tenantId = randomUUID();
  revision = 6;
  detailActions = ['urge'];
  urgeReply = () => Response.json(detail(revision));
  detailReply = () => Response.json(detail(revision, INSTANCE, detailActions));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://local');
      const method = init.method ?? 'GET';
      if (method === 'POST') {
        const headers = new Headers(init.headers);
        const ifMatch = headers.get('if-match');
        posts.push({ path: url.pathname, key: headers.get('idempotency-key') ?? '', ifMatch });
        if (ifMatch !== String(revision))
          return Response.json({ error: { code: 'REVISION_CONFLICT', message: '合成' } }, { status: 409 });
        if (url.pathname === URGE_PATH) return urgeReply();
        if (url.pathname === WITHDRAW_PATH)
          return Response.json({ error: { code: 'APPROVAL_STATE_CHANGED', message: STATE_CHANGED } }, { status: 409 });
      }
      if (method === 'GET' && url.pathname === LIST_PATH)
        return Response.json({
          items: url.searchParams.get('role') === 'initiated' ? [listRow] : [],
          page: 1,
          pageSize: 1,
        });
      if (method === 'GET' && url.pathname === DETAIL_PATH) return detailReply();
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
  vi.useRealTimers(); // 先恢复真实定时器，下面等提示离场用真实时间片
  await clearMessages();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  uninstallLocks();
  uninstallLocks = installWebLocks();
  localStorage.clear();
  sessionStorage.clear();
});

/**
 * 用例收尾清掉行内提示。提示挂在 antd 全局 message 容器里：只清提示、不清 body，否则后续用例的提示渲染到已脱离的容器。
 * message.destroy() 只让提示转入离场；happy-dom 不跑 CSS 动画，离场结束事件不会自己来，提示的 Notice 一直挂着，
 * 它的 3 秒自动关闭定时器也就一直不清；测试环境销毁（删掉全局 window）后它才到期，就留下
 * “ReferenceError: window is not defined” 未处理错误（F-587）。这里补发离场结束事件让离场走完，
 * Notice 卸载时清掉自己的定时器（rc-notification 默认 pauseOnHover，卸载即 clearTimeout）。
 */
async function clearMessages() {
  await act(async () => message.destroy());
  const notices = () => Array.from(document.querySelectorAll('.ant-message-notice-wrapper'));
  // 离场要先走到 active 步骤（按动画帧推进）才认结束事件，所以逐个时间片补发，直到节点全部移除。
  for (let tick = 0; tick < 50 && notices().length > 0; tick += 1)
    await act(async () => {
      for (const node of notices()) node.dispatchEvent(new Event('animationend'));
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
  expect(notices(), '行内提示未卸载，自动关闭定时器会残留到环境销毁后').toEqual([]);
}

/** 页面文字：合同行操作区（含 CommandStatus）+ 仍在显示的行内提示（用例中途离场的旧提示不算）。 */
const text = () =>
  [host, ...Array.from(document.querySelectorAll('.ant-message-notice-wrapper:not(.ant-message-move-up-leave)'))]
    .map((node) => node.textContent ?? '')
    .join('');
const record = () => commits.push(text());
/** 逐个时间片推进（每片都在 act 里刷新 DOM），直到条件成立；超过 2 秒按超时失败。 */
async function until(done: () => boolean) {
  for (let tick = 0; tick < 100 && !done(); tick += 1)
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
  expect(done(), `页面文字：${text()}`).toBe(true);
}
const buttonIn = (scope: ParentNode, label: string) =>
  Array.from(scope.querySelectorAll('button')).find((item) => item.textContent?.replace(/\s/g, '') === label) as
    HTMLButtonElement | undefined;
const urgeButton = () => buttonIn(host, '催办');
const session = () => ({ tenantId, identityKey: 'synthetic-user', displayName: '合成用户', source: 'server' });
/** 挂合同行操作；ready 为假时不等催办按钮（首载失败的用例）。 */
async function render(ready = true) {
  await act(async () =>
    root.render(
      h(
        SessionProvider,
        { session: session() },
        h(
          MemoryRouter,
          { initialEntries: ['/'] },
          h(
            Profiler,
            { id: 'row-actions', onRender: record },
            h(RowActions, { row: { id: CONTRACT }, onChanged: () => {} }),
          ),
        ),
      ),
    ),
  );
  if (ready) await until(() => !!urgeButton());
}
const clickUrge = () => act(async () => urgeButton()!.click());
const urges = () => posts.filter((post) => post.path === URGE_PATH);
/** 审批详情 GET 次数（首载、点击时重读、状态区回查 / 重读都算）。 */
const detailReads = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(
      ([input, init]) =>
        (init?.method ?? 'GET') === 'GET' && new URL(String(input), 'http://local').pathname === DETAIL_PATH,
    ).length;
/** 点状态区的恢复按钮：读取审批详情、不增加 POST。 */
async function recoverWith(label: string) {
  await until(() => !!buttonIn(host, label));
  const reads = detailReads();
  const sent = posts.length;
  await act(async () => buttonIn(host, label)!.click());
  await until(() => detailReads() > reads);
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
  expect(posts).toHaveLength(sent);
}
/** 别页 A 的登记读到后、本页处理冲突前 A 已落定删记录（同 AC-FE-F566）；返回锁请求探针与“放开 A 的锁”。 */
async function staleConflict() {
  const release = await holdLock(RECORDS); // A 持锁登记
  const request = navigator.locks.request.bind(navigator.locks);
  const spy = vi.spyOn(navigator.locks, 'request').mockImplementationOnce((...args: unknown[]) =>
    (request as (...rest: unknown[]) => Promise<unknown>)(...args).catch((cause: unknown) => {
      localStorage.removeItem(RECORDS);
      throw cause;
    }),
  );
  return { spy, release };
}
/**
 * 同一审批模块存储里，先在审批详情（ApprovalDetail → FormOverlay）撤销被拒（业务 409）：
 * 槽里留下一条已落定的撤销拒绝（F-147 共用槽），再回到合同行。
 */
async function withdrawRejected() {
  detailActions = ['urge', 'withdraw'];
  const page = document.createElement('div');
  document.body.append(page);
  const detailRoot = createRoot(page);
  const row = { id: INSTANCE, title: listRow.title, approvalType: listRow.approvalType, status: 'running' };
  const props = { row, layout: 'page', applications: true, onClose: () => {}, onChanged: () => {} };
  await act(async () =>
    detailRoot.render(
      h(SessionProvider, { session: session() }, h(MemoryRouter, { initialEntries: ['/'] }, h(ApprovalDetail, props))),
    ),
  );
  await until(() => !!buttonIn(page, '撤销'));
  await act(async () => buttonIn(page, '撤销')!.click());
  const footer = () => document.querySelector('.ant-modal .ant-modal-footer');
  await until(() => !!footer());
  await act(async () => buttonIn(footer()!, '保存')!.click());
  await until(() => (document.body.textContent ?? '').includes(STATE_CHANGED));
  expect(posts.map((post) => [post.path, post.ifMatch])).toEqual([[WITHDRAW_PATH, '6']]);
  await act(() => detailRoot.unmount());
  page.remove();
}
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
    const before = commits.length;
    registerA();
    release();
    await until(() => urgeButton()!.disabled === false);
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
    expect(posts).toEqual([]);
    expect(text()).not.toContain(RESULT_UNKNOWN);
    expect(text()).not.toContain(OTHER_TAB);
    // 第 2 轮 P2-2：处理拒绝期间每一次 React 提交都没渲染过“其他标签页”旧告警（状态区与行内提示）。
    expect(commits.length).toBeGreaterThan(before);
    expect(commits.slice(before).filter((page) => page.includes(OTHER_TAB))).toEqual([]);

    await clickUrge();
    await until(() => text().includes(URGED));
    expect(posts).toHaveLength(1);
  });
});

describe('AC-FE-F568 第 2 轮 P2-1：点击时重读失败，命令没发出', () => {
  it.each([
    ['GET 503', () => Response.json({ error: { code: 'SERVICE_UNAVAILABLE', message: '合成' } }, { status: 503 })],
    [
      '断网',
      () => {
        throw new TypeError('Failed to fetch');
      },
    ],
    ['详情缺 actions', () => Response.json({ ...detail(), actions: undefined })],
  ])('%s：提示审批操作读取失败，不提示结果未知，零 POST、无恢复记录，可重试', async (_case, failure) => {
    await render();
    detailReply = failure;
    await clickUrge();
    await until(() => text().includes(READ_FAILED));
    expect(posts).toEqual([]);
    expect(text()).not.toContain(UNCERTAIN);
    expect(text()).not.toContain(RESULT_UNKNOWN);
    expect(text()).not.toContain(KERNEL_UNKNOWN);
    expect(localStorage.getItem(RECORDS)).toBeNull();
    expect(urgeButton()!.disabled).toBe(false);

    detailReply = () => Response.json(detail(revision));
    await clickUrge();
    await until(() => text().includes(URGED));
    expect(urges().map((post) => post.ifMatch)).toEqual(['6']);
  });

  it('正例：重读 403：保留权限提示原文，不改成读取失败，零 POST', async () => {
    await render();
    detailReply = () => Response.json({ error: { code: 'FORBIDDEN', message: '合成' } }, { status: 403 });
    await clickUrge();
    await until(() => text().includes(DENIED));
    expect(posts).toEqual([]);
    expect(text()).not.toContain(READ_FAILED);
    expect(text()).not.toContain(UNCERTAIN);
    expect(urgeButton()!.disabled).toBe(false);
  });

  it.each([
    ['GET 503', () => Response.json({ error: { code: 'SERVICE_UNAVAILABLE', message: '合成' } }, { status: 503 })],
    ['详情缺 actions', () => Response.json({ ...detail(), actions: undefined })],
  ])('首载 %s：不显示按钮，提示读取失败与重试；点重试读到后显示催办', async (_case, failure) => {
    detailReply = failure;
    await render(false);
    await until(() => text().includes(READ_FAILED) && !!buttonIn(host, '重试'));
    expect(urgeButton()).toBeUndefined();
    expect(posts).toEqual([]);

    detailReply = () => Response.json(detail(revision));
    await act(async () => buttonIn(host, '重试')!.click());
    await until(() => !!urgeButton());
    expect(text()).not.toContain(READ_FAILED);
  });
});

describe('AC-FE-F568 第 2 轮 P2-2：撤销被拒 → 过期竞争 → 按新版本催办', () => {
  it('槽里是已落定的撤销拒绝时遇到过期竞争：逐次提交无旧告警、零 POST；版本推进后再点按 7 发出并成功', async () => {
    await withdrawRejected();
    await render();
    const { spy, release } = await staleConflict();
    await clickUrge();
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    const before = commits.length;
    registerA();
    release();
    await until(() => urgeButton()!.disabled === false);
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
    expect(urges()).toEqual([]);
    expect(commits.length).toBeGreaterThan(before);
    expect(commits.slice(before).filter((page) => page.includes(OTHER_TAB))).toEqual([]);
    expect(text()).not.toContain(OTHER_TAB);
    expect(text()).not.toContain(RESULT_UNKNOWN);

    // 别的操作把流程推进到 7：再次点击按点击时重读到的 7 发出，不沿用残留拒绝里的 6。
    revision = 7;
    await clickUrge();
    await until(() => text().includes(URGED));
    expect(urges().map((post) => post.ifMatch)).toEqual(['7']);
    expect(localStorage.getItem(RECORDS)).toBeNull();
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
    // 第 2 轮 P2-3：原命令的恢复记录仍在（锁定的是发出去的那条命令），点击不再发出。
    expect(localStorage.getItem(RECORDS)).toContain(urges()[0]!.key);
    await clickUrge();
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
    expect(posts).toHaveLength(1);
  });

  it('第 2 轮 P2-3：已发出、回执无法解析（200 非 JSON）：提示结果未知而非加载失败，保持原命令锁定，只发出一次', async () => {
    urgeReply = () =>
      new Response('<html>合成网关页</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    await render();
    await clickUrge();
    await until(() => text().includes(RESULT_UNKNOWN));
    expect(text()).not.toContain(LOAD_FAILED);
    expect(text()).not.toContain(URGED);
    expect(text()).toContain(KERNEL_UNKNOWN);
    expect(urgeButton()!.disabled).toBe(true);
    expect(localStorage.getItem(RECORDS)).toContain(urges()[0]!.key);
    await clickUrge();
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
    expect(posts).toHaveLength(1);
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

describe('AC-FE-F568 第 3 轮：状态区保留恢复入口', () => {
  it.each([
    ['实例不符', () => Response.json(detail(6, '5680d000-0000-4000-8000-000000000004'))],
    [
      '200 非 JSON',
      () => new Response('<html>合成网关页</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ],
  ])('回执无法核对（%s）：状态区有「回查原单」，点击读取详情，不增加 POST，仍锁定', async (_case, reply) => {
    urgeReply = reply;
    await render();
    await clickUrge();
    await until(() => text().includes(RESULT_UNKNOWN));
    expect(posts).toHaveLength(1);
    await recoverWith('回查原单');
    expect(posts).toHaveLength(1);
    expect(urgeButton()!.disabled).toBe(true);
  });

  it('POST 409 REVISION_CONFLICT：状态区有「重读最新版本」，点击读取详情，不增加 POST', async () => {
    await render();
    // 点击时重读到 6，提交前流程已被别的操作推进到 7：服务端按 If-Match 返回版本冲突。
    revision = 7;
    detailReply = () => Response.json(detail(6));
    await clickUrge();
    await until(() => !!buttonIn(host, '重读最新版本'));
    expect(urges().map((post) => post.ifMatch)).toEqual(['6']);
    detailReply = () => Response.json(detail(revision));
    await recoverWith('重读最新版本');
    expect(posts).toHaveLength(1);
  });
});
