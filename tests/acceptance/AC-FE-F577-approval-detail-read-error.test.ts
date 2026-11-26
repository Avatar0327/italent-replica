/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * AC-FE-F577（F-568 卡外遗留）审批详情读取失败按读取失败提示：
 * - 详情只发 GET、没有命令：首载 / 点「重新读取」/ 流程日志弹窗读到 503 或断网时提示“加载失败”，
 *   不借用“结果尚未确认，请先回查记录”，全程零 POST；
 * - 登录、权限、不存在、限流保留接口的有意义提示；
 * - 正例：命令已发出、回执无法核对时仍提示结果未知（F-566 / F-568 口径不回退）。
 * 挂真实组件（ApprovalDetail → PageState / ProcessLog / FormOverlay），接口夹具同真实返回形态：
 * 详情与动作回执同 respondDetail，流程日志同 GET /instances/:id/logs（{ items, recordsHidden, page, pageSize }）。
 * 期望值手写。
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installWebLocks } from './support/web-locks.js';

let uninstallLocks = installWebLocks();
const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { MemoryRouter } = requireWeb('react-router');
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { ApprovalDetail } = await import(resolve('apps/web/src/approval/ApprovalDetail.tsx'));

const INSTANCE = '5770b000-0000-4000-8000-000000000001';
const TASK = '5770c000-0000-4000-8000-000000000002';
const DETAIL_PATH = `/api/tenant/approval/instances/${INSTANCE}`;
const LOGS_PATH = `${DETAIL_PATH}/logs`;
const TITLE = '合成员工的合同续签申请';
const UNCERTAIN = '结果尚未确认，请先回查记录，勿重复提交';
const LOAD_FAILED = '加载失败，请稍后重试';
const LOGIN = '请选择演示身份或提供会话上下文';
const DENIED = '暂无访问权限';
const MISSING = '页面或记录不存在';
const RATE_LIMIT = '请求过于频繁，请在等待时间结束后再试';
const KERNEL_UNKNOWN = '处理中 / 结果待确认。当前表单已锁定，请勿重新创建命令。';

// 与 GET /api/tenant/approval/instances/:id 同形（respondDetail）：审批中（running），当前人可同意。
const detail = (revision = 4) => ({
  id: INSTANCE,
  taskId: TASK,
  title: TITLE,
  status: 'running',
  approvalType: 'contract_renew',
  revision,
  createdAt: '2026-11-20T01:00:00.000Z',
  actions: ['approve'],
  recordsHidden: false,
  form: { values: { effectiveDate: '2026-12-01' }, originals: {} },
  tasks: [{ id: TASK, nodeName: '部门负责人审批', status: 'pending', nodeKey: 'n1' }],
  logs: [{ event: 'start', actorUserId: 'u1', actorName: '合成发起人', createdAt: '2026-11-20T01:00:00.000Z' }],
});
const failure = (status: number, code: string) => () =>
  Response.json(
    { error: { code, message: '合成' } },
    { status, headers: status === 429 ? { 'retry-after': '30' } : {} },
  );
const unavailable = failure(503, 'SERVICE_UNAVAILABLE');
const offline = () => {
  throw new TypeError('Failed to fetch');
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
/** 全部请求（方法 + 路径）：读取失败用例断言其中没有任何写请求。 */
let calls: { method: string; path: string }[];
let detailReply: () => Response;
let logsReply: () => Response;
let actionReply: () => Response;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  calls = [];
  detailReply = () => Response.json(detail());
  logsReply = () => Response.json({ items: detail().logs, recordsHidden: false, page: 1, pageSize: 20 });
  // 默认回执版本不推进：acceptReceipt 判为回执无法核对（结果未知）。
  actionReply = () => Response.json(detail());
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://local');
      const method = init.method ?? 'GET';
      calls.push({ method, path: url.pathname });
      if (method !== 'GET') return actionReply();
      if (url.pathname === DETAIL_PATH) return detailReply();
      if (url.pathname === LOGS_PATH) return logsReply();
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  uninstallLocks();
  uninstallLocks = installWebLocks();
  localStorage.clear();
  sessionStorage.clear();
});

/** 抽屉、弹窗挂在 body 上：读整页文字。 */
const text = () => document.body.textContent ?? '';
async function until(done: () => boolean) {
  for (let tick = 0; tick < 100 && !done(); tick += 1)
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
  expect(done(), `页面文字：${text()}`).toBe(true);
}
const button = (label: string, scope: ParentNode = document.body) =>
  Array.from(scope.querySelectorAll('button')).find((item) => item.textContent?.replace(/\s/g, '') === label) as
    HTMLButtonElement | undefined;
const click = (label: string, scope?: ParentNode) => act(async () => button(label, scope)!.click());
const writes = () => calls.filter((call) => call.method !== 'GET');
const detailReads = () => calls.filter((call) => call.path === DETAIL_PATH).length;
const session = () => ({
  tenantId: randomUUID(),
  identityKey: 'synthetic-user',
  displayName: '合成用户',
  timezone: 'Asia/Shanghai',
  source: 'server',
});
const row = { id: INSTANCE, taskId: TASK, title: TITLE, approvalType: 'contract_renew', status: 'running' };
async function render(props: Record<string, unknown> = {}) {
  const all = { row, layout: 'page', onClose: () => {}, onChanged: () => {}, ...props };
  await act(async () =>
    root.render(
      h(SessionProvider, { session: session() }, h(MemoryRouter, { initialEntries: ['/'] }, h(ApprovalDetail, all))),
    ),
  );
}
/** 读取失败的共同断言：提示加载失败、不提示结果未知、零写请求。 */
function expectReadFailure() {
  expect(text()).toContain(LOAD_FAILED);
  expect(text()).not.toContain(UNCERTAIN);
  expect(text()).not.toContain(KERNEL_UNKNOWN);
  expect(writes()).toEqual([]);
}

describe('AC-FE-F577 审批详情读取失败：只有 GET，按读取失败提示', () => {
  it.each([
    ['GET 503', unavailable],
    ['断网', offline],
  ])('首载 %s（审批中心页内）：提示加载失败，不提示结果尚未确认，零 POST；重新加载后显示详情', async (_c, reply) => {
    detailReply = reply;
    await render();
    await until(() => !!button('重新加载'));
    expectReadFailure();

    detailReply = () => Response.json(detail());
    await click('重新加载');
    await until(() => !!button('同意'));
    expect(text()).not.toContain(LOAD_FAILED);
    expect(writes()).toEqual([]);
  });

  it('首载 GET 503（合同等页面的抽屉入口）：同样提示加载失败，零 POST', async () => {
    detailReply = unavailable;
    await render({ layout: 'drawer' });
    await until(() => !!button('重新加载'));
    expectReadFailure();
  });

  it('已打开详情后点「重新读取」遇 503：提示加载失败，不提示结果尚未确认，零 POST', async () => {
    await render();
    await until(() => !!button('同意'));
    const reads = detailReads();
    detailReply = unavailable;
    await click('重新读取');
    await until(() => detailReads() > reads && !!button('重新加载'));
    expectReadFailure();
  });

  it('流程日志弹窗读日志 503：提示加载失败，不提示结果尚未确认，零 POST', async () => {
    await render({ todo: true });
    await until(() => !!button('查看流程日志'));
    logsReply = unavailable;
    await click('查看流程日志');
    const modal = () => document.querySelector('.ant-modal') as HTMLElement | null;
    await until(() => !!modal() && !!button('重新加载', modal()!));
    expect(modal()!.textContent).toContain(LOAD_FAILED);
    expect(modal()!.textContent).not.toContain(UNCERTAIN);
    expect(writes()).toEqual([]);
  });

  it.each([
    ['401', failure(401, 'UNAUTHENTICATED'), LOGIN],
    ['403', failure(403, 'FORBIDDEN'), DENIED],
    ['404', failure(404, 'NOT_FOUND'), MISSING],
    ['429', failure(429, 'RATE_LIMITED'), RATE_LIMIT],
  ])('正例：首载 %s 保留接口的有意义提示，不改成结果未知，零 POST', async (_c, reply, hint) => {
    detailReply = reply;
    await render();
    await until(() => text().includes(hint));
    expect(text()).not.toContain(UNCERTAIN);
    expect(writes()).toEqual([]);
  });
});

describe('AC-FE-F577 正例：命令已发出后的结果未知不回退', () => {
  it('同意已发出、回执版本未推进（无法核对）：仍提示结果未知并锁定，只发出一次', async () => {
    await render();
    await until(() => !!button('同意'));
    await click('同意');
    const footer = () => document.querySelector('.ant-modal .ant-modal-footer');
    await until(() => !!footer());
    await click('保存', footer()!);
    await until(() => text().includes(KERNEL_UNKNOWN));
    expect(writes().map((call) => call.path)).toEqual([`/api/tenant/approval/tasks/${TASK}/approve`]);
    expect(text()).not.toContain(LOAD_FAILED);
  });
});
