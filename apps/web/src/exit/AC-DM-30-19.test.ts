// @vitest-environment happy-dom
// AC-DM-30-F493-FE-01 / 02 / 03 / 06，真实页面与 F-123 内核。
// 渲染真实离职列表页 + F-123 内核，只替换权限快照与网络；回执形态见 smoke/exit-import-fixtures.ts。
// docs/08_设计/F-493_历史离职人员导入对齐北森_设计.md §9.1。
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useNavigate } from 'react-router';
import { App } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExitPage } from './ExitPage.js';
import { SessionProvider } from '../foundation/Session.js';
import { uniqueSuffix } from '../../../../tests/acceptance/support/unique.js';
import {
  bombRowsXml,
  buildXlsx,
  importHeader,
  importReceipt,
  importRows,
  importSheet,
  requiredRows,
  styledBlankRowsXml,
  emptyTextRowsXml,
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
let respond: (rows: { rowNo: number }[]) => Promise<Response>;
let navigate: ReturnType<typeof useNavigate>;
function Navigation() {
  navigate = useNavigate();
  return null;
}
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
        children: h(App, null, h(MemoryRouter, { initialEntries: ['/exits'] }, h(Navigation), h(ExitPage))),
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
/** 读大文件（解压到上限才中止）比 settle 的固定等待慢，按条件轮询，最多 3 秒。 */
async function shown(text: string) {
  for (let i = 0; i < 60 && !document.body.textContent?.includes(text); i++)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  expect(document.body.textContent).toContain(text);
}
const writes = () => calls.filter((call) => call.method === 'POST');
const headerTexts = () =>
  [...document.body.querySelectorAll('.ant-modal th')].map((node) => node.textContent ?? '').filter(Boolean);

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  access.buttons = [{ buttonCode: 'Employment.DimissionImport', level: 'list' }];
  calls = [];
  respond = async (rows) => Response.json(importReceipt(rows), { status: 202 });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path, body, key: new Headers(init?.headers).get('idempotency-key') });
    const rows = (body?.rows ?? []) as { rowNo: number }[];
    if (method === 'POST') return respond(rows);
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

describe('AC-DM-30-19 / F493 前端导入', () => {
  it('没有导入按钮时不显示入口', async () => {
    access.buttons = [];
    await render();
    expect(button(ENTRY)).toBeUndefined();
    expect(writes()).toEqual([]);
  });

  it('FE-01 选择三行无预览，保存只 POST 一次，202 关闭并刷新离职中的员工', async () => {
    await render();
    await click('全部离职记录');
    await click(ENTRY);
    await upload();
    expect(writes()).toEqual([]);
    expect(headerTexts()).toEqual([]);
    expect(button('保存')?.disabled).toBe(false);
    const before = calls.length;
    await click('保存');
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({
      path: `${EXITS}/import`,
      body: { rows: importRows, fileName: '历史离职.xlsx' },
    });
    expect(writes()[0]!.key).toBeTruthy();
    expect(document.body.querySelector('.ant-modal')).toBeNull();
    expect(document.body.textContent).toContain('导入进行中，执行结果请关注消息通知');
    expect(calls.slice(before).map((call) => call.path)).toContain(`${EXITS}?view=in_progress&page=1&pageSize=30`);
    expect(button('取消')).toBeUndefined();
    expect(document.body.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('FE-02 缺列、旧工号、1001 行与超过 1 MiB 均不请求', async () => {
    await render();
    await click(ENTRY);
    const cases: [typeof importSheet, string][] = [
      [importSheet.map((row) => row.filter((_, i) => i !== 2)), '缺少必填列：*电子邮件'],
      [[[...importHeader, '工号'], ...requiredRows(1)], '无法识别的列：工号'],
      [[importHeader, ...requiredRows(1001)], '一次最多导入 1000 行'],
      [
        [importHeader, ...requiredRows(1000).map((row) => [...row.slice(0, 25), '合'.repeat(300)])],
        '文件过大，请分批导入',
      ],
    ];
    for (const [sheet, error] of cases) {
      await upload(sheet);
      await shown(error);
      expect(button('保存')?.disabled).toBe(true);
      expect(writes()).toEqual([]);
    }
  });

  it.each([400, 413, 409])('明确 %s 拒绝显示中文并保留文件，改正后用新键提交', async (status) => {
    const reason = status === 413 ? '文件过大，请分批导入' : '合成拒绝原因';
    respond = async () => Response.json({ error: { code: 'VALIDATION_FAILED', message: reason } }, { status });
    await render();
    await click(ENTRY);
    await upload();
    await click('保存');
    expect(document.body.textContent).toContain(reason);
    expect(document.body.textContent).not.toContain('VALIDATION_FAILED');
    expect(button('保存')?.disabled).toBe(false);
    const first = writes()[0]!;
    respond = async (rows) => Response.json(importReceipt(rows), { status: 202 });
    await click('保存');
    expect(writes()[1]!.key).not.toBe(first.key);
    expect(writes()[1]!.body).toEqual(first.body);
  });

  it('FE-03 结果未知关闭重开仍锁定，用原键原报文重提', async () => {
    respond = async () => {
      throw new TypeError('network');
    };
    await render();
    await click(ENTRY);
    await upload();
    await click('保存');
    expect(document.body.textContent).toContain('结果待确认');
    const first = writes()[0]!;
    await click('关闭');
    await click(ENTRY);
    expect(document.body.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(true);
    expect(button('保存')).toBeUndefined();
    respond = async (rows) => Response.json(importReceipt(rows), { status: 202 });
    await click('按原命令重新提交');
    expect(writes()[1]).toEqual(first);
    await click(ENTRY);
    expect(document.body.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(false);
  });

  it('提交中防重复，关闭后迟到 202 不刷新、不跳页、不显示成功', async () => {
    let finish!: (response: Response) => void;
    respond = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    await render();
    await click('全部离职记录');
    await click(ENTRY);
    await upload();
    await click('保存');
    await click('保存');
    expect(writes()).toHaveLength(1);
    await click('关闭');
    const before = calls.length;
    await act(async () => finish(Response.json(importReceipt(importRows), { status: 202 })));
    await settle();
    expect(calls).toHaveLength(before);
    expect(button('全部离职记录')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.body.textContent).not.toContain('导入进行中');
  });

  it('离开再回来、后退再前进时丢弃旧弹窗的迟到成功', async () => {
    let finish!: (response: Response) => void;
    respond = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    await render();
    await click(ENTRY);
    await upload();
    await click('保存');
    await act(async () => navigate('/elsewhere'));
    await act(async () => navigate(-1));
    await act(async () => navigate(1));
    const before = calls.length;
    await act(async () => finish(Response.json(importReceipt(importRows), { status: 202 })));
    await settle();
    expect(calls).toHaveLength(before);
    expect(document.body.textContent).not.toContain('导入进行中');
  });

  it('无效回执保持结果未知，原键可恢复', async () => {
    respond = async () => Response.json({ batchId: 'bad', status: 'queued', total: 99 }, { status: 202 });
    await render();
    await click(ENTRY);
    await upload();
    await click('保存');
    expect(button('按原命令重新提交')).toBeDefined();
    const first = writes()[0]!;
    respond = async (rows) => Response.json(importReceipt(rows), { status: 202 });
    await click('按原命令重新提交');
    expect(writes()[1]).toEqual(first);
  });

  it('异常列坐标与压缩炸弹给出中文提示', async () => {
    await render();
    await click(ENTRY);
    await upload(importSheet, { rowsXml: '<row r="8"><c r="ZZZZZZ8"><v>1</v></c></row>' });
    await shown('文件无法读取，请选择 .xlsx 格式的 Excel 文件');
    await upload(importSheet, { rowsXml: bombRowsXml() });
    await shown('文件内容过大或单元格过多，无法读取；请只保留需要导入的行后重试');
    expect(writes()).toEqual([]);
  });

  it.each([styledBlankRowsXml, emptyTextRowsXml])('格式空白格不计入数据行，100 行正常保存', async (rowsXml) => {
    await render();
    await click(ENTRY);
    await upload([importHeader, ...requiredRows(100)], { rowsXml: rowsXml(102, 7200) });
    for (let i = 0; i < 60 && button('保存')?.disabled; i++) await settle();
    expect(writes()).toEqual([]);
    await click('保存');
    const rows = writes()[0]!.body!.rows as { rowNo: number }[];
    expect(rows).toHaveLength(100);
    expect(rows.at(-1)!.rowNo).toBe(101);
  });
});
