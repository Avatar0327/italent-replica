/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * F-026（F-024 R1 OBS-03，AC-EST-02）：HR「调动」保存时，非严格控编超出设定编制，服务端整单回滚并返回
 * 409 CONFIRMATION_REQUIRED；前端弹中文确认框（不显示英文原因码，DEC-045），确认后带 confirmed 以新命令重提，
 * 取消不发请求、保留输入。严格控编是确定的拒绝 ESTABLISHMENT_EXCEEDED，不弹框。
 * 夹具形状按后端：错误信封 errors.ts errorResponse、AppError details（employment/activation-checks.ts
 * requireEstablishmentConfirmed）、其余同 AC-FE-F504。
 */
import { randomUUID } from 'node:crypto';
import { App, ConfigProvider } from 'antd';
import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider, type Session } from '../foundation/Session.js';
import { TransferApplication } from '../self-service/shared/TransferApplication.js';

const EMPLOYEE = '26000000-0000-4000-8000-000000000001';
const DEPARTMENT = '26000000-0000-4000-8000-000000000002';
const BUSINESS = '26000000-0000-4000-8000-000000000021';
const TODAY = '2026-11-20';
const SAVE_PATH = `/api/tenant/employment/transfers/employees/${EMPLOYEE}`;
const DRAFT_PATH = `${SAVE_PATH}/draft`;
const TITLE = '已超出设定编制';
const CONTENT = '保存后目标部门的人数将超出设定编制，是否继续保存？';
const fields = ['effectiveDate', 'transferTypeCode', 'reasonCode', 'adjustSalary', 'isChangeContract'];

interface Reply {
  readonly status?: number;
  readonly body: unknown;
}
const ok = (body: unknown): Reply => ({ body });
const fail = (status: number, code: string, message: string, details?: unknown): Reply => ({
  status,
  body: { error: { code, message, ...(details === undefined ? {} : { details }) } },
});
/** 非严格控编超编：整单回滚，要求确认。 */
const needConfirm = (): Reply =>
  fail(409, 'CONFLICT', '已超出设定编制，确认后继续保存', {
    reason: 'CONFIRMATION_REQUIRED',
    warnings: [{ departmentId: DEPARTMENT, reason: 'ESTABLISHMENT_EXCEEDED' }],
  });
/** 严格控编超编：确定的拒绝，带 confirmed 也不放行。 */
const strictReject = (): Reply =>
  fail(409, 'CONFLICT', '已超出设定编制，不可继续操作', { reason: 'ESTABLISHMENT_EXCEEDED' });
const receipt = () => ({
  id: BUSINESS,
  revision: 1,
  employeeRevision: 4,
  status: 'approved',
  employeeId: EMPLOYEE,
  kind: 'transfer',
  changeType: 'position_adjustment',
  mode: 'direct',
  formId: 'hr',
  effectiveDate: TODAY,
  fields: { place: '合成工作地' },
  customFields: {},
  employeeStatus: 'employed',
  entryStatus: null,
  record: null,
  activation: null,
});
const preview = {
  employeeRevision: 3,
  allowDirectTransfer: true,
  allowedActions: { application: true, directList: true, directRow: true },
  form: {
    id: 'hr',
    name: '调动申请',
    isStandard: true,
    excludedAutofillFields: [],
    fieldModes: { 'preset:place': 'editable' },
    customFields: [],
  },
  fields: { place: '合成工作地' },
  customFields: {},
  before: { fields: { place: '原工作地' }, customFields: {} },
};

/** 按序返回的保存应答：最后一条重复使用。 */
let saves: (Reply | Promise<Reply>)[];
let posts: { body: Record<string, unknown>; key: string | null }[];
let hasDraft: boolean;
let deletes: { body: unknown; key: string | null; revision: string | null }[];
function replyOf(url: URL, method: string): Reply | Promise<Reply> {
  const path = url.pathname;
  if (path === SAVE_PATH && method === 'POST') return saves[Math.min(posts.length - 1, saves.length - 1)]!;
  if (path === `${DRAFT_PATH}/${BUSINESS}` && method === 'DELETE') {
    if (deletes.length === 1) return needConfirm();
    hasDraft = false;
    return ok({ id: BUSINESS, revision: 2, status: 'deleted' });
  }
  if (path === '/api/tenant/employment/transfers/catalog')
    return ok({
      today: TODAY,
      types: [{ code: 'transfer', name: '部门间调动', formId: 'hr' }],
      reasons: [],
      viewableFields: fields,
      editableFields: fields,
    });
  if (path === '/api/tenant/employment/employees')
    return ok({ items: [{ id: EMPLOYEE, name: '合成员工', code: 'DEMO-026', revision: 3 }] });
  if (path === `${SAVE_PATH}/preview`) return ok(preview);
  if (path === DRAFT_PATH)
    return ok({ draft: hasDraft ? { id: BUSINESS, revision: 1, transferTypeCode: 'transfer' } : null });
  if (path === `/api/tenant/employment/businesses/${BUSINESS}`) return ok({ ...receipt(), status: 'draft' });
  if (path === `/api/tenant/employment/transfers/${BUSINESS}/linkage`)
    return ok({ businessId: BUSINESS, revision: 1, options: null });
  if (path === '/api/tenant/transfer/insurance-origin')
    return ok({ regionCode: null, planId: null, companyId: null, planName: null, companyName: null });
  return ok({ items: [], hasDataPermission: true });
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  posts = [];
  hasDraft = false;
  deletes = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://local');
      const method = init.method ?? 'GET';
      if (method === 'POST' && url.pathname === SAVE_PATH)
        posts.push({
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
          key: new Headers(init.headers).get('idempotency-key'),
        });
      if (method === 'DELETE' && url.pathname === `${DRAFT_PATH}/${BUSINESS}`) {
        const headers = new Headers(init.headers);
        deletes.push({
          body: init.body ? JSON.parse(String(init.body)) : undefined,
          key: headers.get('idempotency-key'),
          revision: headers.get('if-match'),
        });
      }
      const reply = await replyOf(url, method);
      return new Response(JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
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
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

const settle = (ms = 0) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
/** 页面外壳（会话 + antd App）；离开页面时只换掉表单，App 里的确认框宿主仍在。 */
let frame: (page: ReactNode) => ReactNode;
/** 打开 HR 表单、选人并等预览（usePreview 有 200ms 防抖）。 */
async function open(mode: 'direct' | 'apply' = 'direct') {
  const tenantId = randomUUID();
  const session: Session = {
    tenantId,
    identityKey: 'synthetic-hr',
    tenantName: '合成租户',
    timezone: 'Asia/Shanghai',
    displayName: '合成 HR',
    source: 'server',
  };
  const hrForm = { mode, writable: true, onCancel: () => {} };
  const scope = JSON.stringify([tenantId, 'synthetic-hr']);
  // 关掉 antd 动效：happy-dom 里离场动画不结束，关闭后的确认框会一直留在页面上
  const theme = { token: { motion: false } };
  frame = (page) => h(SessionProvider, { session, children: h(ConfigProvider, { theme }, h(App, {}, page)) });
  await act(async () =>
    root.render(frame(h(TransferApplication, { tenantId, initiator: 'hr', hrScope: scope, hrForm }))),
  );
  await settle(20);
  await choose('employeeId', EMPLOYEE);
  await settle(260);
  expect(host.querySelector('input[name="place"]'), '预览已到达').not.toBeNull();
}
async function choose(name: string, value: string) {
  const element = host.querySelector<HTMLSelectElement>(`select[name="${name}"]`)!;
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle(20);
}
async function click(element: Element | null | undefined) {
  expect(element, '可点击的元素').toBeTruthy();
  await act(async () => (element as HTMLElement).click());
  await settle(50);
}
const button = (label: string) =>
  Array.from(host.querySelectorAll<HTMLButtonElement>('.hr-transfer-actions button')).find(
    (item) => item.textContent === label,
  );
/** 当前打开的确认框（动效已关，关闭即移出页面）。 */
const dialogs = () => Array.from(document.querySelectorAll<HTMLElement>('.ant-modal-confirm'));
const dialogButton = (primary: boolean) => {
  const kind = primary ? '.ant-btn-primary' : ':not(.ant-btn-primary)';
  return dialogs()[0]?.querySelector(`.ant-modal-confirm-btns button${kind}`);
};

const confirmed = (body: Record<string, unknown>) => ({ ...body, confirmed: true });

describe('AC-FE-F026 非严格控编超编：保存先确认，确认后带 confirmed 重提', () => {
  it('AC-FE-F026-01 409 CONFIRMATION_REQUIRED：弹中文确认框，不显示英文原因码，不报错', async () => {
    saves = [needConfirm(), ok(receipt())];
    await open();
    await click(button('保存'));
    expect(dialogs()).toHaveLength(1);
    expect(dialogs()[0]!.querySelector('.ant-modal-confirm-title')?.textContent).toBe(TITLE);
    expect(dialogs()[0]!.querySelector('.ant-modal-confirm-content')?.textContent).toBe(CONTENT);
    expect(dialogButton(true)?.textContent?.replace(/\s/g, '')).toBe('继续保存');
    expect(dialogButton(false)?.textContent?.replace(/\s/g, '')).toBe('取消');
    expect(document.body.textContent).not.toMatch(/CONFIRMATION_REQUIRED|ESTABLISHMENT_EXCEEDED/);
    // 确认框开着时保存仍在等用户决定，只有“处理中”忙碌条，没有错误提示
    expect(host.querySelector('[role="alert"]')?.textContent ?? '').not.toContain('已超出设定编制');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).not.toHaveProperty('confirmed');
  });

  it('AC-FE-F026-02 确认：带 confirmed 以新命令 ID 重提一次，其余报文不变，成功提示', async () => {
    saves = [needConfirm(), ok(receipt())];
    await open();
    await click(button('保存'));
    await click(dialogButton(true));
    await settle(50);
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toEqual(confirmed(posts[0]!.body));
    expect(posts[1]!.key).toBeTruthy();
    expect(posts[1]!.key).not.toBe(posts[0]!.key);
    expect(dialogs()).toHaveLength(0);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toBeTruthy();
  });

  it('AC-FE-F026-03 取消：不再发请求，不留错误提示，输入保留；再点保存仍从未确认开始', async () => {
    saves = [needConfirm()];
    await open();
    await click(button('保存'));
    await click(dialogButton(false));
    expect(dialogs()).toHaveLength(0);
    expect(posts).toHaveLength(1);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector<HTMLInputElement>('input[name="place"]')?.disabled).toBe(false);
    expect(button('保存')?.disabled).toBe(false);
    await click(button('保存'));
    expect(dialogs()).toHaveLength(1);
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).not.toHaveProperty('confirmed');
  });

  it('AC-FE-F026-04 严格控编 ESTABLISHMENT_EXCEEDED：不弹确认框，显示拒绝原因，不重提', async () => {
    saves = [strictReject()];
    await open();
    await click(button('保存'));
    await settle(50);
    expect(dialogs()).toHaveLength(0);
    expect(posts).toHaveLength(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('已超出设定编制');
    expect(document.body.textContent).not.toMatch(/ESTABLISHMENT_EXCEEDED/);
  });

  it('AC-FE-F026-05 带 confirmed 仍被拒：不再弹框、不循环重提', async () => {
    saves = [needConfirm(), strictReject()];
    await open();
    await click(button('保存'));
    await click(dialogButton(true));
    await settle(50);
    expect(posts).toHaveLength(2);
    expect(dialogs()).toHaveLength(0);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('已超出设定编制');
  });

  it('AC-FE-F026-06 连点保存只弹一个确认框', async () => {
    saves = [needConfirm()];
    await open();
    const target = button('保存')!;
    await act(async () => {
      target.click();
      target.click();
    });
    await settle(50);
    expect(dialogs()).toHaveLength(1);
    expect(posts).toHaveLength(1);
  });

  it('AC-FE-F026-07 保存请求在途离页，迟到的 409 不在新页面弹确认框', async () => {
    let respond!: (reply: Reply) => void;
    saves = [new Promise<Reply>((resolve) => (respond = resolve))];
    await open();
    await click(button('保存'));
    expect(posts).toHaveLength(1);
    await act(async () => root.render(frame(h('main', {}, '新页面'))));
    expect(host.textContent).toBe('新页面');
    await act(async () => respond(needConfirm()));
    await settle(50);
    expect(dialogs()).toHaveLength(0);
    expect(posts).toHaveLength(1);
  });

  it('AC-FE-F026-08 清除暂存要求超编确认，确认后同版本换命令 ID 重提', async () => {
    hasDraft = true;
    await open('apply');
    await click(host.querySelector('.transfer-link'));
    expect(dialogs()).toHaveLength(1);
    expect(dialogs()[0]?.textContent).toContain('清除暂存');
    expect(deletes).toHaveLength(1);
    await click(dialogButton(true));
    expect(deletes).toHaveLength(2);
    expect(deletes[1]).toMatchObject({ body: { confirmed: true }, revision: deletes[0]?.revision });
    expect(deletes[1]?.key).toBeTruthy();
    expect(deletes[1]?.key).not.toBe(deletes[0]?.key);
    expect(host.querySelector('.transfer-link')).toBeNull();
  });
});
