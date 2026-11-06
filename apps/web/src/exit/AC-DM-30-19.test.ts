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
  bombRowsXml,
  buildXlsx,
  confirmationRequired,
  importHeader,
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
async function upload(sheet = importSheet, options?: Parameters<typeof buildXlsx>[1]) {
  const input = document.body.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input, '应有文件选择框').not.toBeNull();
  const file = new File([await buildXlsx(sheet, options)], '历史离职.xlsx', {
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
    expect(text).toContain('2023-04-01 至 2025-07-31 超出编制（峰值 6，编制 5）');

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

  it('报文超过后端 32KB 请求体上限：就地给出中文提示，不发 preview 也不能导入', async () => {
    // 100 行、每行加黑说明 120 个汉字（360 字节）：UTF-8 报文必然超过 32 * 1024 字节
    const rows = Array.from({ length: 100 }, (_, i) => [
      `H${String(i + 1).padStart(4, '0')}`,
      `合成${i + 1}`,
      '2023-03-15',
      'D-SYN-01',
      '2025-06-30',
      '合'.repeat(120),
    ]);
    await render();
    await click(ENTRY);
    await upload([[...importHeader.slice(0, 5), '加黑说明'], ...rows]);
    expect(document.body.textContent).toContain('文件内容超过单次导入上限（32 KB），请减少行数或缩短内容后分批导入');
    expect(writes()).toEqual([]);
    expect(button('导入')?.disabled).toBe(true);
  });

  it('异常列坐标与压缩炸弹：就地给出中文提示，不发 preview 也不能导入', async () => {
    await render();
    await click(ENTRY);
    await upload(importSheet, { rowsXml: '<row r="4"><c r="ZZZZZZ4"><v>1</v></c></row>' });
    expect(document.body.textContent).toContain('文件无法读取，请选择 .xlsx 格式的 Excel 文件');
    await upload(importSheet, { rowsXml: bombRowsXml() });
    expect(document.body.textContent).toContain('文件内容过大或单元格过多，无法读取；请只保留需要导入的行后重试');
    expect(writes()).toEqual([]);
    expect(button('导入')?.disabled).toBe(true);
  });

  it('结果未知（响应丢失）→ 关闭重开仍锁定 → 按原命令重新提交：原键、原报文，完成后解锁', async () => {
    // 服务端已处理带确认的导入，但响应在网络上丢失：客户端只看到网络错误（设计 §9.3 结果未知）
    const serve = vi.mocked(globalThis.fetch).getMockImplementation()!;
    let lose = true;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const response = await serve(input, init);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      if (lose && String(input) === `${EXITS}/import` && body?.confirmed === true) {
        lose = false;
        throw new TypeError('Failed to fetch');
      }
      return response;
    });
    await render();
    await click(ENTRY);
    await upload();
    await click('导入');
    await click('确定');
    const lost = writes().at(-1)!;
    expect(lost.body).toEqual({ rows: importRows, confirmed: true });
    expect(document.body.textContent).toContain('结果待确认');

    await click('关闭');
    await click(ENTRY);
    // 关闭重开仍是那条未确认的命令：入口锁定，不能另起命令
    expect(document.body.textContent).toContain('结果待确认');
    expect(document.body.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(true);
    expect(button('导入')?.disabled).toBe(true);
    const sent = writes().length;
    const before = calls.length;
    await click('按原命令重新提交');

    // 原键重放：Idempotency-Key 与报文都与丢失的那次完全一致，台账回放第一次的结果
    expect(writes()).toHaveLength(sent + 1);
    const replayed = writes().at(-1)!;
    expect(replayed.path).toBe(`${EXITS}/import`);
    expect(replayed.key).toBe(lost.key);
    expect(replayed.body).toEqual(lost.body);
    expect(document.body.textContent).toContain('已导入 2 人');
    expect(
      calls
        .slice(before)
        .filter((call) => call.method === 'GET')
        .map((call) => call.path),
    ).toContain(`${EXITS}?view=completed&page=1&pageSize=30`);

    // 确认完成后解锁：再打开是空白的新导入
    await click(ENTRY);
    expect(document.body.textContent).not.toContain('结果待确认');
    expect(document.body.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(false);
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
