/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * AC-FE-F566（F-562 卡外遗留，DEC-954）组织调整：编辑弹窗与详情状态区只显示内核 refused 带出的本次拒绝。
 * 登记冲突、而占槽命令在本页处理拒绝前已落定时，内核不带 race 也不带 refused（store.ts submitTo），
 * CommandStatus 不能残留“其他标签页有该对象未确认的命令”；真正的等锁超时（refused）仍显示 DEC-954 文案。
 * 挂真实编辑弹窗（ApplicationForm → FormOverlay → CommandStatus）与详情状态区的同款接法（AdjustmentDetail：
 * 非编辑时 CommandStatus + act 吞错），每次 DOM 提交后记下页面文字。A 的登记做法同 AC-FE-F562。期望值手写。
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
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { CommandStatus } = await import(resolve('apps/web/src/foundation/forms/CommandStatus.tsx'));
const { ApplicationForm } = await import(resolve('apps/web/src/org-adjustment/ApplicationForm.tsx'));
const { useAdjustmentCommand } = await import(resolve('apps/web/src/org-adjustment/commands.ts'));

const RECORDS = 'italent.commands.pending:org-adjustment';
const ID = '85660000-0000-4000-8000-000000000001';
const ORG = '85660000-0000-4000-8000-0000000000a1';
const DETAIL_PATH = `/api/tenant/org-adjustment/adjustments/${ID}`;
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
// 写接口回执（routes.ts headCommand → AdjustmentView）：同一申请单、版本推进过 If-Match 4。
const receipt = (status: number) => ({
  id: ID,
  code: 'OA-566',
  subject: SUBJECT,
  effectiveDate: '2026-12-01',
  approvalSubjectOrgId: ORG,
  adjustmentRange: [ORG],
  approvalStatus: status,
  revision: 5,
});
const access = {
  field: () => ({ visible: true, editable: true }),
  add: true,
  edit: true,
  void: true,
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let writes: { method: string; path: string; body: unknown }[];
/** 每次 DOM 提交后的页面文字（含弹窗与 CommandStatus），用来证明中途也没渲染过旧告警。 */
let commits: string[];
let tenantId: string;
const updated = vi.fn();
const closed = vi.fn();

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  writes = [];
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
        return Response.json(receipt(method === 'PATCH' ? 0 : 1));
      }
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
