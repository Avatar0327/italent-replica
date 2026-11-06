// @vitest-environment happy-dom
// AC-DM-30-19（对应设计 AC-DM-30-13；该编号已被 F-139a 后端占用）：历史离职人员导入的前端。
// 渲染真实离职列表页 + F-123 内核，只替换权限快照与网络；回执形态见 smoke/exit-import-fixtures.ts。
// docs/08_设计/F-139_历史离职人员导入_设计.md §2、§9.3（确认后换新键）、§10、§12 AC-DM-30-13。
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { App } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExitPage } from './ExitPage.js';
import { SessionProvider } from '../foundation/Session.js';
import { uniqueSuffix } from '../../../../tests/acceptance/support/unique.js';
import {
  buildXlsx,
  confirmationRequired,
  importReceipt,
  importRows,
  importSheet,
  previewFailed,
  previewWarned,
} from '../../smoke/exit-import-fixtures.js';

const EXITS = '/api/tenant/employment/exits';
const ENTRY = '导入历史离职人员';
const access = vi.hoisted(() => ({ buttons: [] as { buttonCode: string; level: string }[] }));
vi.mock('../foundation/Permissions.js', () => ({
  usePermissions: () => ({
    snapshot: {
      objects: {
        'TenantBase.EmploymentRecord': {
          objectCode: 'TenantBase.EmploymentRecord',
          dataOperations: { view: true, create: true },
          viewableFields: [],
          editableFields: [],
          buttons: access.buttons,
        },
      },
    },
    field: () => ({ visible: false, editable: false }),
  }),
}));
vi.mock('../foundation/DecisionNote.js', () => ({ DecisionNote: () => null }));

type Call = { method: string; path: string; body?: Record<string, unknown>; key: string | null };
let host: HTMLDivElement;
let root: Root;
let calls: Call[];
let preview: (rows: { rowNo: number }[]) => unknown;
let confirmed: boolean;
const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
};
const list = { items: [], total: 0, page: 1, pageSize: 30, hasDataPermission: true };

async function render() {
  const session = {
    tenantId: 'synthetic-tenant',
    identityKey: uniqueSuffix(),
    tenantName: '合成租户',
    timezone: 'Asia/Shanghai',
    displayName: '合成管理员',
    source: 'server' as const,
  };
  await act(async () =>
    root.render(
      h(SessionProvider, {
        session,
        children: h(App, null, h(MemoryRouter, { initialEntries: ['/exits'] }, h(ExitPage))),
      }),
    ),
  );
  await settle();
}
const buttons = () => [...document.body.querySelectorAll('button')];
const button = (text: string) => buttons().find((node) => node.textContent?.replace(/\s/g, '') === text);
async function click(text: string) {
  const target = button(text);
  expect(target, `应存在操作：${text}`).toBeDefined();
  await act(async () => target!.click());
  await settle();
}
async function upload() {
  const input = document.body.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input, '应有文件选择框').not.toBeNull();
  const file = new File([await buildXlsx(importSheet)], '历史离职.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => input!.dispatchEvent(new Event('change', { bubbles: true })));
  await settle();
}
const writes = () => calls.filter((call) => call.method === 'POST');
const headerTexts = () =>
  [...document.body.querySelectorAll('.ant-modal th')].map((node) => node.textContent ?? '').filter(Boolean);

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  access.buttons = [{ buttonCode: 'Employment.DimissionImport', level: 'list' }];
  calls = [];
  preview = previewWarned;
  confirmed = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path, body, key: new Headers(init?.headers).get('idempotency-key') });
    const rows = (body?.rows ?? []) as { rowNo: number }[];
    if (method === 'POST' && path === `${EXITS}/import/preview`) return Response.json(preview(rows));
    if (method === 'POST' && path === `${EXITS}/import`) {
      if (body?.confirmed !== true) return Response.json(confirmationRequired(rows), { status: 409 });
      confirmed = true;
      return Response.json(importReceipt(rows), { status: 201 });
    }
    if (path.startsWith(`${EXITS}?`)) return Response.json(list);
    return Response.json({ items: [] });
  });
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AC-DM-30-19 历史离职人员导入（对应设计 AC-DM-30-13）', () => {
  it('没有 Employment.DimissionImport 按钮时不显示入口，也不发导入请求', async () => {
    access.buttons = [{ buttonCode: 'Employment.DimissionDirect', level: 'detail' }];
    await render();
    expect(button(ENTRY)).toBeUndefined();
    expect(writes()).toEqual([]);
  });

  it('上传 Excel → 预览逐行结果 → 超编确认 → 换新键带 confirmed 导入 → 切到已完成并刷新', async () => {
    await render();
    await click(ENTRY);
    await upload();
    // 预览：rowNo = Excel 行号；日期序列号转成 YYYY-MM-DD，加黑原因中文名转成编码
    expect(writes().map((call) => call.path)).toEqual([`${EXITS}/import/preview`]);
    expect(writes()[0]!.body).toEqual({ rows: importRows });
    expect(headerTexts()).toEqual(['Excel 行号', '工号', '姓名', '校验结果', '说明']);
    const text = document.body.querySelector('.ant-modal')?.textContent ?? '';
    expect(text).toContain('共 2 行：通过 2 行，不通过 0 行，有超编提示 1 行');
    expect(text).toContain('2023-04-01 至 2025-08-01 超出编制（峰值 6，编制 5）');

    await click('导入');
    // 第一次导入不带确认，后端要求确认（409 CONFIRMATION_REQUIRED）后弹 DEC-258 确认框
    expect(writes()).toHaveLength(2);
    expect(writes()[1]!.body).toEqual({ rows: importRows });
    expect(document.body.textContent).toContain('导入后将超出设定编制，请确认');
    const before = calls.length;
    await click('确定');

    const [check, first, second] = writes();
    expect(writes()).toHaveLength(3);
    expect(second!.path).toBe(`${EXITS}/import`);
    expect(second!.body).toEqual({ rows: importRows, confirmed: true });
    // 设计 §9.3：confirmed 属于请求内容，确认后重提必须换新的 Idempotency-Key
    expect(second!.key).toBeTruthy();
    expect(second!.key).not.toBe(first!.key);
    expect(second!.key).not.toBe(check!.key);
    expect(confirmed).toBe(true);
    // 导入的单据直接生效：切到“已完成的离职”第 1 页重读列表
    expect(
      calls
        .slice(before)
        .filter((call) => call.method === 'GET')
        .map((call) => call.path),
    ).toContain(`${EXITS}?view=completed&page=1&pageSize=30`);
  });

  it('预览有错误行：逐行显示原因，不能导入，也不发导入请求', async () => {
    preview = previewFailed;
    await render();
    await click(ENTRY);
    await upload();
    const text = document.body.querySelector('.ant-modal')?.textContent ?? '';
    expect(text).toContain('共 2 行：通过 1 行，不通过 1 行，有超编提示 0 行');
    expect(text).toContain('工号已存在');
    expect(text).toContain('不通过');
    expect(button('导入')?.disabled).toBe(true);
    expect(writes().map((call) => call.path)).toEqual([`${EXITS}/import/preview`]);
  });
});
