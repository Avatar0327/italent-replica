/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * AC-TRF-F481-FE-03（F-481 设计 §8.2、§12）：电子签 > 签署记录。
 * 三页签（全部 / 签署中 / 签署完成 → tab=all|signing|completed）；8 列按设计顺序与表头文案；
 * 提醒 / 撤销 / 下载文件三个按钮作用于勾选行，未勾选提示“请至少选择一条数据”，按 ESignRecord.* 列表级按钮控制；
 * 没有“电子文件”字段读权时该列与「下载文件」都不显示；撤销前确认；回执逐条提示，409 REVISION_CONFLICT 只提示刷新、
 * 不自动重提。页面从电子签菜单组登记的入口取（与路由挂载同一个组件）。
 * 夹具形状按后端 apps/api esign：列表 record-access.ts presentRecord（无字段读权的键整个省略，currentNode /
 * failureReason 随 status 读权），分页 records.ts listRecords { items, total, page, pageSize }；提醒 / 撤销回执
 * records.ts actOnRecords { items: [{ id, ok:true } | { id, ok:false, code }] }；下载 record-routes.ts download
 * （PDF / zip 附件，未完成 409 ESIGN_NOT_COMPLETED）。
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act, Suspense } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { MemoryRouter } = requireWeb('react-router');
const { App, ConfigProvider } = requireWeb('antd');
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { PermissionsProvider } = await import(resolve('apps/web/src/foundation/Permissions.tsx'));
const { PAGES } = await import(resolve('apps/web/src/foundation/routes.ts'));

const RECORD_OBJECT = 'TenantBase.ESignRecord';
const RECORDS = '/api/tenant/esign/records';
const FIELDS = ['initiator', 'owner', 'ownerDepartment', 'scene', 'initiatedAt', 'completedAt', 'status', 'files'];
const BUTTONS = ['ESignRecord.Remind', 'ESignRecord.Revoke', 'ESignRecord.Download'];
const HEADERS = ['发起人', '业务所有者', '所有者部门', '签署场景', '发起时间', '签署完成时间', '签署状态', '电子文件'];
const session = {
  tenantId: '10000000-0000-4000-8000-000000000481',
  userId: '20000000-0000-4000-8000-000000000481',
  identityKey: 'synthetic',
  tenantName: '合成租户',
  displayName: '合成用户',
  timezone: 'Asia/Shanghai',
  source: 'server',
};
const id = (n: number) => `84810000-0000-4000-8000-0000000007${String(n).padStart(2, '0')}`;
const R1 = id(1);
const R2 = id(2);
const R3 = id(3);
const R4 = id(4);
const R5 = id(5);
const R6 = id(6);
type Row = Record<string, unknown> & { id: string };
const record = (rowId: string, owner: string, extra: Record<string, unknown> = {}): Row => ({
  id: rowId,
  revision: 1,
  initiator: { id: session.userId, name: '合成发起人' },
  owner: { id: `3${rowId.slice(1)}`, name: owner },
  ownerDepartment: { id: `5${rowId.slice(1)}`, name: '合成研发部' },
  scene: 'transfer',
  initiatedAt: '2026-11-15T16:30:05.000Z',
  completedAt: null,
  status: 'signing',
  files: [
    { seq: 1, name: '合成调动协议' },
    { seq: 2, name: '合成保密协议' },
  ],
  currentNode: 'employee',
  failureReason: null,
  ...extra,
});
const ALL: Row[] = [
  record(R1, '合成员工甲'),
  record(R2, '合成员工乙', { revision: 3, currentNode: 'enterprise' }),
  record(R3, '合成员工丙', {
    revision: 4,
    status: 'completed',
    currentNode: null,
    completedAt: '2026-11-16T02:00:00.000Z',
    files: [{ seq: 1, name: '合成调动协议' }],
  }),
  record(R4, '合成员工丁', { revision: 2, status: 'revoked', currentNode: null }),
  record(R5, '合成员工戊', { revision: 2, status: 'expired', currentNode: null }),
  record(R6, '合成员工己', { status: 'failed', currentNode: null, failureReason: 'EMPLOYEE_NO_ACCOUNT', files: [] }),
];
const byTab: Record<string, (row: Row) => boolean> = {
  all: () => true,
  signing: (row) => row.status === 'signing',
  completed: (row) => row.status === 'completed',
};

interface Reply {
  readonly status?: number;
  readonly body?: unknown;
  /** 下载接口返回的是文件，不是 JSON */
  readonly file?: { readonly type: string; readonly name: string };
}
interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly key: string | null;
  readonly ifMatch: string | null;
}
let viewable: string[];
let buttons: string[];
let rows: Row[];
let listGate: { tab: string; gate: Promise<void> } | undefined;
let writes: (Reply | Promise<Reply>)[];
let sent: Sent[];
let downloads: Reply[];
let fetched: URL[];
async function replyOf(url: URL, init: RequestInit): Promise<Reply> {
  const path = url.pathname;
  const method = init.method ?? 'GET';
  if (path.endsWith('/me/snapshot')) return { body: { session, apps: [], scope: [], adminMenus: [] } };
  if (path.includes('/permission/me/objects/')) {
    const objectCode = decodeURIComponent(path.split('/').at(-1)!);
    if (objectCode !== RECORD_OBJECT)
      return { body: { objectCode, dataOperations: {}, viewableFields: [], editableFields: [], buttons: [] } };
    return {
      body: {
        objectCode,
        dataOperations: { read: true },
        viewableFields: viewable,
        editableFields: [],
        buttons: buttons.map((buttonCode) => ({ buttonCode, level: 'list' })),
      },
    };
  }
  if (method !== 'GET') {
    const headers = new Headers(init.headers);
    sent.push({
      method,
      path,
      body: JSON.parse(String(init.body)),
      key: headers.get('idempotency-key'),
      ifMatch: headers.get('if-match'),
    });
    return (await writes.shift()) ?? { status: 500, body: {} };
  }
  if (path === RECORDS) {
    const tab = url.searchParams.get('tab') ?? 'all';
    if (listGate?.tab === tab) await listGate.gate;
    const items = rows.filter(byTab[tab]!).map((row) => trim(row));
    return { body: { items, total: items.length, page: 1, pageSize: 20 } };
  }
  if (path === `${RECORDS}/files`) return downloads.shift() ?? { status: 500, body: {} };
  return { body: { items: [] } };
}
// 同 presentRecord：没有读权的字段整个省略；currentNode / failureReason 跟着 status 读权走。
function trim(row: Row) {
  const kept = Object.entries(row).filter(([field]) => {
    if (field === 'currentNode' || field === 'failureReason') return viewable.includes('status');
    return !FIELDS.includes(field) || viewable.includes(field);
  });
  return Object.fromEntries(kept);
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let saved: string[];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    })),
  );
  viewable = [...FIELDS];
  buttons = [...BUTTONS];
  rows = ALL;
  listGate = undefined;
  writes = [];
  sent = [];
  downloads = [];
  fetched = [];
  saved = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (raw: string, init: RequestInit = {}) => {
      const url = new URL(String(raw), 'http://localhost');
      fetched.push(url);
      const reply = await replyOf(url, init);
      if (!reply.file) return Response.json(reply.body, { status: reply.status ?? 200 });
      const disposition = `attachment; filename*=UTF-8''${encodeURIComponent(reply.file.name)}`;
      return new Response(new Blob(['合成文件'], { type: reply.file.type }), {
        status: 200,
        headers: { 'content-type': reply.file.type, 'content-disposition': disposition },
      });
    }),
  );
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:synthetic');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push(this.download);
  });
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
});

type Entry = { id: string; label: string; children?: Entry[]; page?: { Component: unknown } };
const child = (label: string) =>
  (PAGES.entries as Entry[]).find((entry) => entry.label === '电子签')?.children?.find((item) => item.label === label);
const settle = (ms = 30) => act(() => new Promise<void>((done) => setTimeout(done, ms)));
async function open() {
  const page = child('签署记录')?.page;
  expect(page, '电子签 > 签署记录 有页面').toBeTruthy();
  const theme = { token: { motion: false } };
  const node = h(Suspense, { fallback: null }, h(page!.Component as never));
  const shell = h(
    SessionProvider,
    { session },
    h(PermissionsProvider, {}, h(ConfigProvider, { theme }, h(App, {}, node))),
  );
  await act(async () => root.render(h(MemoryRouter, { initialEntries: ['/esign-records'] }, shell)));
  await rendered();
}
// 懒加载页：轮询到目标页自己的可见容器就绪（标题对、读取结束），不认 Suspense 隐藏的旧页（FE-05 第 4 轮 P2-1）。
const PAGE_TIMEOUT_MS = 3000;
const page = () => host.querySelector<HTMLElement>('.esign-records');
function missing() {
  const target = page();
  if (!target || target.closest('[hidden]') || target.style.display === 'none') return ['可见的 .esign-records'];
  const title = target.querySelector('.page-heading h1')?.textContent;
  return [
    ...(title === '签署记录' ? [] : [`标题「签署记录」（实为 ${title ?? '无'}）`]),
    ...(target.querySelector('.ant-spin-spinning, .page-state .ant-spin') ? ['读取结束（loading 仍在）'] : []),
  ];
}
async function rendered(timeout = PAGE_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  while (missing().length > 0 && Date.now() < deadline) await settle();
  expect(missing(), `电子签 > 签署记录：${timeout}ms 内页面未就绪，缺`).toEqual([]);
  await settle();
}
const pressable = (scope: ParentNode | null | undefined, label: string) =>
  Array.from(scope?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (item) => item.textContent?.replace(/\s/g, '') === label,
  );
async function click(element: Element | null | undefined) {
  expect(element, '可点击的元素').toBeTruthy();
  await act(async () => (element as HTMLElement).click());
  await settle();
}
const heading = () => host.querySelector('.page-heading');
const tab = (label: string) =>
  Array.from(host.querySelectorAll<HTMLElement>('.ant-tabs-tab [role="tab"]')).find(
    (item) => item.textContent === label,
  );
const headers = () =>
  Array.from(host.querySelectorAll('.ant-table-thead th:not(.ant-table-selection-column)'), (th) =>
    th.textContent?.trim(),
  );
const rowOf = (text: string) =>
  Array.from(host.querySelectorAll<HTMLElement>('.ant-table-tbody tr')).find((tr) => tr.textContent?.includes(text));
const check = async (...owners: string[]) => {
  for (const owner of owners) await click(rowOf(owner)?.querySelector('.ant-checkbox-input'));
};
const modal = () => document.querySelector<HTMLElement>('.ant-modal-wrap:not([style*="display: none"]) .ant-modal');
const lists = () => fetched.filter((url) => url.pathname === RECORDS);
const lastList = () => lists().at(-1)!.searchParams;
const noticeText = () => document.querySelector('.ant-message')?.textContent ?? '';

describe('AC-TRF-F481-FE-03 签署记录：页签与列', () => {
  it('FE-03-01 三页签 全部 / 签署中 / 签署完成：默认全部；切换按 tab 重读第 1 页，并清空勾选', async () => {
    await open();
    expect(Array.from(host.querySelectorAll('.ant-tabs-tab [role="tab"]'), (item) => item.textContent)).toEqual([
      '全部',
      '签署中',
      '签署完成',
    ]);
    expect([lastList().get('tab'), lastList().get('page')]).toEqual(['all', '1']);
    expect(host.querySelectorAll('.ant-table-tbody .ant-table-row')).toHaveLength(6);
    await check('合成员工甲');
    await click(tab('签署中'));
    await rendered();
    expect([lastList().get('tab'), lastList().get('page')]).toEqual(['signing', '1']);
    expect(host.querySelectorAll('.ant-table-tbody .ant-table-row')).toHaveLength(2);
    expect(host.querySelectorAll('.ant-table-tbody .ant-checkbox-checked'), '切页签后勾选已清空').toHaveLength(0);
    await click(pressable(heading(), '提醒'));
    expect(noticeText()).toContain('请至少选择一条数据');
    await click(tab('签署完成'));
    await rendered();
    expect(lastList().get('tab')).toBe('completed');
    expect(rowOf('合成员工丙')).toBeTruthy();
    expect(host.querySelectorAll('.ant-table-tbody .ant-table-row')).toHaveLength(1);
  });

  it('FE-03-02 8 列按设计 §8.2 顺序与表头文案；行内容按租户时区、中文状态，文件名逗号分隔，不露英文码', async () => {
    await open();
    expect(headers()).toEqual(HEADERS);
    const first = rowOf('合成员工甲')?.textContent ?? '';
    for (const text of ['合成发起人', '合成研发部', '调动电子签署', '2026-11-16 00:30:05', '签署中（待员工签署）'])
      expect(first).toContain(text);
    expect(first).toContain('合成调动协议，合成保密协议');
    expect(first).not.toContain('2026-11-15');
    expect(rowOf('合成员工乙')?.textContent).toContain('签署中（待企业确认）');
    expect(rowOf('合成员工丙')?.textContent).toContain('签署完成');
    expect(rowOf('合成员工丙')?.textContent).toContain('2026-11-16 10:00:00');
    expect(rowOf('合成员工丁')?.textContent).toContain('已撤销');
    expect(rowOf('合成员工戊')?.textContent).toContain('已过期');
    expect(rowOf('合成员工己')?.textContent).toContain('发起失败');
    for (const code of ['transfer', 'signing', 'employee', 'EMPLOYEE_NO_ACCOUNT', 'completed', 'revoked'])
      expect(host.querySelector('.ant-table')?.textContent).not.toContain(code);
  });

  it('FE-03-03 发起失败：悬停状态显示失败原因中文文案', async () => {
    await open();
    const status = Array.from(rowOf('合成员工己')?.querySelectorAll<HTMLElement>('td *') ?? []).find(
      (node) => node.children.length === 0 && node.textContent === '发起失败',
    );
    expect(status, '发起失败的状态文字').toBeTruthy();
    await act(async () => {
      status!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      status!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    });
    await settle(200);
    const tips = Array.from(document.querySelectorAll('.ant-tooltip:not(.ant-tooltip-hidden) .ant-tooltip-inner'));
    expect(tips.map((item) => item.textContent)).toEqual(['员工没有可登录的账号，无法签署']);
  });

  it('FE-03-04 无“电子文件”“发起人”字段读权：这两列不显示，有下载按钮权也不显示「下载文件」', async () => {
    viewable = FIELDS.filter((field) => field !== 'files' && field !== 'initiator');
    await open();
    expect(headers()).toEqual(HEADERS.filter((title) => title !== '电子文件' && title !== '发起人'));
    expect(host.querySelector('.ant-table-tbody')?.textContent).not.toContain('合成调动协议');
    expect(host.querySelector('.ant-table-tbody')?.textContent).not.toContain('合成发起人');
    expect(pressable(heading(), '下载文件')).toBeUndefined();
    expect(pressable(heading(), '提醒')).toBeTruthy();
    expect(pressable(heading(), '撤销')).toBeTruthy();
  });

  it('FE-03-05 按钮按 ESignRecord.Remind / Revoke / Download（列表级）分别控制', async () => {
    buttons = ['ESignRecord.Remind'];
    await open();
    expect(pressable(heading(), '提醒')).toBeTruthy();
    expect(pressable(heading(), '撤销')).toBeUndefined();
    expect(pressable(heading(), '下载文件')).toBeUndefined();
    await act(() => root.unmount());
    root = createRoot(host);
    buttons = [];
    await open();
    for (const label of ['提醒', '撤销', '下载文件']) expect(pressable(heading(), label)).toBeUndefined();
    // 没有下载按钮权时，电子文件列只显示文件名，不能点击下载
    expect(pressable(rowOf('合成员工丙'), '合成调动协议')).toBeUndefined();
  });
});

describe('AC-TRF-F481-FE-03 签署记录：提醒 / 撤销 / 下载文件', () => {
  it('FE-03-06 未勾选时三个按钮都提示“请至少选择一条数据”，不发请求、不弹窗', async () => {
    await open();
    for (const label of ['提醒', '撤销', '下载文件']) {
      await click(pressable(heading(), label));
      expect(noticeText(), label).toContain('请至少选择一条数据');
      expect(modal(), label).toBeNull();
    }
    expect(sent).toEqual([]);
    expect(fetched.filter((url) => url.pathname.startsWith(`${RECORDS}/`))).toEqual([]);
  });

  it('FE-03-07 撤销：先确认“撤销后该签署将无法继续，是否继续”；取消不发请求，确定后逐条回执并刷新列表', async () => {
    writes = [{ body: { items: [{ id: R1, ok: true }] } }];
    await open();
    await check('合成员工甲');
    await click(pressable(heading(), '撤销'));
    expect(modal()?.textContent).toContain('撤销后该签署将无法继续，是否继续');
    await click(pressable(modal(), '取消'));
    expect(sent).toEqual([]);
    await click(pressable(heading(), '撤销'));
    const before = lists().length;
    await click(pressable(modal(), '确定'));
    await settle(60);
    expect(sent).toEqual([
      {
        method: 'POST',
        path: `${RECORDS}/revoke`,
        body: { items: [{ id: R1, revision: 1 }] },
        key: expect.any(String),
        ifMatch: null,
      },
    ]);
    expect(modal()?.textContent).toContain('合成员工甲');
    expect(modal()?.textContent).toContain('已撤销');
    rows = ALL.map((row) => (row.id === R1 ? { ...row, status: 'revoked', revision: 2, currentNode: null } : row));
    await click(pressable(modal(), '关闭'));
    await rendered();
    expect(lists().length).toBeGreaterThan(before);
    expect(rowOf('合成员工甲')?.textContent).toContain('已撤销');
    expect(host.querySelectorAll('.ant-table-tbody .ant-checkbox-checked'), '刷新后勾选清空').toHaveLength(0);
  });

  it('FE-03-08 提醒回执含 409 REVISION_CONFLICT：逐条提示刷新，不自动重提；刷新后再提醒带最新版本与新命令 ID', async () => {
    writes = [
      {
        body: {
          items: [
            { id: R1, ok: true },
            { id: R2, ok: false, code: 'REVISION_CONFLICT' },
          ],
        },
      },
      { body: { items: [{ id: R2, ok: true }] } },
    ];
    await open();
    await check('合成员工甲', '合成员工乙');
    await click(pressable(heading(), '提醒'));
    await settle(60);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      method: 'POST',
      path: `${RECORDS}/remind`,
      body: {
        items: [
          { id: R1, revision: 1 },
          { id: R2, revision: 3 },
        ],
      },
      key: expect.any(String),
      ifMatch: null,
    });
    const text = modal()?.textContent ?? '';
    expect(text).toContain('已提醒');
    expect(text).toContain('数据已变更，请刷新列表后重试');
    expect(text).not.toContain('REVISION_CONFLICT');
    await settle(200);
    expect(sent, '不自动重提').toHaveLength(1);
    rows = ALL.map((row) => (row.id === R2 ? { ...row, revision: 5 } : row));
    await click(pressable(modal(), '关闭'));
    await rendered();
    await check('合成员工乙');
    await click(pressable(heading(), '提醒'));
    await settle(60);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body).toEqual({ items: [{ id: R2, revision: 5 }] });
    expect(sent[1]!.key).not.toBe(sent[0]!.key);
    expect(modal()?.textContent).toContain('已提醒');
  });

  it('FE-03-09 签署已结束 / 不在范围：回执给中文原因，不露英文码', async () => {
    writes = [
      {
        body: {
          items: [
            { id: R4, ok: false, code: 'ESIGN_TASK_CLOSED' },
            { id: R5, ok: false, code: 'NOT_FOUND' },
          ],
        },
      },
    ];
    await open();
    await check('合成员工丁', '合成员工戊');
    await click(pressable(heading(), '提醒'));
    await settle(60);
    const text = modal()?.textContent ?? '';
    expect(text).toContain('签署已结束，不能操作');
    expect(text).toContain('记录不存在或不在您的操作范围内');
    for (const code of ['ESIGN_TASK_CLOSED', 'NOT_FOUND']) expect(text).not.toContain(code);
  });

  it('FE-03-10 下载文件：勾选已完成行按服务端文件名保存；含签署中时提示只能下载已完成的签署文件', async () => {
    downloads = [
      { file: { type: 'application/pdf', name: '合成调动协议.pdf' } },
      {
        status: 409,
        body: {
          error: {
            code: 'CONFLICT',
            message: '只能下载已完成的签署文件',
            details: { reason: 'ESIGN_NOT_COMPLETED' },
          },
        },
      },
      { file: { type: 'application/pdf', name: '合成调动协议.pdf' } },
    ];
    await open();
    await check('合成员工丙');
    await click(pressable(heading(), '下载文件'));
    await settle(60);
    const files = () => fetched.filter((url) => url.pathname === `${RECORDS}/files`);
    expect(files().map((url) => url.searchParams.get('ids'))).toEqual([R3]);
    expect(saved).toEqual(['合成调动协议.pdf']);
    await check('合成员工甲');
    await click(pressable(heading(), '下载文件'));
    await settle(60);
    expect(files().at(-1)!.searchParams.get('ids')?.split(',').sort()).toEqual([R1, R3].sort());
    expect(noticeText()).toContain('只能下载已完成的签署文件');
    expect(saved).toHaveLength(1);
    // 电子文件列：已完成行的文件名可点下载；签署中行只显示文件名
    expect(pressable(rowOf('合成员工甲'), '合成调动协议，合成保密协议')).toBeUndefined();
    await click(pressable(rowOf('合成员工丙'), '合成调动协议'));
    await settle(60);
    expect(files().at(-1)!.searchParams.get('ids')).toBe(R3);
    expect(saved).toEqual(['合成调动协议.pdf', '合成调动协议.pdf']);
  });

  it('FE-03-11 迟到回调：全部页签的读取未返回时切到签署中，旧响应到达后不覆盖签署中的列表', async () => {
    let release!: () => void;
    await open();
    listGate = { tab: 'all', gate: new Promise<void>((done) => (release = done)) };
    await click(tab('签署完成'));
    await rendered();
    await click(tab('全部'));
    await click(tab('签署中'));
    await rendered();
    await act(async () => release());
    await settle(60);
    expect(host.querySelectorAll('.ant-table-tbody .ant-table-row')).toHaveLength(2);
    expect(rowOf('合成员工丁'), '全部页签的旧响应没有落到签署中').toBeUndefined();
    expect(tab('签署中')?.getAttribute('aria-selected')).toBe('true');
  });
});

/**
 * 结果未知（claude_fe_rules g）：命令钉在页面级存储（模块级 store）里，关闭重开、换一批勾选、换动作都仍锁定，
 * 只能由用户显式按原命令重发（同一命令 ID 与请求体）。钉住的状态会留到后续用例，所以这一组放在文件最后。
 */
describe('AC-TRF-F481-FE-03 签署记录：结果未知', () => {
  it('FE-03-12 提醒结果未知：锁定并可按原命令重发；关闭重开、含该行的撤销都不另起命令', async () => {
    writes = [
      { status: 503, body: { error: { code: 'SERVICE_UNAVAILABLE', message: '服务暂不可用' } } },
      { body: { items: [{ id: R6, ok: true }] } },
    ];
    await open();
    await check('合成员工己');
    await click(pressable(heading(), '提醒'));
    await settle(60);
    expect(modal()?.textContent).toContain('结果待确认');
    expect(sent).toHaveLength(1);
    await click(pressable(modal(), '关闭'));
    await rendered();
    await check('合成员工己');
    await click(pressable(heading(), '提醒'));
    expect(modal()?.textContent).toContain('结果待确认');
    expect(sent, '重开不另起命令').toHaveLength(1);
    await click(pressable(modal(), '关闭'));
    await rendered();
    // 换一批勾选、换动作：含未确认行的撤销被挡下，只提示，不弹确认框、不另起命令
    await check('合成员工己', '合成员工甲');
    await click(pressable(heading(), '撤销'));
    expect(modal()).toBeNull();
    expect(noticeText()).toContain('有结果待确认的操作');
    await settle(60);
    expect(sent, '含未确认行的撤销不另起命令').toHaveLength(1);
    await check('合成员工甲');
    await click(pressable(heading(), '提醒'));
    expect(modal()?.textContent).toContain('结果待确认');
    await click(pressable(modal(), '按原命令重发'));
    await settle(60);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.key).toBe(sent[0]!.key);
    expect(sent[1]!.body).toEqual(sent[0]!.body);
    expect(modal()?.textContent).toContain('已提醒');
    expect(modal()?.textContent).not.toContain('结果待确认');
  });
});

/** 在途时关闭弹窗：命令落定时弹窗已卸载，完成的命令留在模块级 store 里（关闭时仍锁定、没清掉），所以也放在最后。 */
describe('AC-TRF-F481-FE-03 签署记录：请求在途时关闭弹窗', () => {
  // 返工 P2-1 同类：关闭时列表就重读了，那时撤销尚未落定；落定后仍挂着的列表要再重读，不能停在旧状态与旧版本上。
  it('FE-03-13 撤销在途时关闭弹窗：回执到达后列表重读、显示已撤销，不另起命令', async () => {
    let release!: () => void;
    const landed = new Promise<void>((done) => (release = done)).then(() => {
      rows = ALL.map((row) => (row.id === R2 ? { ...row, status: 'revoked', revision: 4, currentNode: null } : row));
      return { body: { items: [{ id: R2, ok: true }] } };
    });
    writes = [landed];
    await open();
    await check('合成员工乙');
    await click(pressable(heading(), '撤销'));
    await click(pressable(modal(), '确定'));
    expect(modal()?.textContent).toContain('正在提交');
    await click(pressable(modal(), '关闭'));
    await rendered();
    expect(rowOf('合成员工乙')?.textContent, '关闭时撤销尚未落定').toContain('签署中');
    const before = lists().length;
    await act(async () => release());
    await settle(60);
    await rendered();
    expect(lists().length, '撤销落定后列表重读').toBeGreaterThan(before);
    expect(rowOf('合成员工乙')?.textContent).toContain('已撤销');
    expect(sent).toHaveLength(1);
  });
});
