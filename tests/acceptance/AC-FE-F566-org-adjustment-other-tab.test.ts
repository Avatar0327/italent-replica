/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * AC-FE-F566（F-562 卡外遗留，DEC-954）组织调整：编辑弹窗与详情状态区只显示内核 refused 带出的本次拒绝。
 * 登记冲突、而占槽命令在本页处理拒绝前已落定时，内核不带 race 也不带 refused（store.ts submitTo），
 * CommandStatus 不能残留“其他标签页有该对象未确认的命令”；真正的等锁超时（refused）仍显示 DEC-954 文案。
 * 挂真实编辑弹窗（ApplicationForm → FormOverlay → CommandStatus）与详情状态区的同款接法（AdjustmentDetail：
 * 非编辑时 CommandStatus + act 吞错），每次 DOM 提交后记下页面文字。A 的登记做法同 AC-FE-F562。期望值手写。
 * 第 2 轮：隐去旧告警不能丢掉已核对的版本（实际 If-Match）；真实列表页上关闭重开详情后仍隐去；
 * 等锁超时（refused）时槽被 A 接管，详情仍显示 DEC-954 原文，A 的命令仍可查询。
 * 第 3 轮：重开详情读到更新的版本后，过期条目不能再把旧版本带进提交（实际 If-Match）；
 * 重开编辑时字段被裁剪、内核复制了草稿条目，同一次命令的过期拒绝仍隐去（逐次 DOM）。
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
const { PermissionsProvider } = await import(resolve('apps/web/src/foundation/Permissions.tsx'));
const { AdjustmentPage } = await import(resolve('apps/web/src/org-adjustment/AdjustmentPage.tsx'));
const { CommandStatus } = await import(resolve('apps/web/src/foundation/forms/CommandStatus.tsx'));
const { ApplicationForm } = await import(resolve('apps/web/src/org-adjustment/ApplicationForm.tsx'));
const { useAdjustmentCommand } = await import(resolve('apps/web/src/org-adjustment/commands.ts'));

const RECORDS = 'italent.commands.pending:org-adjustment';
const ID = '85660000-0000-4000-8000-000000000001';
const ORG = '85660000-0000-4000-8000-0000000000a1';
const COLLECTION = '/api/tenant/org-adjustment/adjustments';
const DETAIL_PATH = `${COLLECTION}/${ID}`;
const OBJECT = 'TenantBase.OrganizationApproval';
const SUBMIT_PATH = `${DETAIL_PATH}/submit`;
const OTHER_TAB = '其他标签页有该对象未确认的命令，本次命令未发出；请等待结果或先查询结果。';
const LOCK_BUSY = '检测到你在另一个标签页打开了此单据，请关闭后重试。';
const LOCK_WAIT_MS = 3000;
const RESULT_FAILED = '已确认原命令未执行成功，输入已保留，请核对后重新提交。';
const UNCERTAIN = '结果尚未确认，请先回查记录，勿重复提交';
const SUBJECT = '合成调整主题（改）';

// 与 GET /api/tenant/org-adjustment/adjustments/:id 同形（detail.ts readDetail）：本人暂存的申请单。
const row = {
  id: ID,
  code: 'OA-566',
  subject: '合成调整主题',
  effectiveDate: '2026-12-01',
  content: null,
  approvalSubjectOrgId: ORG,
  approvalSubjectOrgName: '合成主体组织',
  adjustmentRange: [{ orgId: ORG, label: '合成主体组织', name: '合成主体组织' }],
  approvalStatus: 0,
  approvalStatusLabel: '暂存',
  executionStatus: 0,
  executionStatusLabel: '未执行',
  executionNote: null,
  createdBy: 'synthetic-user',
  createdByName: '合成用户',
  createdAt: '2026-11-20T01:00:00.000Z',
  revision: 4,
  approvalInstanceId: null,
  contentView: { mode: 'live' },
  sections: {},
};
// 写接口回执（routes.ts headCommand → AdjustmentView）：同一申请单、版本推进过 If-Match。
const receipt = (status: number, revision: number) => ({
  id: ID,
  code: 'OA-566',
  subject: SUBJECT,
  effectiveDate: '2026-12-01',
  approvalSubjectOrgId: ORG,
  adjustmentRange: [ORG],
  approvalStatus: status,
  revision,
});
// GET /api/tenant/permission/me/objects/:code（权限快照对象明细）：本人可编辑、提交暂存单（AdjustmentDetail edit）。
const objectPermission = {
  objectCode: OBJECT,
  dataOperations: { read: true, create: true, update: true },
  viewableFields: ['subject', 'effectiveDate', 'approvalSubjectOrgId', 'adjustmentRange', 'content'],
  editableFields: ['subject', 'effectiveDate', 'approvalSubjectOrgId', 'adjustmentRange', 'content'],
  buttons: [{ buttonCode: 'EditAdjustOrgDetailBtn', level: 'detail' }],
};
const access = {
  field: () => ({ visible: true, editable: true }),
  add: true,
  edit: true,
  void: true,
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let writes: { method: string; path: string; body: unknown }[];
/** 每次写请求实际带的 If-Match（client.ts 按命令 revision 发出）。 */
let ifMatches: (string | null)[];
/** 服务端当前版本：写请求 If-Match 不等于它时按 409 REVISION_CONFLICT 拒绝（routes.ts revision 校验）。 */
let server: number;
/** 每次 DOM 提交后的页面文字（含弹窗与 CommandStatus），用来证明中途也没渲染过旧告警。 */
let commits: string[];
let tenantId: string;
/** 详情 GET 是否按字段权限裁掉“调整主题”（服务端不返回该键，detail.ts 字段投影）。 */
let trimSubject: boolean;
const updated = vi.fn();
const closed = vi.fn();

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  writes = [];
  ifMatches = [];
  server = row.revision;
  trimSubject = false;
  commits = [];
  tenantId = randomUUID();
  updated.mockClear();
  closed.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const path = new URL(String(input), 'http://local').pathname;
      const method = init.method ?? 'GET';
      if ((method === 'PATCH' && path === DETAIL_PATH) || (method === 'POST' && path === SUBMIT_PATH)) {
        writes.push({ method, path, body: JSON.parse(String(init.body)) });
        const ifMatch = new Headers(init.headers).get('if-match');
        ifMatches.push(ifMatch);
        // errors.ts 的 409 响应体：REVISION_CONFLICT + details.expected。
        if (ifMatch !== String(server))
          return Response.json(
            {
              error: {
                code: 'REVISION_CONFLICT',
                message: '申请单已被修改，请刷新后重试',
                details: { expected: server },
              },
            },
            { status: 409 },
          );
        server += 1;
        return Response.json(receipt(method === 'PATCH' ? 0 : 1, server));
      }
      if (method === 'GET' && path === DETAIL_PATH) {
        const { subject: _subject, ...trimmed } = row;
        return Response.json({ ...(trimSubject ? trimmed : row), revision: server });
      }
      if (method === 'GET' && path === COLLECTION) return Response.json({ items: [row], total: 1 });
      if (path === '/api/tenant/permission/me/snapshot')
        return Response.json({ session: serverSession(), apps: [], scope: [], adminMenus: [] });
      if (path === `/api/tenant/permission/me/objects/${OBJECT}`) return Response.json(objectPermission);
      // GET /api/tenant/commands/:commandId/result（F-120 返回结构）：A 的命令已确认执行失败。
      if (path === '/api/tenant/commands/synthetic-command-a/result') {
        return Response.json({
          commandId: 'synthetic-command-a',
          status: 'failed',
          commandType: 'POST /api/tenant/org-adjustment/adjustments/:id/submit',
          businessType: 'org_adjustment',
          businessId: null,
          revision: null,
          httpStatus: 422,
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

/** 详情同款接法（AdjustmentDetail.tsx）：非编辑时显示 CommandStatus，“提交审批”走 act 吞错；编辑时打开编辑弹窗。 */
function Probe({ editing }: { editing: boolean }) {
  const command = useAdjustmentCommand(row, updated, access);
  const submit = () => {
    void command.send('submit').catch(() => {});
  };
  return h(
    'div',
    null,
    !editing && h(CommandStatus, { submission: command.form }),
    !editing && h('button', { className: 'probe-submit', disabled: command.form.locked, onClick: submit }, '提交审批'),
    editing && h(ApplicationForm, { row, command, onClose: closed }),
  );
}
/** Profiler 在每次提交的布局阶段回调（DOM 含弹窗 portal 已写完），读到的就是这次提交的页面。 */
const record = () => commits.push(document.body.textContent ?? '');
async function render(editing: boolean) {
  const session = { tenantId, identityKey: 'synthetic-user', displayName: '合成用户', source: 'server' };
  await act(async () =>
    root.render(
      h(SessionProvider, { session }, h(Profiler, { id: 'org-adjustment', onRender: record }, h(Probe, { editing }))),
    ),
  );
}
const buttonIn = (scope: ParentNode, label: string) =>
  Array.from(scope.querySelectorAll('button')).find(
    (item) => item.textContent?.replace(/\s/g, '') === label,
  ) as HTMLButtonElement;
const modal = () => document.querySelector('.ant-modal') as HTMLElement | null;
const subject = () => modal()?.querySelector('input[aria-label="调整主题"]') as HTMLInputElement | null;
const save = () => buttonIn(modal()!.querySelector('.ant-modal-footer')!, '保存');
const submitButton = () => host.querySelector('.probe-submit') as HTMLButtonElement;
async function editSubject() {
  await act(async () => {
    const node = subject()!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, SUBJECT);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
/** 逐个时间片推进（每片都在 act 里刷新 DOM），直到条件成立；超过 2 秒按超时失败。 */
async function until(done: () => boolean) {
  for (let tick = 0; tick < 100 && !done(); tick += 1)
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
  expect(done()).toBe(true);
}
const saveSettled = () => until(() => !save().classList.contains('ant-btn-loading'));
const scoped = (name: string) => JSON.stringify([tenantId, 'synthetic-user', name]);
/** 别的标签页 A 在锁内登记同一申请单的命令（结果未知，占着本条目）。 */
const registerA = () =>
  localStorage.setItem(
    RECORDS,
    JSON.stringify([
      { key: scoped(DETAIL_PATH), slots: [scoped(DETAIL_PATH)], commandId: 'synthetic-command-a', revision: 4 },
    ]),
  );
/** 跨标签页交错：B 的登记读到 A 的记录被拒之后、B 处理这次拒绝之前，A 已收到回执并删掉记录。 */
function settleABeforeRefusal() {
  const request = navigator.locks.request.bind(navigator.locks);
  return vi.spyOn(navigator.locks, 'request').mockImplementationOnce((...args: unknown[]) =>
    (request as (...rest: unknown[]) => Promise<unknown>)(...args).catch((cause: unknown) => {
      localStorage.removeItem(RECORDS);
      throw cause;
    }),
  );
}
/** 权限快照里服务端给的会话（permission-snapshot.ts loadSnapshot 以 userId 作身份键，与上面的恢复键一致）。 */
const serverSession = () => ({
  tenantId,
  userId: 'synthetic-user',
  tenantName: '合成租户',
  timezone: 'Asia/Shanghai',
  displayName: '合成用户',
});
/** 挂真实列表页（AdjustmentPage → AdjustmentDetail 抽屉）并直接打开本单详情，等“提交审批”可点。 */
async function renderPage() {
  const session = { tenantId, identityKey: 'synthetic-user', displayName: '合成用户', source: 'server' };
  await act(async () =>
    root.render(
      h(
        SessionProvider,
        { session },
        h(
          PermissionsProvider,
          null,
          h(
            MemoryRouter,
            { initialEntries: [`/org/adjustments?id=${ID}`] },
            h(Profiler, { id: 'org-adjustment-page', onRender: record }, h(AdjustmentPage)),
          ),
        ),
      ),
    ),
  );
  await until(() => !!detailSubmit() && !detailSubmit()!.disabled);
}
const detail = () => document.querySelector('.oa-detail') as HTMLElement | null;
const detailSubmit = () => (detail() ? buttonIn(detail()!, '提交审批') : undefined);
/** 关闭详情抽屉（列表页清掉 ?id，详情卸载）。 */
async function closeDetail() {
  await act(async () => (document.querySelector('.ant-drawer-close') as HTMLButtonElement).click());
  await until(() => !detail());
}
/** 在列表里点本单主题重新打开详情（AdjustmentDetail 按 key 重新挂载）。 */
async function reopenDetail() {
  await act(async () => (host.querySelector(`button[aria-label="${row.subject}"]`) as HTMLButtonElement).click());
  await until(() => !!detailSubmit());
}

describe('AC-FE-F566 组织调整登记冲突后占槽命令已落定', () => {
  it('编辑弹窗：B 登记被 A 的记录拒绝、处理拒绝前 A 已落定（内核不带 refused）：不残留其他标签页提示，可再保存', async () => {
    await render(true);
    await editSubject();
    const release = await holdLock(RECORDS); // A 持锁登记
    const spy = settleABeforeRefusal();
    await act(async () => save().click());
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    const before = commits.length;
    registerA();
    release();
    await saveSettled();
    expect(writes).toEqual([]);
    // 提交处理中每一次 DOM 提交都没出现过其他标签页告警（弹窗 CommandStatus 与表单提示区）。
    expect(commits.length).toBeGreaterThan(before);
    expect(commits.filter((page) => page.includes(OTHER_TAB))).toEqual([]);
    expect(document.body.textContent).not.toContain(OTHER_TAB);
    expect(document.body.textContent).not.toContain(UNCERTAIN);
    // 本次未发出：弹窗保留、输入保留、没有锁定。
    expect(subject()?.value).toBe(SUBJECT);
    expect(save().disabled).toBe(false);
    expect(closed).not.toHaveBeenCalled();

    // 没有锁定的命令：再保存照常发出一次。
    await act(async () => save().click());
    await until(() => closed.mock.calls.length === 1);
    expect(writes).toEqual([{ method: 'PATCH', path: DETAIL_PATH, body: { subject: SUBJECT } }]);
    expect(updated).toHaveBeenCalledWith(ID);
    expect(document.body.textContent).not.toContain(OTHER_TAB);
  });

  it('详情提交审批：同样的交错下状态区不残留其他标签页提示，可再提交', async () => {
    await render(false);
    const release = await holdLock(RECORDS);
    const spy = settleABeforeRefusal();
    await act(async () => submitButton().click());
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    const before = commits.length;
    registerA();
    release();
    await until(() => !submitButton().disabled);
    expect(writes).toEqual([]);
    expect(commits.length).toBeGreaterThan(before);
    expect(commits.filter((page) => page.includes(OTHER_TAB))).toEqual([]);
    expect(host.textContent).not.toContain(OTHER_TAB);

    await act(async () => submitButton().click());
    await until(() => updated.mock.calls.length === 1);
    expect(writes).toEqual([{ method: 'POST', path: SUBMIT_PATH, body: {} }]);
  });

  it('第 2 轮 P2-1 编辑弹窗：409 后重读并核对到 revision 5，再遇同样的交错，下次保存仍带 If-Match 5', async () => {
    server = 5; // 别人已把申请单改到 revision 5，本页详情还是 4。
    await render(true);
    await editSubject();
    await act(async () => save().click());
    await until(() => !!buttonIn(modal()!, '重读最新版本'));
    expect(ifMatches).toEqual(['4']);
    await act(async () => buttonIn(modal()!, '重读最新版本').click());
    await until(() => !!buttonIn(modal()!, '已核对差异，继续编辑'));
    await act(async () => buttonIn(modal()!, '已核对差异，继续编辑').click());
    await until(() => !save().disabled);
    expect(subject()?.value).toBe(SUBJECT);

    const release = await holdLock(RECORDS);
    const spy = settleABeforeRefusal();
    await act(async () => save().click());
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    const before = commits.length;
    registerA();
    release();
    await saveSettled();
    // 本次零请求、不提示、输入保留。
    expect(ifMatches).toEqual(['4']);
    expect(commits.slice(before).filter((page) => page.includes(OTHER_TAB))).toEqual([]);
    expect(subject()?.value).toBe(SUBJECT);

    // 已核对的版本不丢：再保存按 revision 5 发出，一次成功。
    await act(async () => save().click());
    await until(() => ifMatches.length === 2);
    expect(ifMatches).toEqual(['4', '5']);
    await until(() => closed.mock.calls.length === 1);
    expect(writes.at(-1)).toEqual({ method: 'PATCH', path: DETAIL_PATH, body: { subject: SUBJECT } });
  });

  it('第 2 轮 P2-2 真实详情：登记等锁时关闭并重开详情，再遇同样的交错，重开后的每次提交都不显示旧告警', async () => {
    await renderPage();
    const release = await holdLock(RECORDS);
    const spy = settleABeforeRefusal();
    await act(async () => detailSubmit()!.click());
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    await closeDetail();
    await reopenDetail();
    // 重开的详情读到的是同一条处理中的命令：按钮锁着。
    expect(detailSubmit()!.disabled).toBe(true);
    const before = commits.length;
    registerA();
    release();
    await until(() => !detailSubmit()!.disabled);
    expect(writes).toEqual([]);
    expect(commits.length).toBeGreaterThan(before);
    expect(commits.slice(before).filter((page) => page.includes(OTHER_TAB))).toEqual([]);
    expect(document.body.textContent).not.toContain(OTHER_TAB);

    await act(async () => detailSubmit()!.click());
    await until(() => writes.length === 1);
    expect(writes).toEqual([{ method: 'POST', path: SUBMIT_PATH, body: {} }]);
  });

  it('第 3 轮 P2-4 真实详情：等锁期间 A 把单子存到 revision 5，关闭重开读到 5 后提交审批带 If-Match 5', async () => {
    await renderPage();
    const release = await holdLock(RECORDS);
    const spy = settleABeforeRefusal();
    await act(async () => detailSubmit()!.click());
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    server = 5; // A 保存同一暂存单到 revision 5，随后删掉自己的恢复记录（settleABeforeRefusal）。
    registerA();
    release();
    await until(() => !detailSubmit()!.disabled);
    expect(writes).toEqual([]);

    await closeDetail();
    await reopenDetail();
    await until(() => !detailSubmit()!.disabled);
    await act(async () => detailSubmit()!.click());
    await until(() => ifMatches.length === 1);
    // 重开的详情按新读回的 revision 5 提交，不沿用过期条目的 revision 4。
    expect(ifMatches).toEqual(['5']);
    await until(() => !detailSubmit() || !detailSubmit()!.disabled);
    expect(writes).toEqual([{ method: 'POST', path: SUBMIT_PATH, body: {} }]);
    expect(document.body.textContent).not.toContain('申请单已被修改');
  });

  it('第 3 轮 P2-5 真实详情：409 核对后遇过期竞争，重开详情裁掉“调整主题”再打开编辑，每次提交都不显示旧告警', async () => {
    await renderPage();
    server = 5; // 别人已把申请单改到 revision 5，本页详情还是 4。
    await act(async () => buttonIn(detail()!, '修改申请').click());
    await until(() => !!subject());
    await editSubject();
    await act(async () => save().click());
    await until(() => !!buttonIn(modal()!, '重读最新版本'));
    await act(async () => buttonIn(modal()!, '重读最新版本').click());
    await until(() => !!buttonIn(modal()!, '已核对差异，继续编辑'));
    await act(async () => buttonIn(modal()!, '已核对差异，继续编辑').click());
    await until(() => !save().disabled);

    const release = await holdLock(RECORDS);
    const spy = settleABeforeRefusal();
    await act(async () => save().click());
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    registerA();
    release();
    await saveSettled();
    expect(ifMatches).toEqual(['4']);
    expect(document.body.textContent).not.toContain(OTHER_TAB);

    await act(async () => buttonIn(modal()!.querySelector('.ant-modal-footer')!, '取消').click());
    await until(() => !subject());
    await closeDetail();
    trimSubject = true; // 这次服务端按字段权限裁掉“调整主题”，仍允许修改申请。
    await reopenDetail();
    const before = commits.length;
    await act(async () => buttonIn(detail()!, '修改申请').click());
    await until(() => !!modal() && !save().disabled);
    // 打开编辑后内核按可提交字段改写草稿（换了条目对象），同一次命令的过期拒绝仍隐去。
    expect(commits.length).toBeGreaterThan(before);
    expect(commits.slice(before).filter((page) => page.includes(OTHER_TAB))).toEqual([]);
    expect(document.body.textContent).not.toContain(OTHER_TAB);
    // 过期竞争之后没有再发写请求（只有开头那次 409 的保存）。
    expect(ifMatches).toEqual(['4']);
  });
});

describe('AC-FE-F566 组织调整正例', () => {
  it('他页一直持锁、等锁超时（refused）：弹窗显示 DEC-954 文案，零请求、输入保留；他页关闭后可再保存', async () => {
    await render(true);
    await editSubject();
    const release = await holdLock(RECORDS);
    try {
      const spy = vi.spyOn(navigator.locks, 'request');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await act(async () => save().click());
      await vi.waitFor(() => expect(spy).toHaveBeenCalled());
      await act(() => vi.advanceTimersByTimeAsync(LOCK_WAIT_MS));
      vi.useRealTimers();
      await saveSettled();
    } catch (cause) {
      release();
      throw cause;
    }
    expect(writes).toEqual([]);
    expect(modal()?.textContent).toContain(LOCK_BUSY);
    expect(document.body.textContent).not.toContain(OTHER_TAB);
    expect(document.body.textContent).not.toContain(UNCERTAIN);
    expect(subject()?.value).toBe(SUBJECT);
    expect(save().disabled).toBe(false);

    release();
    await act(async () => save().click());
    await until(() => closed.mock.calls.length === 1);
    expect(writes).toHaveLength(1);
  });

  it('第 2 轮 P2-3 真实详情：等锁期间 A 登记同一单、B 等锁超时：显示 DEC-954 原文，零请求，A 仍可查询', async () => {
    await renderPage();
    const release = await holdLock(RECORDS);
    try {
      const spy = vi.spyOn(navigator.locks, 'request');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await act(async () => detailSubmit()!.click());
      await vi.waitFor(() => expect(spy).toHaveBeenCalled());
      registerA(); // A 在锁内登记了同一申请单，锁一直不放。
      await act(() => vi.advanceTimersByTimeAsync(LOCK_WAIT_MS));
      vi.useRealTimers();
      await until(() => !!buttonIn(detail()!, '查询结果'));
    } finally {
      vi.useRealTimers();
      release();
    }
    expect(writes).toEqual([]);
    expect(detail()!.textContent).toContain(LOCK_BUSY);
    expect(document.body.textContent).not.toContain(OTHER_TAB);
    // 槽交给 A 的待确认命令：提交仍锁着，按 A 的命令 ID 查询结果。
    expect(detailSubmit()!.disabled).toBe(true);
    await act(async () => buttonIn(detail()!, '查询结果').click());
    await until(() => !!detail()?.textContent?.includes(RESULT_FAILED));
    expect(writes).toEqual([]);
  });

  it('A 未确认时 B 提交被竞争拒绝，主动查询结果确认失败：状态区照常显示已确认失败的告警', async () => {
    await render(false);
    registerA();
    await act(async () => submitButton().click());
    await until(() => !!buttonIn(host, '查询结果'));
    expect(writes).toEqual([]);
    await act(async () => buttonIn(host, '查询结果').click());
    await until(() => !!host.textContent?.includes(RESULT_FAILED));
    expect(writes).toEqual([]);
  });

  it('单标签正常保存：发出一次、关闭弹窗，无提示、恢复记录已清', async () => {
    await render(true);
    await editSubject();
    await act(async () => save().click());
    await until(() => closed.mock.calls.length === 1);
    expect(writes).toEqual([{ method: 'PATCH', path: DETAIL_PATH, body: { subject: SUBJECT } }]);
    expect(updated).toHaveBeenCalledWith(ID);
    expect(document.body.textContent).not.toContain(OTHER_TAB);
    expect(localStorage.getItem(RECORDS)).toBeNull();
  });
});
