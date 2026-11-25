/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * AC-FE-F570（F-566 卡外遗留）组织调整：提交前同步就锁到别页未确认命令时，内核按恢复态出口返回
 * “结果未知 + race”，result.error 为空（store.ts submitTo isLocked(existing) 分支）。接入层须按 race 给出
 * “其他标签页”的具体提示（同 F-558 / F-562 / F-566 口径），不能退成通用“结果尚未确认”；只有结果未知、没有 race 时仍提示结果未知。
 * 挂真实编辑弹窗（ApplicationForm → FormOverlay）与真实列表页详情（AdjustmentPage → AdjustmentDetail 状态区）。
 * A 的登记做法同 AC-FE-F566（锁外直接写共用记录：同一文档里没有 storage 事件，B 提交时内核同步载入）。期望值手写。
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installWebLocks } from './support/web-locks.js';

installWebLocks();
const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { MemoryRouter } = requireWeb('react-router');
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { PermissionsProvider } = await import(resolve('apps/web/src/foundation/Permissions.tsx'));
const { AdjustmentPage } = await import(resolve('apps/web/src/org-adjustment/AdjustmentPage.tsx'));
const { ApplicationForm } = await import(resolve('apps/web/src/org-adjustment/ApplicationForm.tsx'));
const { useAdjustmentCommand } = await import(resolve('apps/web/src/org-adjustment/commands.ts'));
const { createFormStore } = await import(resolve('apps/web/src/foundation/forms/store.ts'));
const { sharedRecovery } = await import(resolve('apps/web/src/foundation/forms/recovery.ts'));

const RECORDS = 'italent.commands.pending:org-adjustment';
const ID = '85700000-0000-4000-8000-000000000001';
const ORG = '85700000-0000-4000-8000-0000000000a1';
const COLLECTION = '/api/tenant/org-adjustment/adjustments';
const DETAIL_PATH = `${COLLECTION}/${ID}`;
const SUBMIT_PATH = `${DETAIL_PATH}/submit`;
const OBJECT = 'TenantBase.OrganizationApproval';
const COMMAND_A = 'synthetic-command-a';
const OTHER_TAB = '其他标签页有该对象未确认的命令，本次命令未发出；请等待结果或先查询结果。';
const UNCERTAIN = '结果尚未确认，请先回查记录，勿重复提交';
const UNKNOWN = '处理中 / 结果待确认。当前表单已锁定，请勿重新创建命令。';
const RESULT_FAILED = '已确认原命令未执行成功，输入已保留，请核对后重新提交。';
const SUBJECT = '合成调整主题（改）';

// 与 GET /api/tenant/org-adjustment/adjustments/:id 同形（detail.ts readDetail）：本人暂存的申请单。
const row = {
  id: ID,
  code: 'OA-570',
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
// GET /api/tenant/permission/me/objects/:code（权限快照对象明细）：本人可编辑、提交暂存单。
const objectPermission = {
  objectCode: OBJECT,
  dataOperations: { read: true, create: true, update: true },
  viewableFields: ['subject', 'effectiveDate', 'approvalSubjectOrgId', 'adjustmentRange', 'content'],
  editableFields: ['subject', 'effectiveDate', 'approvalSubjectOrgId', 'adjustmentRange', 'content'],
  buttons: [{ buttonCode: 'EditAdjustOrgDetailBtn', level: 'detail' }],
};
const access = { field: () => ({ visible: true, editable: true }), add: true, edit: true, void: true };

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let writes: { method: string; path: string }[];
/** 写请求断网（client.ts 映射为 NETWORK_ERROR，内核判为结果未知、不带 race）。 */
let offline: boolean;
let tenantId: string;
const updated = vi.fn();
const closed = vi.fn();

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  writes = [];
  offline = false;
  tenantId = randomUUID();
  updated.mockClear();
  closed.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const path = new URL(String(input), 'http://local').pathname;
      const method = init.method ?? 'GET';
      if ((method === 'PATCH' && path === DETAIL_PATH) || (method === 'POST' && path === SUBMIT_PATH)) {
        writes.push({ method, path });
        if (offline) throw new TypeError('Failed to fetch');
        // 写接口回执（routes.ts headCommand → AdjustmentView）：同一申请单、版本推进过 If-Match。
        return Response.json({ id: ID, code: 'OA-570', subject: SUBJECT, revision: row.revision + 1 });
      }
      if (method === 'GET' && path === DETAIL_PATH) return Response.json(row);
      if (method === 'GET' && path === COLLECTION) return Response.json({ items: [row], total: 1 });
      if (path === '/api/tenant/permission/me/snapshot')
        return Response.json({ session: serverSession(), apps: [], scope: [], adminMenus: [] });
      if (path === `/api/tenant/permission/me/objects/${OBJECT}`) return Response.json(objectPermission);
      // GET /api/tenant/commands/:commandId/result（F-120 返回结构）：A 的命令已确认执行失败。
      if (path === `/api/tenant/commands/${COMMAND_A}/result`)
        return Response.json({
          commandId: COMMAND_A,
          status: 'failed',
          commandType: 'POST /api/tenant/org-adjustment/adjustments/:id/submit',
          businessType: 'org_adjustment',
          businessId: null,
          revision: null,
          httpStatus: 422,
          completedAt: '2026-11-25T08:00:00.000Z',
        });
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

const serverSession = () => ({
  tenantId,
  userId: 'synthetic-user',
  tenantName: '合成租户',
  timezone: 'Asia/Shanghai',
  displayName: '合成用户',
});
const session = () => ({ tenantId, identityKey: 'synthetic-user', displayName: '合成用户', source: 'server' });
const scoped = (name: string) => JSON.stringify([tenantId, 'synthetic-user', name]);
/** 别的标签页 A 已登记同一申请单的命令（结果未知，占着本条目）。 */
const registerA = () =>
  localStorage.setItem(
    RECORDS,
    JSON.stringify([{ key: scoped(DETAIL_PATH), slots: [scoped(DETAIL_PATH)], commandId: COMMAND_A, revision: 4 }]),
  );
/** A 收到回执、删掉记录，B 收到 storage 事件。 */
function settleA() {
  localStorage.removeItem(RECORDS);
  window.dispatchEvent(new StorageEvent('storage', { key: RECORDS }));
}

/** 编辑弹窗：真实 ApplicationForm（FormOverlay：CommandStatus + 表单提示区）。 */
function Editor() {
  const command = useAdjustmentCommand(row, updated, access);
  return h(ApplicationForm, { row, command, onClose: closed });
}
async function renderEditor() {
  await act(async () => root.render(h(SessionProvider, { session: session() }, h(Editor))));
}
/** 挂真实列表页（AdjustmentPage → AdjustmentDetail 抽屉）并直接打开本单详情，等“提交审批”可点。 */
async function renderPage() {
  await act(async () =>
    root.render(
      h(
        SessionProvider,
        { session: session() },
        h(
          PermissionsProvider,
          null,
          h(MemoryRouter, { initialEntries: [`/org/adjustments?id=${ID}`] }, h(AdjustmentPage)),
        ),
      ),
    ),
  );
  await until(() => !!detailSubmit() && !detailSubmit()!.disabled);
}
const buttonIn = (scope: ParentNode, label: string) =>
  Array.from(scope.querySelectorAll('button')).find((item) => item.textContent?.replace(/\s/g, '') === label) as
    HTMLButtonElement | undefined;
const modal = () => document.querySelector('.ant-modal') as HTMLElement | null;
const subject = () => modal()?.querySelector('input[aria-label="调整主题"]') as HTMLInputElement | null;
const save = () => buttonIn(modal()!.querySelector('.ant-modal-footer')!, '保存')!;
const detail = () => document.querySelector('.oa-detail') as HTMLElement | null;
const detailSubmit = () => (detail() ? buttonIn(detail()!, '提交审批') : undefined);
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

describe('AC-FE-F570 组织调整：恢复态 race 随结果未知返回', () => {
  it('前提（内核恢复态出口）：A 已登记时 B 提交，结果是“结果未知 + race”，error 为空、零发出', async () => {
    const name = `f570-${randomUUID()}`;
    const key = scoped(DETAIL_PATH);
    localStorage.setItem(
      `italent.commands.pending:${name}`,
      JSON.stringify([{ key, slots: [key], commandId: COMMAND_A, revision: 4 }]),
    );
    const store = createFormStore({ recovery: sharedRecovery(name, { requireLocks: false }) });
    const send = vi.fn(async () => ({ id: ID }));
    const outcome = await store.submit(key, { values: {}, baseline: {}, editableFields: [], revision: 4, send }, [key]);
    expect(outcome).toMatchObject({
      status: 'unknown',
      restored: true,
      race: { reason: OTHER_TAB, commandId: COMMAND_A },
    });
    expect(outcome.error).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it('编辑弹窗：B 保存锁到 A 的命令，零写请求，提示其他标签页而不是通用“结果尚未确认”，弹窗锁定、输入保留', async () => {
    await renderEditor();
    await editSubject();
    registerA();
    await act(async () => save().click());
    await saveSettled();
    expect(writes).toEqual([]);
    expect(modal()!.textContent).toContain(OTHER_TAB);
    expect(modal()!.textContent).not.toContain(UNCERTAIN);
    // 锁到 A 的命令：只能按原命令查询结果，不能另起命令。
    expect(save().disabled).toBe(true);
    expect(buttonIn(modal()!, '查询结果')).toBeTruthy();
    expect(subject()?.value).toBe(SUBJECT);
    expect(closed).not.toHaveBeenCalled();
  });

  it('真实详情：B 提交审批锁到 A 的命令，状态区提示其他标签页；按 A 的命令查询确认失败后提示随之消失', async () => {
    await renderPage();
    registerA();
    await act(async () => detailSubmit()!.click());
    await until(() => !!buttonIn(detail()!, '查询结果'));
    expect(writes).toEqual([]);
    expect(detail()!.textContent).toContain(OTHER_TAB);
    expect(detailSubmit()!.disabled).toBe(true);
    await act(async () => buttonIn(detail()!, '查询结果')!.click());
    await until(() => !!detail()?.textContent?.includes(RESULT_FAILED));
    expect(detail()!.textContent).not.toContain(OTHER_TAB);
    expect(writes).toEqual([]);
  });

  it('真实详情：A 落定（记录删掉 + storage 事件）后提示消失、解锁，B 再提交照常发出一次', async () => {
    await renderPage();
    registerA();
    await act(async () => detailSubmit()!.click());
    await until(() => !!detail()?.textContent?.includes(OTHER_TAB));
    await act(async () => settleA());
    await until(() => !detailSubmit()!.disabled);
    expect(detail()!.textContent).not.toContain(OTHER_TAB);
    await act(async () => detailSubmit()!.click());
    await until(() => writes.length === 1 && !detail()?.textContent?.includes(UNKNOWN));
    expect(writes).toEqual([{ method: 'POST', path: SUBMIT_PATH }]);
    expect(document.body.textContent).not.toContain(OTHER_TAB);
  });

  it('正例：只有结果未知、没有 race（本页命令断网）：弹窗仍提示结果未知，不提示其他标签页', async () => {
    offline = true;
    await renderEditor();
    await editSubject();
    await act(async () => save().click());
    await until(() => !!modal()?.textContent?.includes(UNKNOWN));
    expect(writes).toEqual([{ method: 'PATCH', path: DETAIL_PATH }]);
    expect(document.body.textContent).not.toContain(OTHER_TAB);
    expect(save().disabled).toBe(true);
  });

  it('正例：只有结果未知、没有 race（本页命令断网）：详情状态区仍提示结果未知，不提示其他标签页', async () => {
    offline = true;
    await renderPage();
    await act(async () => detailSubmit()!.click());
    await until(() => !!detail()?.textContent?.includes(UNKNOWN));
    expect(writes).toEqual([{ method: 'POST', path: SUBMIT_PATH }]);
    expect(document.body.textContent).not.toContain(OTHER_TAB);
    expect(detailSubmit()!.disabled).toBe(true);
  });
});
