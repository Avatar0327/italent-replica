/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * F-145（#322 第 4 轮 P2，DEC-773 归 B9）：继任记录的 id / 版本被字段权限裁剪或无效时，编辑、删除在提交前就拒绝：
 * 不发任何请求（不得出现 records/undefined），给出继任页面的中文提示，编辑表单保留草稿、可关闭；
 * 不在冲突内核登记命令，因此不会把锁落到集合键、误锁“新增”。正常编辑 / 删除 / 新增的请求路径与载荷不变。
 * 第 2 轮（审查 P2-1 / P2-2，DEC-431①）：批量结束按本次实际组包的记录（含 409 重读后的最新记录）逐条判定；
 * 删除按钮的坏行提示由调用方传入，设置页字典沿用只禁用、不出现“继任记录”；字典编辑同样提交前拒绝。
 * 夹具形状按后端：记录 apps/api/src/modules/succession/projection.ts RecordView；PUT 回执为记录 DTO，
 * DELETE 回执 { id, deleted: true }（routes.ts #6）；错误体 { error: { code, message } }（apps/api/src/errors.ts）；
 * 权限 /permission/me/objects/{code} 为 ObjectPermission，快照 /permission/me/snapshot 为 ServerSnapshot。
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { PermissionsProvider } = await import(resolve('apps/web/src/foundation/Permissions.tsx'));
const { ConflictCommands } = await import(resolve('apps/web/src/foundation/forms/ConflictCommands.tsx'));
const { MemoryRouter, Route, Routes } = requireWeb('react-router');
const { RecordForm, EndForm } = await import(resolve('apps/web/src/succession/RecordForm.tsx'));
const { RecordList } = await import(resolve('apps/web/src/succession/RecordList.tsx'));
const { SuccessionSettingsPage } = await import(resolve('apps/web/src/succession/SettingsPage.tsx'));
const { DeleteButton } = await import(resolve('apps/web/src/succession/conflict.tsx'));

const HINT = '该继任记录缺少标识或版本，请刷新列表后重新选择。';
const ITEM_HINT = '该条目缺少标识或版本，请刷新列表后重试。';
const READINESS = '/api/tenant/talent-review/readiness-levels';
const BASE = '/api/tenant/succession';
const RECORDS = `${BASE}/records`;
const R1 = '81450000-0000-4000-8000-000000000001';
const session = {
  tenantId: '10000000-0000-4000-8000-000000000145',
  userId: '20000000-0000-4000-8000-000000000145',
  identityKey: '20000000-0000-4000-8000-000000000145',
  tenantName: '合成租户',
  displayName: '合成用户',
  timezone: 'Asia/Shanghai',
  today: '2026-11-18',
  source: 'server',
};
const FIELDS = ['successionType', 'targetOrgId', 'successorEmployeeId', 'readinessId', 'startDate', 'endDate'];
const record = (revision: number, readinessId: string | null = null) => ({
  id: R1,
  revision,
  createdBy: '合成用户',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  successionType: 'org',
  targetOrgId: 'o-1',
  targetPositionId: null,
  successorEmployeeId: 'e-1',
  readinessId,
  backupType: 'principal',
  startDate: '2026-01-01',
  endDate: null,
  endReason: null,
  endSource: null,
  sourceKind: 'manual',
  status: 'active',
  successor: { id: 'e-1', name: '合成员工甲' },
  successorLeft: false,
  readiness: readinessId ? { id: readinessId, code: 'ready', name: '准备就绪', color: null } : null,
  targetOrg: { id: 'o-1', name: '合成研发部' },
  personInCharge: null,
});
type Row = ReturnType<typeof record>;
/** 准备度字典行：apps/api/src/modules/talent-review/readiness-service.ts view；版本被字段权限裁剪时没有 revision 键。 */
const readinessTrimmed = () => ({
  id: 'rd-1',
  code: 'ready',
  name: '准备就绪',
  description: null,
  color: '#146EFF',
  sortNo: 1,
  enabled: true,
  createdBy: '合成用户',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedBy: '合成用户',
  updatedAt: '2026-01-01T00:00:00.000Z',
});
const READINESS_FIELDS = ['code', 'name', 'description', 'color', 'sortNo', 'enabled'];

interface Sent {
  method: string;
  path: string;
  body: unknown;
  ifMatch: string | null;
}
let fetched: string[];
let sent: Sent[];
let writes: Response[];
/** 记录列表、记录详情（批量结束 409 后逐条重读）、准备度字典列表的返回。 */
let listed: object[];
let detail: object;
let levels: object[];
/** 列表页按钮权限（行内编辑 / 删除、勾选）；直接渲染表单 / 按钮的用例不依赖它。 */
let buttons: { buttonCode: string; level: string }[];
const ROW_BUTTONS = [
  { buttonCode: 'update', level: 'detail' },
  { buttonCode: 'delete', level: 'detail' },
];
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
function reply(path: string, method: string): Response {
  if (path.endsWith('/permission/me/snapshot')) return json(200, { session, apps: [], scope: [], adminMenus: [] });
  if (path.includes('/permission/me/objects/')) {
    const objectCode = decodeURIComponent(path.split('/').at(-1)!);
    return json(200, {
      objectCode,
      dataOperations: { read: true, create: true, update: true, delete: true },
      viewableFields: objectCode === 'TalentReview.Readiness' ? READINESS_FIELDS : FIELDS,
      editableFields: objectCode === 'TalentReview.Readiness' ? READINESS_FIELDS : FIELDS,
      buttons,
    });
  }
  if (method !== 'GET') return writes.shift() ?? json(500, { error: { code: 'UNEXPECTED', message: '合成错误' } });
  if (path === `${BASE}/readiness`) return json(200, { items: [{ id: 'rd-1', name: '准备就绪' }], total: 1 });
  if (path === RECORDS)
    return json(200, {
      page: 1,
      pageSize: 15,
      total: listed.length,
      asOf: '2026-11-18',
      hasDataPermission: true,
      items: listed,
    });
  if (path === `${RECORDS}/${R1}`) return json(200, detail);
  if (path === READINESS) return json(200, { page: 1, pageSize: 15, hasDataPermission: true, items: levels });
  if (path === '/api/tenant/org/organizations')
    return json(200, { items: [{ id: 'o-1', name: '合成研发部' }], total: 1, page: 1, pageSize: 200 });
  if (path === `${BASE}/successor-candidates`) return json(200, { items: [{ employeeId: 'e-1', name: '合成员工甲' }] });
  return json(404, { error: { code: 'NOT_FOUND', message: '合成错误' } });
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
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
  fetched = [];
  sent = [];
  writes = [];
  listed = [];
  detail = record(3);
  levels = [];
  buttons = [];
  vi.stubGlobal('fetch', async (raw: string, init: RequestInit = {}) => {
    const url = new URL(String(raw), 'http://localhost');
    const method = init.method ?? 'GET';
    fetched.push(`${method} ${url.pathname}`);
    if (method !== 'GET' && !url.pathname.includes('/permission/')) {
      const headers = new Headers(init.headers);
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      sent.push({ method, path: url.pathname, body, ifMatch: headers.get('if-match') });
    }
    return reply(url.pathname, method);
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const render = (...children: unknown[]) =>
  act(async () =>
    root.render(h(SessionProvider, { session }, h(PermissionsProvider, null, h(ConflictCommands, null, ...children)))),
  );
const settle = (ms = 50) => act(() => new Promise((done) => setTimeout(done, ms)));
const dialog = (title: string) =>
  Array.from(document.querySelectorAll<HTMLElement>('.ant-modal')).find(
    (modal) => modal.querySelector('.ant-modal-title')?.textContent === title,
  );
const buttonOf = (scope: ParentNode, name: string) =>
  Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.replace(/\s/g, '') === name,
  );
const itemOf = (scope: ParentNode, label: string) =>
  Array.from(scope.querySelectorAll<HTMLElement>('.ant-form-item')).find(
    (item) => item.querySelector('label')?.textContent === label,
  )!;
async function click(element: Element) {
  await act(async () => (element as HTMLElement).click());
  await settle();
}
/** 打开字段的下拉并选中指定选项（antd Select 在 mousedown 时展开）。 */
async function choose(scope: ParentNode, label: string, option: string) {
  const selector = itemOf(scope, label).querySelector('.ant-select-selector')!;
  await act(async () => selector.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  const find = () =>
    Array.from(document.querySelectorAll<HTMLElement>('.ant-select-item-option')).find(
      (item) => item.textContent === option,
    );
  await vi.waitFor(() => expect(find(), `${label}：${option}`).toBeTruthy());
  await click(find()!);
}
const shown = (scope: ParentNode, label: string) =>
  itemOf(scope, label).querySelector('.ant-select-selection-item')?.textContent;
async function openEdit(row: Partial<Row>, close = vi.fn(), saved = vi.fn()) {
  await render(h(RecordForm, { key: 'edit', type: 'org', row, close, saved }));
  await vi.waitFor(() => expect(dialog('编辑继任')).toBeTruthy());
  await vi.waitFor(() => expect(fetched).toContain(`GET ${BASE}/readiness`));
  await settle();
  return { modal: dialog('编辑继任')!, close, saved };
}
const writesTo = () => sent.map((item) => `${item.method} ${item.path}`);
// 列表读取本身是 GET /records；写请求不得落到裸集合路径，任何请求都不得带 undefined / null / NaN。
const noUndefinedPath = () =>
  expect(fetched.filter((line) => /undefined|null|NaN/.test(line) || /^(?!GET).*\/records\/?$/.test(line))).toEqual([]);
/** 悬停发到元素本身（antd 触发器监听 onPointerEnter，由 pointerover 合成）。 */
async function hover(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    element.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
  });
  await settle(200);
}
const tooltips = () =>
  Array.from(document.querySelectorAll('.ant-tooltip:not(.ant-tooltip-hidden) .ant-tooltip-inner')).map(
    (tip) => tip.textContent,
  );
const errorsOf = (scope: ParentNode) =>
  Array.from(scope.querySelectorAll('.ant-alert-error')).map((alert) => alert.textContent);

describe('AC-FE-F145 编辑：缺 id / 版本时提交前拒绝', () => {
  const broken: [string, Partial<Row>][] = [
    ['id 缺失', { ...record(3), id: undefined }],
    ['id 为空串', { ...record(3), id: '' }],
    ['revision 缺失', { ...record(3), revision: undefined }],
    ['revision 非有限数', { ...record(3), revision: Number.NaN }],
  ];
  it.each(broken)('AC-FE-F145-01 %s：不发请求、显示中文提示、保留草稿可关闭，新增入口不被锁', async (_, row) => {
    // 万一请求发出去，按结果未知（503）回：旧缺陷下锁会落到集合键，新增入口随之锁定。
    writes = [json(503, { error: { code: 'SERVICE_UNAVAILABLE', message: '合成错误' } })];
    const { modal, close } = await openEdit(row);
    await choose(modal, '准备度', '准备就绪');
    const before = fetched.length;
    await click(buttonOf(modal, '保存')!);
    await vi.waitFor(() => expect(modal.querySelector('.ant-alert-error')?.textContent).toBe(HINT));
    // 点保存后没有任何请求（含详情回查之类的 GET）。
    expect(fetched.slice(before)).toEqual([]);
    expect(sent).toEqual([]);
    noUndefinedPath();
    // 草稿保留，表单未锁定，可关闭。
    expect(shown(modal, '准备度')).toBe('准备就绪');
    expect(buttonOf(modal, '保存')!.disabled).toBe(false);
    await click(buttonOf(modal, '取消')!);
    expect(close).toHaveBeenCalledTimes(1);
    // 同一页面里打开新增：不是“处理中 / 结果待确认”，可正常填写保存。
    await render(h(RecordForm, { key: 'create', type: 'org', close: vi.fn(), saved: vi.fn() }));
    await vi.waitFor(() => expect(dialog('新增组织继任')?.querySelector('form')).toBeTruthy());
    expect(buttonOf(dialog('新增组织继任')!, '保存')!.disabled).toBe(false);
    expect(sent).toEqual([]);
  });

  it('AC-FE-F145-02 正常编辑不受影响：PUT records/{id}，带打开时的版本，只发改过的字段', async () => {
    writes = [json(200, record(4, 'rd-1'), { etag: '"4"' })];
    const { modal, close, saved } = await openEdit(record(3));
    await choose(modal, '准备度', '准备就绪');
    await click(buttonOf(modal, '保存')!);
    await vi.waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
    expect(sent).toEqual([{ method: 'PUT', path: `${RECORDS}/${R1}`, body: { readinessId: 'rd-1' }, ifMatch: '3' }]);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('AC-FE-F145 删除：缺 id / 版本时不发 DELETE，并给出提示', () => {
  const broken: [string, object][] = [
    ['id 缺失', { revision: 3 }],
    ['id 为空串', { id: '', revision: 3 }],
    ['revision 缺失', { id: R1 }],
    ['revision 非有限数', { id: R1, revision: Number.POSITIVE_INFINITY }],
  ];
  it.each(broken)('AC-FE-F145-03 %s：按钮不可用、悬停显示中文提示，点击不发请求', async (_, row) => {
    const settled = vi.fn();
    await render(h(DeleteButton, { base: RECORDS, row, settled, invalidHint: HINT }));
    await settle();
    const button = buttonOf(host, '删除')!;
    expect(button.disabled).toBe(true);
    await hover(button);
    expect(tooltips()).toEqual([HINT]);
    await click(button);
    expect(document.querySelector('.ant-popover')).toBeNull();
    expect(sent).toEqual([]);
    noUndefinedPath();
    expect(settled).not.toHaveBeenCalled();
  });

  it('AC-FE-F145-04 未选中记录：按钮照旧只禁用，不显示提示', async () => {
    await render(h(DeleteButton, { base: RECORDS, row: undefined, settled: vi.fn(), invalidHint: HINT }));
    await settle();
    const button = buttonOf(host, '删除')!;
    expect(button.disabled).toBe(true);
    await hover(button);
    expect(tooltips()).toEqual([]);
  });

  it('AC-FE-F145-05 正常删除不受影响：确认后 DELETE records/{id}，带记录版本', async () => {
    writes = [json(200, { id: R1, deleted: true })];
    const settled = vi.fn();
    await render(h(DeleteButton, { base: RECORDS, row: { id: R1, revision: 3 }, settled }));
    await settle();
    await click(buttonOf(host, '删除')!);
    await vi.waitFor(() => expect(document.querySelector('.ant-popover .ant-btn-primary')).not.toBeNull());
    await click(document.querySelector('.ant-popover .ant-btn-primary')!);
    await vi.waitFor(() => expect(settled).toHaveBeenCalledWith());
    expect(sent).toEqual([{ method: 'DELETE', path: `${RECORDS}/${R1}`, body: undefined, ifMatch: '3' }]);
  });
});

describe('AC-FE-F145 新增不受影响', () => {
  it('AC-FE-F145-06 新增：POST records，载荷按 createRecordBody', async () => {
    writes = [json(201, record(1), { etag: '"1"' })];
    const close = vi.fn();
    const saved = vi.fn();
    await render(h(RecordForm, { type: 'org', close, saved }));
    await vi.waitFor(() => expect(dialog('新增组织继任')?.querySelector('form')).toBeTruthy());
    const modal = dialog('新增组织继任')!;
    await choose(modal, '组织名称', '合成研发部');
    await choose(modal, '继任者', '合成员工甲');
    await click(buttonOf(modal, '保存')!);
    await vi.waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
    expect(writesTo()).toEqual([`POST ${RECORDS}`]);
    expect(sent[0]!.body).toEqual({
      successionType: 'org',
      targetOrgId: 'o-1',
      successorEmployeeId: 'e-1',
      startDate: '2026-11-18',
    });
    expect(close).toHaveBeenCalledTimes(1);
  });
});

const CONFLICT = () => json(409, { error: { code: 'REVISION_CONFLICT', message: '合成冲突' } });
async function openEnd(rows: Partial<Row>[], close = vi.fn(), saved = vi.fn()) {
  await render(h(EndForm, { rows, close, saved }));
  await vi.waitFor(() => expect(dialog('结束继任')?.querySelector('form')).toBeTruthy());
  await settle();
  return { modal: dialog('结束继任')!, close, saved };
}
/** 首次保存收到 409：弹窗内重读最新版本、核对差异后继续，再点保存。 */
async function conflictThenResubmit(modal: HTMLElement) {
  await click(buttonOf(modal, '保存')!);
  await vi.waitFor(() => expect(buttonOf(modal, '重读最新版本')).toBeTruthy());
  await click(buttonOf(modal, '重读最新版本')!);
  await vi.waitFor(() => expect(buttonOf(modal, '已核对差异，继续编辑')).toBeTruthy());
  await click(buttonOf(modal, '已核对差异，继续编辑')!);
  await click(buttonOf(modal, '保存')!);
}
const FIRST_END = { items: [{ id: R1, expectedRevision: 3 }], endDate: '2026-11-18' };

describe('AC-FE-F145 批量结束：本次实际组包的记录缺 id / 版本时提交前拒绝', () => {
  const broken: [string, Partial<Row>][] = [
    ['id 缺失', { ...record(3), id: undefined }],
    ['revision 缺失', { ...record(3), revision: undefined }],
  ];
  it.each(broken)('AC-FE-F145-07 初选记录%s：零次 POST，显示中文提示，表单可关闭', async (_, row) => {
    writes = [json(503, { error: { code: 'SERVICE_UNAVAILABLE', message: '合成错误' } })];
    const { modal, close } = await openEnd([row]);
    const before = fetched.length;
    await click(buttonOf(modal, '保存')!);
    await vi.waitFor(() => expect(errorsOf(modal)).toEqual([HINT]));
    expect(fetched.slice(before)).toEqual([]);
    expect(sent).toEqual([]);
    expect(buttonOf(modal, '保存')!.disabled).toBe(false);
    await click(buttonOf(modal, '取消')!);
    expect(close).toHaveBeenCalledTimes(1);
  });

  const trimmed: [string, Partial<Row>][] = [
    ['缺 id', { ...record(5), id: undefined }],
    ['缺 revision', { ...record(5), revision: undefined }],
  ];
  it.each(trimmed)('AC-FE-F145-08 首次 409 后重读的记录%s：POST 总数仍为 1，显示中文提示', async (_, latest) => {
    writes = [CONFLICT(), json(200, { items: [record(6)] })];
    detail = latest;
    const { modal, saved } = await openEnd([record(3)]);
    await conflictThenResubmit(modal);
    await vi.waitFor(() => expect(errorsOf(modal)).toEqual([HINT]));
    expect(writesTo()).toEqual([`POST ${RECORDS}/end`]);
    expect(sent[0]!.body).toEqual(FIRST_END);
    noUndefinedPath();
    expect(saved).not.toHaveBeenCalled();
  });

  it('AC-FE-F145-09 首次 409 后重读到完整记录：按最新版本重提，第二次 POST 带新版本', async () => {
    writes = [CONFLICT(), json(200, { items: [record(6)] })];
    detail = record(5);
    const { modal, saved } = await openEnd([record(3)]);
    await conflictThenResubmit(modal);
    await vi.waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
    expect(writesTo()).toEqual([`POST ${RECORDS}/end`, `POST ${RECORDS}/end`]);
    expect(sent.map((item) => item.body)).toEqual([
      FIRST_END,
      { items: [{ id: R1, expectedRevision: 5 }], endDate: '2026-11-18' },
    ]);
  });
});

describe('AC-FE-F145 删除提示由调用方决定：记录列表专用提示，设置页字典沿用只禁用', () => {
  it('AC-FE-F145-10 继任记录列表：勾选版本被裁剪的记录，删除禁用并悬停显示记录专用提示', async () => {
    listed = [{ ...record(3), revision: undefined }];
    buttons = ROW_BUTTONS;
    await render(h(RecordList, { type: 'org', title: '组织继任' }));
    await vi.waitFor(() => expect(host.querySelector('.ant-table-tbody input[type=checkbox]')).toBeTruthy());
    await click(host.querySelector('.ant-table-tbody input[type=checkbox]')!);
    const button = buttonOf(host, '删除')!;
    expect(button.disabled).toBe(true);
    await hover(button);
    expect(tooltips()).toEqual([HINT]);
    expect(sent).toEqual([]);
  });

  const settings = () =>
    render(
      h(
        MemoryRouter,
        { initialEntries: ['/succession/settings/readiness'] },
        h(Routes, null, h(Route, { path: '/succession/settings/:section', element: h(SuccessionSettingsPage) })),
      ),
    );
  it('AC-FE-F145-11 设置页准备度字典：版本被裁剪的行删除只禁用，悬停不出现“继任记录”', async () => {
    levels = [readinessTrimmed()];
    buttons = ROW_BUTTONS;
    await settings();
    await vi.waitFor(() => expect(buttonOf(host, '删除')).toBeTruthy());
    const button = buttonOf(host, '删除')!;
    expect(button.disabled).toBe(true);
    await hover(button);
    expect(tooltips()).toEqual([]);
    expect(document.body.textContent).not.toContain('继任记录');
    await click(button);
    expect(sent).toEqual([]);
  });

  it('AC-FE-F145-12 设置页准备度字典：版本被裁剪的行编辑提交前拒绝，零请求，提示不提“继任记录”', async () => {
    levels = [readinessTrimmed()];
    buttons = ROW_BUTTONS;
    await settings();
    await vi.waitFor(() => expect(buttonOf(host, '编辑')).toBeTruthy());
    await click(buttonOf(host, '编辑')!);
    await vi.waitFor(() => expect(dialog('编辑准备度')?.querySelector('form')).toBeTruthy());
    const modal = dialog('编辑准备度')!;
    const before = fetched.length;
    await click(buttonOf(modal, '保存')!);
    await vi.waitFor(() => expect(errorsOf(modal)).toEqual([ITEM_HINT]));
    expect(fetched.slice(before)).toEqual([]);
    expect(sent).toEqual([]);
    expect(buttonOf(modal, '保存')!.disabled).toBe(false);
  });
});
