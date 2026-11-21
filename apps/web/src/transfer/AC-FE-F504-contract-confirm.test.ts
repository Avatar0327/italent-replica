/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * F-504（DEC-847，F-481 设计 §9）：HR「调动」保存、「他人调动申请」提交时，若“是否变更合同 = 是”且
 * 变更后合同的生效日期（= 调动生效日，linkage/contract.ts changeContractOnActivation）晚于原合同生效日期，
 * 先弹确认框；确认才发请求，取消不发。条件与后端 contracts/service.ts applyRequest 一致（严格晚于才终止原合同）。
 * 原合同生效日取合同模块的员工合同摘要（GET /api/tenant/contracts/employees/:id/contracts，detail.ts SUMMARY）；
 * 读不到、被字段裁剪时视为缺失，不弹。夹具形状按后端：调动候选 linkage/routes.ts registerContractChoices、
 * 写入回执 read-model（同 AC-FE-R1c 冒烟 draftBusiness）、错误信封 errors.ts errorResponse。
 */
import { randomUUID } from 'node:crypto';
import { App, ConfigProvider } from 'antd';
import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider, type Session } from '../foundation/Session.js';
import { TransferApplication } from '../self-service/shared/TransferApplication.js';
import { installWebLocks } from '../../../../tests/acceptance/support/web-locks.js';

// F-110 第 3 轮：调动 / 审批命令登记恢复记录须拿跨标签页锁，测试环境装一份 Web Locks。
installWebLocks();

const EMPLOYEE = '85040000-0000-4000-8000-000000000001';
const CONTRACT = '85040000-0000-4000-8000-000000000011';
const OLDER = '85040000-0000-4000-8000-000000000012';
const BUSINESS = '85040000-0000-4000-8000-000000000021';
const TODAY = '2026-11-20';
const TITLE = '请确认以下信息后，再继续操作';
const CONTENT = '变更后合同的生效日期晚于原合同生效日期，继续保存将终止原合同。';
const SAVE_PATH = `/api/tenant/employment/transfers/employees/${EMPLOYEE}`;
const SUMMARY_PATH = `/api/tenant/contracts/employees/${EMPLOYEE}/contracts`;
const fields = [
  'effectiveDate',
  'transferTypeCode',
  'reasonCode',
  'adjustSalary',
  'isChangeContract',
  'contractChange',
];

interface Reply {
  readonly status?: number;
  readonly body: unknown;
}
const ok = (body: unknown): Reply => ({ body });
const fail = (status: number, code: string, message: string, details?: unknown): Reply => ({
  status,
  body: { error: { code, message, ...(details === undefined ? {} : { details }) } },
});
/** 合同模块员工合同摘要的一行（contracts/detail.ts SUMMARY 列）。 */
const summary = (id: string, effectiveDate: string, status = 'valid') => ({
  id,
  employeeId: EMPLOYEE,
  number: id === CONTRACT ? 'HT-504' : 'HT-503',
  typeId: '85040000-0000-4000-8000-000000000031',
  companyId: '85040000-0000-4000-8000-000000000032',
  termType: 'fixed',
  termMonths: 36,
  signingDate: effectiveDate,
  effectiveDate,
  endDate: '2029-12-31',
  actualTerminationDate: null,
  signingCount: id === CONTRACT ? 2 : 1,
  versionNo: 1,
  rootContractId: id,
  previousContractId: null,
  status,
  terminationReason: null,
  approvalStatus: 'effective',
  revision: 3,
  createdAt: '2026-01-01T02:00:00.000Z',
});
/** POST /transfers/employees/:id 的 201 回执（新业务单；员工版本已推进）。 */
const receipt = (mode: string, status: string) => ({
  id: BUSINESS,
  revision: 1,
  employeeRevision: 4,
  status,
  employeeId: EMPLOYEE,
  kind: 'transfer',
  changeType: 'position_adjustment',
  mode,
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

let summaries: Reply;
let save: Reply;
let posts: { path: string; body: Record<string, unknown> }[];
function replyOf(url: URL, method: string): Reply {
  const path = url.pathname;
  if (path === SAVE_PATH && method === 'POST') return save;
  if (path === '/api/tenant/employment/transfers/catalog')
    return ok({
      today: TODAY,
      types: [{ code: 'transfer', name: '部门间调动', formId: 'hr' }],
      reasons: [],
      viewableFields: fields,
      editableFields: fields,
    });
  if (path === '/api/tenant/employment/employees')
    return ok({ items: [{ id: EMPLOYEE, name: '合成员工', code: 'DEMO-504', revision: 3 }] });
  if (path === `${SAVE_PATH}/preview`) return ok(preview);
  if (path === `${SAVE_PATH}/draft`) return ok({ draft: null });
  // 调动“变更的合同”候选：当前有效合同，只有 id 与编号（无编号查看权时 name 为 null）
  if (path === `${SAVE_PATH}/contracts`) return ok({ items: [{ id: CONTRACT, name: 'HT-504' }] });
  if (path === SUMMARY_PATH) return summaries;
  if (path === '/api/tenant/transfer/insurance-origin')
    return ok({ regionCode: null, planId: null, companyId: null, planName: null, companyName: null });
  return ok({ items: [], hasDataPermission: true });
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  summaries = ok({ items: [summary(CONTRACT, '2026-03-01'), summary(OLDER, '2023-03-01', 'terminated')] });
  save = { status: 201, body: receipt('direct', 'approved') };
  posts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://local');
      const method = init.method ?? 'GET';
      if (method === 'POST' && url.pathname === SAVE_PATH)
        posts.push({ path: url.pathname, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      const reply = replyOf(url, method);
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
async function open(mode: 'direct' | 'apply') {
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
async function pickDate(value: string) {
  const input = host.querySelector<HTMLInputElement>('input[name="effectiveDate"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle(260);
}
const radio = (name: string, value: boolean) =>
  host.querySelector<HTMLInputElement>(`input[name="${name}"][value="${String(value)}"]`);
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
async function changeContract() {
  await click(radio('changeContract', true));
  await choose('contractTargetId', CONTRACT);
}
const contractPayload = { targetId: CONTRACT, fields: {} };
const directBody = {
  initiator: 'hr',
  mode: 'direct',
  effectiveDate: TODAY,
  transferTypeCode: 'transfer',
  fields: {},
  customFields: {},
  formId: 'hr',
  submit: false,
  linkage: { contract: contractPayload },
};

describe('AC-FE-F504 调动保存时“终止原合同”确认框', () => {
  it('AC-FE-F504-01 调动：变更合同且调动日晚于原合同生效日，点保存先弹确认框，原文照抄，不发请求', async () => {
    await open('direct');
    await changeContract();
    await click(button('保存'));
    expect(dialogs()).toHaveLength(1);
    expect(dialogs()[0]!.querySelector('.ant-modal-confirm-title')?.textContent).toBe(TITLE);
    expect(dialogs()[0]!.querySelector('.ant-modal-confirm-content')?.textContent).toBe(CONTENT);
    expect(dialogButton(true)?.textContent?.replace(/\s/g, '')).toBe('确定');
    expect(dialogButton(false)?.textContent?.replace(/\s/g, '')).toBe('取消');
    expect(posts).toEqual([]);
  });

  it('AC-FE-F504-02 取消：不发请求，表单保持原样可继续编辑；再点保存仍先确认', async () => {
    await open('direct');
    await changeContract();
    await click(button('保存'));
    await click(dialogButton(false));
    expect(dialogs()).toHaveLength(0);
    expect(posts).toEqual([]);
    expect(radio('changeContract', true)?.checked).toBe(true);
    expect(host.querySelector<HTMLSelectElement>('select[name="contractTargetId"]')?.value).toBe(CONTRACT);
    expect(host.querySelector<HTMLInputElement>('input[name="place"]')?.disabled).toBe(false);
    expect(button('保存')?.disabled).toBe(false);
    await click(button('保存'));
    expect(dialogs()).toHaveLength(1);
    expect(posts).toEqual([]);
  });

  it('AC-FE-F504-03 确认：只发一次保存请求，报文与不弹框时相同', async () => {
    await open('direct');
    await changeContract();
    await click(button('保存'));
    await click(dialogButton(true));
    await settle(50);
    expect(posts).toEqual([{ path: SAVE_PATH, body: directBody }]);
    expect(dialogs()).toHaveLength(0);
    expect(host.querySelector('[role="status"]')?.textContent).toBeTruthy();
  });

  it('AC-FE-F504-04 他人调动申请：提交先确认，确认后按申请提交；暂存不涉及终止原合同，不弹', async () => {
    save = { status: 201, body: receipt('application', 'in_review') };
    await open('apply');
    await changeContract();
    await click(button('提交'));
    expect(dialogs()).toHaveLength(1);
    expect(dialogs()[0]!.querySelector('.ant-modal-confirm-content')?.textContent).toBe(CONTENT);
    expect(posts).toEqual([]);
    await click(dialogButton(true));
    await settle(50);
    expect(posts).toEqual([{ path: SAVE_PATH, body: { ...directBody, mode: 'application', submit: true } }]);
  });

  it('AC-FE-F504-04b 他人调动申请：暂存直接发请求，不弹确认框', async () => {
    save = { status: 201, body: receipt('application', 'draft') };
    await open('apply');
    await changeContract();
    await click(button('暂存'));
    expect(dialogs()).toHaveLength(0);
    expect(posts).toEqual([{ path: SAVE_PATH, body: { ...directBody, mode: 'application', submit: false } }]);
  });

  for (const [name, original] of [
    ['生效日相同', TODAY],
    ['原合同生效日更晚', '2026-12-01'],
  ] as const)
    it(`AC-FE-F504-05 ${name}：新合同不晚于原合同（后端作废原合同、不终止），不弹，直接保存`, async () => {
      summaries = ok({ items: [summary(CONTRACT, original)] });
      await open('direct');
      await changeContract();
      await click(button('保存'));
      expect(dialogs()).toHaveLength(0);
      expect(posts).toEqual([{ path: SAVE_PATH, body: directBody }]);
    });

  it('AC-FE-F504-05b 按表单当前调动日期判定：原合同晚于今天，改到原合同之后才弹', async () => {
    // 今天（2026-11-20）不晚于原合同，同 AC-FE-F504-05 不弹；改调动日期后按新日期判定
    summaries = ok({ items: [summary(CONTRACT, '2026-11-25')] });
    await open('direct');
    await changeContract();
    await pickDate('2026-12-01');
    expect(host.querySelector<HTMLSelectElement>('select[name="contractTargetId"]')?.value).toBe(CONTRACT);
    await click(button('保存'));
    expect(dialogs()).toHaveLength(1);
    expect(posts).toEqual([]);
    await click(dialogButton(true));
    await settle(50);
    expect(posts).toEqual([{ path: SAVE_PATH, body: { ...directBody, effectiveDate: '2026-12-01' } }]);
  });

  it('AC-FE-F504-06 不变更合同（选过合同后改回“否”）：不弹，报文不带合同', async () => {
    await open('direct');
    await changeContract();
    await click(radio('changeContract', false));
    await click(button('保存'));
    expect(dialogs()).toHaveLength(0);
    const { linkage: _linkage, ...body } = directBody;
    expect(posts).toEqual([{ path: SAVE_PATH, body }]);
  });

  for (const [name, reply] of [
    ['合同摘要无权读取（403）', fail(403, 'FORBIDDEN', '无权访问')],
    ['合同摘要超上限（413）', fail(413, 'PAYLOAD_TOO_LARGE', '员工合同数超过单次返回上限')],
    ['生效日期被字段裁剪', ok({ items: [{ id: CONTRACT, number: 'HT-504', status: 'valid' }] })],
    ['摘要里没有所选合同', ok({ items: [summary(OLDER, '2023-03-01', 'terminated')] })],
    ['生效日期不是业务日期', ok({ items: [summary(CONTRACT, '2026/03/01')] })],
  ] as const)
    it(`AC-FE-F504-07 缺原合同生效日（${name}）：不弹，直接保存`, async () => {
      summaries = reply;
      await open('direct');
      await changeContract();
      await click(button('保存'));
      expect(dialogs()).toHaveLength(0);
      expect(posts).toEqual([{ path: SAVE_PATH, body: directBody }]);
    });

  it('AC-FE-F504-07b 变更合同但未选合同：不弹（报文本就不带合同）', async () => {
    await open('direct');
    await click(radio('changeContract', true));
    await click(button('保存'));
    expect(dialogs()).toHaveLength(0);
    const { linkage: _linkage, ...body } = directBody;
    expect(posts).toEqual([{ path: SAVE_PATH, body }]);
  });

  it('AC-FE-F504-08 确认后被拒（400）：按现有错误提示显示，保留输入，不再弹框、不自动重提', async () => {
    save = fail(400, 'VALIDATION_FAILED', '合成拒绝：合同终止日期须晚于生效日期');
    await open('direct');
    await changeContract();
    await click(button('保存'));
    await click(dialogButton(true));
    await settle(100);
    expect(posts).toHaveLength(1);
    expect(dialogs()).toHaveLength(0);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('合成拒绝');
    expect(radio('changeContract', true)?.checked).toBe(true);
    expect(host.querySelector<HTMLSelectElement>('select[name="contractTargetId"]')?.value).toBe(CONTRACT);
  });

  it('AC-FE-F504-08b 确认后版本冲突（409）：走现有冲突重读提示，不再弹框、不自动重提', async () => {
    save = fail(409, 'REVISION_CONFLICT', '版本冲突', { expected: 3 });
    await open('direct');
    await changeContract();
    await click(button('保存'));
    await click(dialogButton(true));
    await settle(100);
    expect(posts).toHaveLength(1);
    expect(dialogs()).toHaveLength(0);
    expect(host.textContent).toContain('版本冲突：输入已保留，请重读最新版本并核对差异后重提。');
  });

  it('AC-FE-F504-09 连点保存只弹一个确认框', async () => {
    await open('direct');
    await changeContract();
    const target = button('保存')!;
    await act(async () => {
      target.click();
      target.click();
    });
    await settle(50);
    expect(dialogs()).toHaveLength(1);
    await click(dialogButton(true));
    await settle(50);
    expect(posts).toHaveLength(1);
  });

  it('AC-FE-F504-10 确认框开着时离开页面：确认框随之关闭，不发请求', async () => {
    await open('direct');
    await changeContract();
    await click(button('保存'));
    expect(dialogs()).toHaveLength(1);
    await act(async () => root.render(frame(h('p', {}, '其他页面'))));
    await settle(50);
    expect(dialogs()).toHaveLength(0);
    expect(posts).toEqual([]);
  });
});
