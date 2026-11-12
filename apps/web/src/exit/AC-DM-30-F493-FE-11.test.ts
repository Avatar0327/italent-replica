// @vitest-environment happy-dom
// F-493 S4c（设计 §9.5）：经 exit/pages.ts 登记的懒加载页面渲染「导入历史」，不直接引页面文件。
// 列表夹具按 apps/api/src/modules/employment/exit-import-history.ts 的 ExitImportHistoryItem 与 { items, page, hasNext }；
// 错误信封按 apps/api/src/errors.ts（{ error: { code, message, details } }）；数据全部为合成值。
import { act, createElement as h, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider, type Session } from '../foundation/Session.js';
import { pages } from './pages.js';

const OBJECT = 'TenantBase.EmploymentRecord';
const LIST = '/api/tenant/employment/exits/import/batches';
const access = vi.hoisted(() => ({
  create: true,
  buttons: [{ buttonCode: 'Employment.DimissionImport', level: 'list' }] as { buttonCode: string; level: string }[],
  loading: false,
}));
vi.mock('../foundation/Permissions.js', () => ({
  usePermissions: () => ({
    loading: access.loading,
    error: undefined,
    refresh() {},
    menus: [],
    snapshot: {
      menus: [],
      objects: access.loading
        ? {}
        : {
            [OBJECT]: {
              objectCode: OBJECT,
              dataOperations: { create: access.create, list: true },
              viewableFields: [],
              editableFields: [],
              buttons: access.buttons,
            },
          },
    },
  }),
}));
vi.mock('../foundation/DecisionNote.js', () => ({ DecisionNote: () => null }));

const session: Session = {
  tenantId: 'synthetic-tenant',
  identityKey: 'synthetic-user',
  displayName: '合成导入人',
  tenantName: '合成租户',
  timezone: 'Asia/Shanghai',
  source: 'server',
};
type Item = {
  id: string;
  importType: 'exit';
  createdAt: string;
  submitterName: string;
  status: 'running' | 'succeeded' | 'failed';
  total: number;
  errorCount: number | null;
  hasErrorFile: boolean;
  fileName: string;
  filesExpired: boolean;
};
const item = (id: string, extra: Partial<Item> = {}): Item => ({
  id: `81000000-0000-4000-8000-00000000000${id}`,
  importType: 'exit',
  createdAt: '2026-11-05T20:30:00.000Z',
  submitterName: '合成导入人',
  status: 'succeeded',
  total: 11,
  errorCount: 10,
  hasErrorFile: true,
  fileName: `合成历史离职${id}.xlsx`,
  filesExpired: false,
  ...extra,
});
const listOf = (items: Item[], page = 1, hasNext = false) => Response.json({ items, page, hasNext });
const xlsx = (name: string) =>
  new Response('xlsx', {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="report.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`,
    },
  });
const deferred = () => {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

let host: HTMLDivElement;
let root: Root;
let fetcher: ReturnType<typeof vi.fn>;
const settle = async () => {
  for (let i = 0; i < 8; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
};
const entry = () => pages.entries.find((route) => route.id === 'exit-import-history');
async function render() {
  const Page = entry()?.page.Component;
  expect(Page, '应在 exit/pages.ts 登记导入历史页').toBeDefined();
  await act(async () =>
    root.render(
      h(SessionProvider, {
        session,
        children: h(
          MemoryRouter,
          { initialEntries: ['/exit-import-history'] },
          h(Suspense, { fallback: null }, h(Page!)),
        ),
      }),
    ),
  );
  await settle();
}
const urls = () => fetcher.mock.calls.map(([input]) => String(input));
const listCalls = () => urls().filter((url) => url.startsWith(`${LIST}?`));
const query = (url: string) => Object.fromEntries(new URL(url, 'http://synthetic').searchParams);
const text = (node: Element | null | undefined) => node?.textContent?.replace(/\s/g, '') ?? '';
const headers = () => [...host.querySelectorAll('thead th')].map(text).filter(Boolean);
const rows = () => [...host.querySelectorAll<HTMLElement>('tbody tr.ant-table-row')];
const cells = (row: HTMLElement) => [...row.querySelectorAll('td')].map(text);
const button = (label: string, scope: ParentNode = host) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find((node) => text(node) === label);
async function click(label: string, scope: ParentNode = host) {
  const target = button(label, scope);
  expect(target, `应存在按钮：${label}`).toBeDefined();
  await act(async () => target!.click());
  await settle();
}
const statusSelect = () =>
  [...host.querySelectorAll<HTMLElement>('.ant-select')].find((node) => node.querySelector('[aria-label="状态"]'));
async function openStatus() {
  const select = statusSelect();
  expect(select, '应有「状态」筛选').toBeDefined();
  await act(async () => {
    select!.querySelector('.ant-select-selector')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await settle();
}
const options = () => [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')];
async function choose(label: string) {
  await openStatus();
  const option = options().find((node) => text(node) === label);
  expect(option, `选项 ${label}`).toBeDefined();
  await act(async () => option!.click());
  await settle();
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  access.create = true;
  access.buttons = [{ buttonCode: 'Employment.DimissionImport', level: 'list' }];
  access.loading = false;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  fetcher = vi.fn().mockImplementation(async () => listOf([]));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AC-DM-30-F493-FE-11 导入历史页', () => {
  it('任职应用下与离职管理同层登记「导入历史」入口（D15）', () => {
    expect(entry()).toMatchObject({
      id: 'exit-import-history',
      app: 'transfer',
      group: 'people',
      label: '导入历史',
      objectCode: OBJECT,
    });
  });

  it('表头按北森列序，三态与结果文字、执行中与无错误文件显示「--」，不出现英文状态码', async () => {
    fetcher.mockResolvedValueOnce(
      listOf([
        item('1'),
        item('2', { status: 'running', total: 3, errorCount: null, hasErrorFile: false }),
        item('3', { status: 'failed', total: 2, errorCount: 2 }),
        item('4', { total: 5, errorCount: 0, hasErrorFile: false }),
      ]),
    );
    await render();
    expect(listCalls()).toHaveLength(1);
    expect(query(listCalls()[0]!)).toEqual({ page: '1' });
    expect(headers()).toEqual(['导入类型', '导入时间', '导入者', '状态', '导入结果', '附件', '导入附件']);
    expect(rows().map(cells)).toEqual([
      [
        '离职人员',
        '2026/11/0604:30',
        '合成导入人',
        '成功',
        '尝试导入11条记录，出现10个错误。',
        '下载导入错误报告',
        '合成历史离职1.xlsx',
      ],
      ['离职人员', '2026/11/0604:30', '合成导入人', '执行中', '--', '--', '合成历史离职2.xlsx'],
      [
        '离职人员',
        '2026/11/0604:30',
        '合成导入人',
        '失败',
        '尝试导入2条记录，出现2个错误。',
        '下载导入错误报告',
        '合成历史离职3.xlsx',
      ],
      ['离职人员', '2026/11/0604:30', '合成导入人', '成功', '尝试导入5条记录，出现0个错误。', '--', '合成历史离职4.xlsx'],
    ]);
    expect(host.textContent).not.toMatch(/\b(running|succeeded|failed|exit|EXIT_[A-Z_]+)\b/);
    for (const label of ['取消', '删除', '重试']) expect(button(label)).toBeUndefined();
  });

  it('状态筛选只有 执行中 / 成功 / 失败，没有导入者筛选，有导入时间区间与刷新', async () => {
    await render();
    expect(host.querySelector('[aria-label="导入者"]')).toBeNull();
    expect(host.querySelector('.ant-picker-range')).not.toBeNull();
    expect(button('刷新')).toBeDefined();
    await openStatus();
    expect(options().map(text)).toEqual(['执行中', '成功', '失败']);
  });

  it('filesExpired 为真时两个下载都显示「已过期」且不可点，不发下载请求', async () => {
    fetcher.mockResolvedValueOnce(listOf([item('1', { filesExpired: true })]));
    await render();
    const row = rows()[0]!;
    expect(cells(row).slice(5)).toEqual(['已过期', '已过期']);
    expect(row.querySelectorAll('td:nth-child(6) button, td:nth-child(7) button, td a')).toHaveLength(0);
    await act(async () => (row.querySelector('td:nth-child(7)') as HTMLElement).click());
    await settle();
    expect(urls().filter((url) => url.includes('-file'))).toEqual([]);
  });

  it('列表 403 显示无权限空状态，不显示表格，不发其他请求', async () => {
    fetcher.mockResolvedValueOnce(
      Response.json({ error: { code: 'FORBIDDEN', message: 'FORBIDDEN' } }, { status: 403 }),
    );
    await render();
    expect(host.textContent).toContain('暂无访问权限');
    expect(host.querySelector('table')).toBeNull();
    expect(host.textContent).not.toContain('FORBIDDEN');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('没有导入按钮或新增权时显示无权限空状态，一个请求都不发', async () => {
    access.buttons = [{ buttonCode: 'Employment.DimissionImport', level: 'detail' }];
    await render();
    expect(host.textContent).toContain('暂无访问权限');
    expect(fetcher).not.toHaveBeenCalled();
    await act(() => root.render(null));
    access.buttons = [{ buttonCode: 'Employment.DimissionImport', level: 'list' }];
    access.create = false;
    await render();
    expect(host.textContent).toContain('暂无访问权限');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('权限明细加载中不发请求，加载完再读第 1 页', async () => {
    access.loading = true;
    await render();
    expect(fetcher).not.toHaveBeenCalled();
    access.loading = false;
    await render();
    expect(listCalls()).toHaveLength(1);
  });

  it('连续改筛选回第 1 页，按请求序号只采用最后一次响应', async () => {
    fetcher.mockResolvedValueOnce(listOf([item('1')], 1, true));
    await render();
    await click('下一页');
    expect(query(listCalls()[1]!)).toEqual({ page: '2' });
    const second = deferred();
    const third = deferred();
    fetcher.mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
    await choose('执行中');
    await choose('成功');
    expect(listCalls().slice(2).map(query)).toEqual([
      { page: '1', status: 'running' },
      { page: '1', status: 'running,succeeded' },
    ]);
    await act(async () => third.resolve(listOf([item('3', { fileName: '合成最后一次.xlsx' })])));
    await settle();
    await act(async () => second.resolve(listOf([item('2', { fileName: '合成迟到.xlsx' })])));
    await settle();
    expect(host.textContent).toContain('合成最后一次.xlsx');
    expect(host.textContent).not.toContain('合成迟到.xlsx');
  });

  it('上一页 / 下一页按 hasNext，刷新重读当前页且不轮询', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
    try {
      fetcher
        .mockResolvedValueOnce(listOf([item('1')], 1, true))
        .mockResolvedValueOnce(listOf([item('2')], 2, false))
        .mockResolvedValueOnce(listOf([item('2', { status: 'running', errorCount: null })], 2, false));
      await render();
      expect(button('上一页')!.disabled).toBe(true);
      expect(button('下一页')!.disabled).toBe(false);
      await click('下一页');
      expect(button('下一页')!.disabled).toBe(true);
      expect(button('上一页')!.disabled).toBe(false);
      await click('刷新');
      expect(listCalls().map((url) => query(url).page)).toEqual(['1', '2', '2']);
      expect(rows().map((row) => cells(row)[3])).toEqual(['执行中']);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('导入附件与错误报告以 blob 下载，文件名取响应头；下载中再点不重复请求', async () => {
    const pending = deferred();
    fetcher.mockResolvedValueOnce(listOf([item('1')])).mockReturnValueOnce(pending.promise);
    vi.stubGlobal(
      'URL',
      class extends URL {
        static override createObjectURL = vi.fn(() => 'blob:synthetic');
        static override revokeObjectURL = vi.fn();
      },
    );
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    await render();
    const row = rows()[0]!;
    await click('合成历史离职1.xlsx', row);
    await click('合成历史离职1.xlsx', row);
    expect(urls().slice(1)).toEqual([`${LIST}/${item('1').id}/source-file`]);
    await act(async () => pending.resolve(xlsx('合成历史离职1.xlsx')));
    await settle();
    fetcher.mockResolvedValueOnce(xlsx('下载导入错误报告.xlsx'));
    await click('下载导入错误报告', row);
    expect(urls().slice(2)).toEqual([`${LIST}/${item('1').id}/error-file`]);
    expect(downloads).toEqual(['合成历史离职1.xlsx', '下载导入错误报告.xlsx']);
  });

  it.each([
    ['合成历史离职1.xlsx', 404, 'NOT_FOUND', 'EXIT_IMPORT_FILE_EXPIRED', '文件已过期'],
    ['下载导入错误报告', 404, 'NOT_FOUND', 'EXIT_IMPORT_FILE_EXPIRED', '文件已过期'],
    ['合成历史离职1.xlsx', 403, 'FORBIDDEN', undefined, '下载失败，请重试'],
    ['下载导入错误报告', 404, 'NOT_FOUND', undefined, '下载失败，请重试'],
  ])('下载「%s」得到 %s %s %s 时只显示中文提示', async (label, status, code, reason, message) => {
    fetcher
      .mockResolvedValueOnce(listOf([item('1')]))
      .mockResolvedValueOnce(
        Response.json({ error: { code, message: code, details: reason ? { reason } : undefined } }, { status }),
      );
    await render();
    await click(label, rows()[0]!);
    expect(host.querySelector('[role=alert]')?.textContent).toBe(message);
    expect(host.textContent).not.toContain(code);
    if (reason) expect(host.textContent).not.toContain(reason);
  });

  it('离开页面后到达的响应丢弃，回来后只显示新请求的结果', async () => {
    const late = deferred();
    fetcher.mockReturnValueOnce(late.promise);
    await render();
    await act(() => root.render(null));
    fetcher.mockResolvedValueOnce(listOf([item('2', { fileName: '合成回来后.xlsx' })]));
    await render();
    await act(async () => late.resolve(listOf([item('1', { fileName: '合成离开前.xlsx' })])));
    await settle();
    expect(host.textContent).toContain('合成回来后.xlsx');
    expect(host.textContent).not.toContain('合成离开前.xlsx');
  });

  it('列表形状不符时显示中文读取失败，不渲染半截表格', async () => {
    fetcher.mockResolvedValueOnce(Response.json({ items: [{ id: 'x', status: 'queued' }], page: 1, hasNext: false }));
    await render();
    expect(host.querySelector('table')).toBeNull();
    expect(host.textContent).toContain('导入历史读取结果无效，请刷新后重试');
    expect(host.textContent).not.toContain('queued');
  });
});
