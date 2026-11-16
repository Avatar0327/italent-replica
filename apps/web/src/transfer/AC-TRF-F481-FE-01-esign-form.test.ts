/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * AC-TRF-F481-FE-01（F-481 设计 §8.1、§12）：HR「调动」「他人调动申请」的合同变更段——
 * 选“是否变更合同 = 是”后出现“发起电子文件签署”（无默认）；选“是”出现必填多选与全选；切回“否”两项清空；
 * 无模板时提示并不能提交“是”；提交报文 `linkage.esign.templateIds` 与所选一致。
 * 夹具形状按后端：模板选项 esign/routes.ts `GET /template-options/transfer-form`（{ items: [{ id, name }] }），
 * 保存回执同 AC-FE-F504；联动详情 transfer/linkage/view.ts（esign 仅在两字段都可见时出现）。
 */
import { randomUUID } from 'node:crypto';
import { App, ConfigProvider } from 'antd';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider, type Session } from '../foundation/Session.js';
import { TransferApplication } from '../self-service/shared/TransferApplication.js';
import { LinkagePanel } from './LinkagePanel.js';
import type { LinkageView } from './types.js';

const EMPLOYEE = '84810000-0000-4000-8000-000000000001';
const CONTRACT = '84810000-0000-4000-8000-000000000011';
const BUSINESS = '84810000-0000-4000-8000-000000000021';
const T1 = '84810000-0000-4000-8000-000000000101';
const T2 = '84810000-0000-4000-8000-000000000102';
const TODAY = '2026-11-20';
const SAVE_PATH = `/api/tenant/employment/transfers/employees/${EMPLOYEE}`;
const OPTIONS_PATH = '/api/tenant/esign/template-options/transfer-form';
const EMPTY_HINT = '暂无可用的签署模板，请先在 电子签 > 设置 > 签署模板 中维护';
const baseFields = ['effectiveDate', 'transferTypeCode', 'reasonCode', 'isChangeContract', 'contractChange'];
const esignFields = ['electronicSignature', 'esignTemplateIds'];

interface Reply {
  readonly status?: number;
  readonly body: unknown;
}
const ok = (body: unknown): Reply => ({ body });
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

let viewable: string[];
let editable: string[];
let options: Reply;
let save: Reply;
let posts: Record<string, unknown>[];
let optionReads: number;
function replyOf(url: URL, method: string): Reply {
  const path = url.pathname;
  if (path === SAVE_PATH && method === 'POST') return save;
  if (path === OPTIONS_PATH) {
    optionReads += 1;
    return options;
  }
  if (path === '/api/tenant/employment/transfers/catalog')
    return ok({
      today: TODAY,
      types: [{ code: 'transfer', name: '部门间调动', formId: 'hr' }],
      reasons: [],
      viewableFields: viewable,
      editableFields: editable,
    });
  if (path === '/api/tenant/employment/employees')
    return ok({ items: [{ id: EMPLOYEE, name: '合成员工', code: 'DEMO-481', revision: 3 }] });
  if (path === `${SAVE_PATH}/preview`) return ok(preview);
  if (path === `${SAVE_PATH}/draft`) return ok({ draft: null });
  if (path === `${SAVE_PATH}/contracts`) return ok({ items: [{ id: CONTRACT, name: 'HT-481' }] });
  if (path === '/api/tenant/transfer/insurance-origin')
    return ok({ regionCode: null, planId: null, companyId: null, planName: null, companyName: null });
  return ok({ items: [], hasDataPermission: true });
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  viewable = [...baseFields, ...esignFields];
  editable = [...baseFields, ...esignFields];
  options = ok({
    items: [
      { id: T1, name: '合成调动协议' },
      { id: T2, name: '合成保密协议' },
    ],
  });
  save = { status: 201, body: receipt('direct', 'approved') };
  posts = [];
  optionReads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://local');
      const method = init.method ?? 'GET';
      if (method === 'POST' && url.pathname === SAVE_PATH)
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
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
  const theme = { token: { motion: false } };
  const page = h(TransferApplication, { tenantId, initiator: 'hr', hrScope: scope, hrForm });
  await act(async () =>
    root.render(h(SessionProvider, { session, children: h(ConfigProvider, { theme }, h(App, {}, page)) })),
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
const radio = (name: string, value: boolean) =>
  host.querySelector<HTMLInputElement>(`input[name="${name}"][value="${String(value)}"]`);
const templates = () => host.querySelector<HTMLSelectElement>('select[name="esignTemplateIds"]');
const selectAll = () => host.querySelector<HTMLInputElement>('input[name="esignTemplateAll"]');
const button = (label: string) =>
  Array.from(host.querySelectorAll<HTMLButtonElement>('.hr-transfer-actions button')).find(
    (item) => item.textContent === label,
  );
const contractSection = () => host.querySelector<HTMLElement>('#hr-transfer-contract')!;
async function pick(...ids: string[]) {
  const element = templates()!;
  await act(async () => {
    for (const option of Array.from(element.options)) option.selected = ids.includes(option.value);
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle(20);
}
async function changeContract() {
  await click(radio('changeContract', true));
  await choose('contractTargetId', CONTRACT);
}
async function signWith(...ids: string[]) {
  await changeContract();
  await click(radio('electronicSignature', true));
  if (ids.length) await pick(...ids);
}
const contract = { targetId: CONTRACT, fields: {} };
const directBody = (linkage: Record<string, unknown>) => ({
  initiator: 'hr',
  mode: 'direct',
  effectiveDate: TODAY,
  transferTypeCode: 'transfer',
  fields: {},
  customFields: {},
  formId: 'hr',
  submit: false,
  linkage,
});

describe('AC-TRF-F481-FE-01 调动表单合同段：发起电子文件签署与签署模板', () => {
  it('FE-01-01 合同段不再显示“接口暂不支持”；变更合同 = 是后才出现“发起电子文件签署”，是 / 否都不预选', async () => {
    await open();
    expect(contractSection().textContent).not.toContain('接口暂不支持');
    expect(radio('electronicSignature', true)).toBeNull();
    await changeContract();
    expect(contractSection().textContent).toContain('发起电子文件签署');
    expect(radio('electronicSignature', true)?.checked).toBe(false);
    expect(radio('electronicSignature', false)?.checked).toBe(false);
    expect(templates()).toBeNull();
  });

  it('FE-01-02 选“是”出现必填“选择电子签署模板”多选；未选模板不能保存；选一份后报文 esign.templateIds 一致', async () => {
    await open();
    await signWith();
    expect(contractSection().textContent).toContain('*选择电子签署模板');
    expect(templates()?.multiple).toBe(true);
    expect(Array.from(templates()!.options, (option) => option.textContent)).toEqual(['合成调动协议', '合成保密协议']);
    expect(button('保存')?.disabled).toBe(true);
    await pick(T2);
    expect(button('保存')?.disabled).toBe(false);
    await click(button('保存'));
    expect(posts).toEqual([directBody({ contract, esign: { templateIds: [T2] } })]);
  });

  it('FE-01-03 全选：选中全部模板并按下拉顺序提交；再点全选取消全部', async () => {
    await open();
    await signWith();
    await click(selectAll());
    expect(Array.from(templates()!.selectedOptions, (option) => option.value)).toEqual([T1, T2]);
    await click(selectAll());
    expect(templates()!.selectedOptions).toHaveLength(0);
    await click(selectAll());
    await click(button('保存'));
    expect(posts).toEqual([directBody({ contract, esign: { templateIds: [T1, T2] } })]);
  });

  it('FE-01-04 发起电子文件签署切回“否”：模板清空并隐藏，报文不带 esign；再选“是”模板仍为空', async () => {
    await open();
    await signWith(T1);
    await click(radio('electronicSignature', false));
    expect(templates()).toBeNull();
    await click(radio('electronicSignature', true));
    expect(templates()!.selectedOptions).toHaveLength(0);
    await click(radio('electronicSignature', false));
    await click(button('保存'));
    expect(posts).toEqual([directBody({ contract })]);
  });

  it('FE-01-05 是否变更合同切回“否”：两项清空并隐藏；再选“是”时“发起电子文件签署”仍无默认', async () => {
    await open();
    await signWith(T1);
    await click(radio('changeContract', false));
    expect(radio('electronicSignature', true)).toBeNull();
    expect(templates()).toBeNull();
    await click(radio('changeContract', true));
    expect(radio('electronicSignature', true)?.checked).toBe(false);
    expect(radio('electronicSignature', false)?.checked).toBe(false);
    expect(templates()).toBeNull();
  });

  it('FE-01-06 没有可用模板：选“是”后提示去设置维护，不能保存；改选“否”可保存且不带 esign', async () => {
    options = ok({ items: [] });
    await open();
    await signWith();
    expect(contractSection().textContent).toContain(EMPTY_HINT);
    expect(button('保存')?.disabled).toBe(true);
    await click(radio('electronicSignature', false));
    expect(button('保存')?.disabled).toBe(false);
    await click(button('保存'));
    expect(posts).toEqual([directBody({ contract })]);
  });

  it('FE-01-07 模板选项读取失败：给出中文原因，不能提交“是”', async () => {
    options = { status: 403, body: { error: { code: 'FORBIDDEN', message: '无权读取签署模板' } } };
    await open();
    await signWith();
    expect(contractSection().textContent).toContain('无权读取签署模板');
    expect(button('保存')?.disabled).toBe(true);
    expect(posts).toEqual([]);
  });

  it('FE-01-08 他人调动申请：提交报文同样带 esign.templateIds', async () => {
    save = { status: 201, body: receipt('application', 'in_review') };
    await open('apply');
    await signWith(T1);
    await click(button('提交'));
    expect(posts).toEqual([
      { ...directBody({ contract, esign: { templateIds: [T1] } }), mode: 'application', submit: true },
    ]);
  });

  it('FE-01-09 字段权：两项任一不可见则整段不显示、不读模板；不可编辑时只读', async () => {
    viewable = [...baseFields, 'electronicSignature'];
    await open();
    await changeContract();
    expect(contractSection().textContent).not.toContain('发起电子文件签署');
    expect(optionReads).toBe(0);
    await act(() => root.unmount());
    root = createRoot(host);
    viewable = [...baseFields, ...esignFields];
    editable = [...baseFields];
    await open();
    await changeContract();
    expect(radio('electronicSignature', true)?.closest('fieldset')?.disabled).toBe(true);
  });
});

// 后端 linkage 视图的 esign 键（S2，transfer linkage-view）：null = 否；两字段任一不可见时键缺席。
type EsignView = { templates: { id: string; name: string | null; available: boolean }[] } | null;
const view = (esign?: EsignView): LinkageView => ({
  businessId: BUSINESS,
  executedAt: null,
  contract: null,
  onTrial: null,
  handover: null,
  salaryReminder: null,
  dutyTransfer: null,
  partTimes: [],
  ...(esign === undefined ? {} : { esign }),
});
async function panel(value: LinkageView) {
  await act(async () => root.render(h(LinkagePanel, { view: value })));
}

describe('AC-TRF-F481-FE-01 调动详情只读：发起电子文件签署与模板名称', () => {
  it('FE-01-10 “是”时列出模板名称；停用的模板标注；名称不可读时不显示裸 ID', async () => {
    await panel(
      view({
        templates: [
          { id: T1, name: '合成调动协议', available: true },
          { id: T2, name: '合成保密协议', available: false },
          { id: BUSINESS, name: null, available: false },
        ],
      }),
    );
    expect(host.textContent).toContain('发起电子文件签署：是');
    expect(host.textContent).toContain('合成调动协议');
    expect(host.textContent).toContain('合成保密协议（已停用）');
    expect(host.textContent).not.toContain(BUSINESS);
    expect(host.textContent).not.toContain(T1);
  });

  it('FE-01-11 null 表示“否”；两字段不可见（键缺席）时整行不显示', async () => {
    await panel(view(null));
    expect(host.textContent).toContain('发起电子文件签署：否');
    await panel(view(undefined));
    expect(host.textContent).not.toContain('发起电子文件签署');
  });
});
