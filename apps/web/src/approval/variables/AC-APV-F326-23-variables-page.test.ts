// @vitest-environment happy-dom
/**
 * AC-APV-F326-23：公共变量 / 应用变量管理页（F-326 F1）。原站口径 docs/02_业务建模/30 §公共变量 / 应用变量：
 * 两个页签 + 提示文案；列表列；行操作按状态（启用：编辑 / 停用 / ▾查看引用流程；停用：编辑 / 启用）；不提供删除。
 * 停用与「去掉流程适用范围」先读引用清单：有引用弹出影响提示与清单，确认后带 acknowledgedReferenceCount = total。
 * 页面经 PAGES 登记加载（不直接引用页面文件）；夹具形状照后端序列化（smoke/variable-fixtures.ts）。
 */
import { act, createElement as h, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAGES } from '../../foundation/routes.js';
import { SessionProvider } from '../../foundation/Session.js';
import { PermissionsProvider } from '../../foundation/Permissions.js';
import {
  ADMIN_USER,
  applicationVariable,
  page,
  publicVariable,
  reference,
  type ReferenceFixture,
} from '../../../smoke/variable-fixtures.js';

const API = '/api/tenant/approval/variables';
const PEOPLE = '/api/tenant/approval/designer/person-candidates';
const PUBLIC_PATH = '/config-center/global/public-variables';
const TRANSFER_PATH = '/config-center/apps/transfer/workflow/app-variables-transfer';
const WARNING = '以下流程引用了该变量，停用后这些节点将视为审批人为空，按节点空人策略处理';
const enabled = publicVariable();
const draft = publicVariable({
  id: '50000000-0000-4000-8000-000000000002',
  code: 'Global.B.SynthDraft',
  name: '合成草稿变量',
  dataType: 'string',
  defaultValue: null,
  usageScopes: ['process'],
  status: 'draft',
  revision: 1,
  people: [],
});
const disabled = publicVariable({
  id: '50000000-0000-4000-8000-000000000003',
  code: 'Global.B.SynthOff',
  name: '合成停用变量',
  status: 'disabled',
  revision: 4,
});
const appRow = applicationVariable('transfer');
const refs: ReferenceFixture[] = [
  reference(),
  reference({ versionKind: 'in_flight', versionNo: 1, instanceCount: 3, position: 'empty_approver' }),
];

let host: HTMLDivElement;
let root: Root;
let references: Record<string, ReferenceFixture[]>;
let writes: { url: string; method: string; body: unknown; headers: Headers }[];
let reads: string[];

const text = () => document.body.textContent ?? '';
const settle = async () => {
  for (let i = 0; i < 20; i += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
};
async function render(path: string, id: string) {
  const route = PAGES.configurations.find((item) => item.id === id);
  expect(route?.page, `${id} 页面登记`).toBeDefined();
  const Page = route!.page!.Component;
  await act(async () =>
    root.render(
      h(SessionProvider, {
        session: {
          tenantId: 'synthetic-tenant',
          identityKey: 'synthetic-admin',
          tenantName: '合成租户',
          timezone: 'Asia/Shanghai',
          displayName: '合成管理员',
          source: 'server',
        },
        children: h(PermissionsProvider, {
          children: h(MemoryRouter, {
            initialEntries: [path],
            children: h(Suspense, { fallback: null, children: h(Page) }),
          }),
        }),
      }),
    ),
  );
  for (let i = 0; i < 200 && !host.querySelector('table'); i += 1) await settle();
  await settle();
}
const squash = (node: Element | null) => node?.textContent?.replace(/\s/g, '') ?? '';
const buttons = (scope: ParentNode = document) =>
  [...scope.querySelectorAll('button')].map((node) => squash(node)).filter(Boolean);
const rowOf = (id: string) => document.querySelector<HTMLElement>(`tr[data-row-key="${id}"]`);
async function click(label: string, scope: ParentNode = document) {
  const target = [...scope.querySelectorAll<HTMLElement>('button, [role="tab"], [role="menuitem"]')].find(
    (node) => squash(node) === label,
  );
  expect(target, label).toBeDefined();
  await act(async () => target!.click());
  await settle();
}
// 关掉的弹窗可能留在 DOM 里（隐藏），只取仍在显示的最后一个
const lastDialog = () =>
  [...document.querySelectorAll<HTMLElement>('.ant-modal')]
    .filter((node) => node.closest<HTMLElement>('.ant-modal-wrap')?.style.display !== 'none')
    .at(-1)!;
function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
const field = (scope: ParentNode, name: string) =>
  scope.querySelector<HTMLInputElement>(`[id="${name}"], [id$="_${name}"]`);
const cells = (id: string) => [...rowOf(id)!.querySelectorAll('td')].map((cell) => cell.textContent ?? '');
const headers = () => [...document.querySelectorAll('thead th')].map((node) => node.textContent ?? '');

function respond(url: string, method: string, body: unknown) {
  const id = /variables\/([0-9a-f-]{36})/.exec(url)?.[1];
  const current = [enabled, draft, disabled, appRow].find((row) => row.id === id);
  if (method === 'POST' && url.endsWith(API))
    return Response.json(
      { ...enabled, ...(body as object), id: '50000000-0000-4000-8000-000000000009', revision: 1 },
      {
        status: 201,
      },
    );
  const status = url.endsWith('/disable') ? 'disabled' : url.endsWith('/enable') ? 'enabled' : current!.status;
  return Response.json({ ...current, status, revision: current!.revision + 1 });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  references = { [enabled.id]: refs, [draft.id]: [], [disabled.id]: [], [appRow.id]: [] };
  writes = [];
  reads = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      writes.push({ url, method, body, headers: new Headers(init?.headers) });
      return respond(url, method, body);
    }
    reads.push(url);
    if (url.endsWith('/permission/me/snapshot'))
      return Response.json({
        session: { tenantId: 'synthetic-tenant', timezone: 'Asia/Shanghai' },
        apps: [],
        scope: [],
        adminMenus: [],
      });
    if (url.startsWith(PEOPLE))
      return Response.json({
        items: [{ userId: ADMIN_USER, name: '合成管理员', code: 'A001', departmentId: null, departmentName: null }],
        page: 1,
        pageSize: 1,
        hasMore: false,
      });
    const refMatch = /variables\/([0-9a-f-]{36})\/references$/.exec(url);
    if (refMatch) {
      const items = references[refMatch[1]!] ?? [];
      return Response.json({ items, total: items.length });
    }
    const query = new URL(url, 'http://localhost').searchParams;
    if (query.get('scope') === 'application')
      return Response.json(page(query.get('status') === 'disabled' ? [] : [appRow]));
    return Response.json(page(query.get('status') === 'disabled' ? [disabled] : [enabled, draft]));
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

const listReads = () =>
  reads
    .filter((url) => new URL(url, 'http://localhost').pathname === API)
    .map((url) => Object.fromEntries(new URL(url, 'http://localhost').searchParams));
async function openMore(id: string) {
  await click('更多', rowOf(id)!);
}

describe('AC-APV-F326-23 公共变量管理页', () => {
  it('两个页签与提示文案；启用页签读草稿 + 启用，停用页签按 status=disabled 重读', async () => {
    await render(PUBLIC_PATH, 'public-variables');
    const tabs = [...document.querySelectorAll('[role="tab"]')].map((node) => squash(node));
    expect(tabs).toEqual(['启用的公共变量', '停用的公共变量']);
    expect(text()).toContain('当前页面展示草稿状态、启用状态的公共变量，各应用可使用列表展示的启用状态公共变量。');
    expect(listReads()[0]).toMatchObject({ scope: 'public', status: 'active' });
    expect(listReads()[0]).not.toHaveProperty('appId');
    expect(rowOf(enabled.id)).not.toBeNull();
    expect(rowOf(draft.id)).not.toBeNull();
    await click('停用的公共变量');
    expect(listReads().at(-1)).toMatchObject({ scope: 'public', status: 'disabled' });
    expect(rowOf(disabled.id)).not.toBeNull();
    expect(rowOf(enabled.id)).toBeNull();
  });

  it('列：编码 / 名称 / 数据类型 / 默认值 / 适用范围 / 状态 / 描述 / 最近修改人 / 最近修改时间 / 操作', async () => {
    await render(PUBLIC_PATH, 'public-variables');
    expect(headers()).toEqual([
      '编码',
      '名称',
      '数据类型',
      '默认值',
      '适用范围',
      '状态',
      '描述',
      '最近修改人',
      '最近修改时间',
      '操作',
    ]);
    const row = cells(enabled.id);
    expect(row.slice(0, 9)).toEqual([
      'Global.B.SynthPerson',
      '合成审批人变量',
      '人员',
      '合成员工甲',
      '全部',
      '启用',
      '合成说明',
      '合成管理员',
      '2026-11-02 11:04',
    ]);
    expect(cells(draft.id).slice(2, 6)).toEqual(['字符串', '--', '流程', '草稿']);
    expect(reads.some((url) => url.startsWith(PEOPLE) && url.includes(ADMIN_USER))).toBe(true);
  });

  it('行操作按状态：启用 编辑 / 停用 / 更多；草稿 编辑 / 启用 / 更多；停用 编辑 / 启用；全页无删除', async () => {
    await render(PUBLIC_PATH, 'public-variables');
    expect(buttons(rowOf(enabled.id)!)).toEqual(['编辑', '停用', '更多']);
    expect(buttons(rowOf(draft.id)!)).toEqual(['编辑', '启用', '更多']);
    expect(buttons()).toContain('新建');
    expect(buttons()).not.toContain('删除');
    await click('停用的公共变量');
    expect(buttons(rowOf(disabled.id)!)).toEqual(['编辑', '启用']);
    expect(buttons()).not.toContain('删除');
  });

  it('▾ 查看引用流程：弹窗列出流程、版本、节点与位置', async () => {
    await render(PUBLIC_PATH, 'public-variables');
    await openMore(enabled.id);
    await click('查看引用流程');
    expect(reads).toContain(`${API}/${enabled.id}/references`);
    const dialog = lastDialog();
    expect(dialog.textContent).toContain('引用流程');
    expect(dialog.textContent).toContain('合成调动流程');
    expect(dialog.textContent).toContain('P_SYNTH_TRANSFER');
    expect(dialog.textContent).toContain('合成会签节点');
    expect(dialog.textContent).toContain('3');
    expect(dialog.querySelectorAll('tbody tr[data-row-key]').length).toBe(2);
    expect(writes).toEqual([]);
  });

  it('停用有引用：先读引用，弹出影响提示与清单；取消不提交；确认带 acknowledgedReferenceCount = total 与本行版本', async () => {
    await render(PUBLIC_PATH, 'public-variables');
    await click('停用', rowOf(enabled.id)!);
    expect(reads).toContain(`${API}/${enabled.id}/references`);
    expect(lastDialog().textContent).toContain(WARNING);
    expect(lastDialog().textContent).toContain('合成调动流程');
    await click('取消', lastDialog());
    expect(writes).toEqual([]);
    await click('停用', rowOf(enabled.id)!);
    for (let i = 0; i < 100 && !lastDialog()?.textContent?.includes('确定停用'); i += 1) await settle();
    await click('确定', lastDialog());
    expect(writes.map((item) => [item.method, item.url])).toEqual([['POST', `${API}/${enabled.id}/disable`]]);
    expect(writes[0]!.body).toEqual({ acknowledgedReferenceCount: 2 });
    expect(writes[0]!.headers.get('if-match')).toBe(String(enabled.revision));
    expect(writes[0]!.headers.get('idempotency-key')).toBeTruthy();
  });

  it('停用无引用：普通确认，确认后 acknowledgedReferenceCount = 0', async () => {
    references[enabled.id] = [];
    await render(PUBLIC_PATH, 'public-variables');
    await click('停用', rowOf(enabled.id)!);
    expect(lastDialog().textContent).toContain('确定停用公共变量「合成审批人变量」吗？');
    expect(lastDialog().textContent).not.toContain(WARNING);
    await click('确定', lastDialog());
    expect(writes.map((item) => [item.url, item.body])).toEqual([
      [`${API}/${enabled.id}/disable`, { acknowledgedReferenceCount: 0 }],
    ]);
  });

  it('启用：草稿与停用行经确认后提交 enable，带本行版本', async () => {
    await render(PUBLIC_PATH, 'public-variables');
    await click('启用', rowOf(draft.id)!);
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('.ant-popover button')].at(-1);
    expect(confirm, '确认启用').toBeDefined();
    await act(async () => confirm!.click());
    await settle();
    expect(writes.map((item) => [item.method, item.url, item.headers.get('if-match')])).toEqual([
      ['POST', `${API}/${draft.id}/enable`, String(draft.revision)],
    ]);
  });

  it('新建：提示适用范围含义，编码带 Global.B. 前缀；缺省适用范围全部、状态草稿，If-Match 0', async () => {
    await render(PUBLIC_PATH, 'public-variables');
    await click('新建');
    const dialog = lastDialog();
    expect(dialog.textContent).toContain('新建公共变量');
    expect(dialog.textContent).toContain('适用范围=全部：表示在流程、业务规则中均可以使用该变量');
    for (const label of ['编码', '名称', '数据类型', '默认值', '适用范围', '状态', '描述'])
      expect(dialog.textContent, label).toContain(label);
    expect(dialog.textContent).toContain('Global.B.');
    type(field(dialog, 'codeSuffix')!, 'SynthNew');
    type(field(dialog, 'name')!, '合成新变量');
    type(field(dialog, 'defaultValue')!, '合成文本');
    await settle();
    await click('保存', dialog);
    expect(writes.map((item) => [item.method, item.url, item.headers.get('if-match')])).toEqual([['POST', API, '0']]);
    expect(writes[0]!.body).toEqual({
      scope: 'public',
      codeSuffix: 'SynthNew',
      name: '合成新变量',
      dataType: 'string',
      defaultValue: '合成文本',
      usageScopes: ['process', 'business_rule', 'message_template'],
      enable: false,
    });
  });

  it('编辑：编码与数据类型只读；去掉「流程」适用范围先读引用、确认后带 acknowledgedReferenceCount 补丁提交', async () => {
    await render(PUBLIC_PATH, 'public-variables');
    await click('编辑', rowOf(enabled.id)!);
    const dialog = lastDialog();
    expect(dialog.textContent).toContain('编辑公共变量');
    expect(field(dialog, 'codeSuffix')).toBeNull();
    expect(dialog.textContent).toContain('Global.B.SynthPerson');
    expect(dialog.textContent).not.toContain('草稿');
    const some = dialog.querySelector<HTMLInputElement>('input[type="radio"][value="some"]')!;
    await act(async () => some.click());
    await settle();
    const process = dialog.querySelector<HTMLInputElement>('input[type="checkbox"][value="process"]')!;
    expect(process.checked).toBe(true);
    await act(async () => process.click());
    await settle();
    await click('保存', dialog);
    expect(reads).toContain(`${API}/${enabled.id}/references`);
    expect(writes).toEqual([]);
    expect(lastDialog().textContent).toContain('合成调动流程');
    await click('确定', lastDialog());
    expect(writes.map((item) => [item.method, item.url, item.headers.get('if-match')])).toEqual([
      ['PATCH', `${API}/${enabled.id}`, String(enabled.revision)],
    ]);
    expect(writes[0]!.body).toEqual({
      usageScopes: ['business_rule', 'message_template'],
      acknowledgedReferenceCount: 2,
    });
  });

  it('编辑只改名称：不读引用、不带确认数', async () => {
    await render(PUBLIC_PATH, 'public-variables');
    await click('编辑', rowOf(enabled.id)!);
    const dialog = lastDialog();
    type(field(dialog, 'name')!, '合成改名变量');
    await settle();
    await click('保存', dialog);
    expect(reads.filter((url) => url.endsWith('/references'))).toEqual([]);
    expect(writes.map((item) => [item.method, item.body])).toEqual([['PATCH', { name: '合成改名变量' }]]);
  });

  it('停用后引用变化（409 APPROVAL_REFERENCES_CHANGED）：提示原因并刷新列表，不自动重提', async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith('/disable')) {
        writes.push({
          url: String(input),
          method: 'POST',
          body: JSON.parse(String(init!.body)),
          headers: new Headers(),
        });
        return Response.json(
          {
            error: {
              code: 'APPROVAL_REFERENCES_CHANGED',
              message: '引用该对象的流程节点已变化，请重新查看影响后再确认',
              details: { referenceCount: 3 },
            },
          },
          { status: 409 },
        );
      }
      return original(input, init);
    });
    await render(PUBLIC_PATH, 'public-variables');
    const before = listReads().length;
    await click('停用', rowOf(enabled.id)!);
    await click('确定', lastDialog());
    expect(writes).toHaveLength(1);
    expect(text()).toContain('引用该对象的流程节点已变化，请重新查看影响后再确认');
    expect(listReads().length).toBeGreaterThan(before);
  });

  it('编辑 409：重读最新版本后把名称改回原值再提交，带重读后的版本，不自动重提', async () => {
    const latest = { ...enabled, name: '合成他人改名', revision: enabled.revision + 1 };
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith(`${API}/${enabled.id}`) && method === 'GET') return Response.json(latest);
      if (method !== 'PATCH') return original(input, init);
      const headers = new Headers(init?.headers);
      writes.push({ url, method, body: JSON.parse(String(init!.body)), headers });
      if (writes.length === 1)
        return Response.json({ error: { code: 'REVISION_CONFLICT', message: '版本冲突' } }, { status: 409 });
      const body = writes.at(-1)!.body as object;
      return Response.json({ ...latest, ...body, revision: Number(headers.get('if-match')) + 1 });
    });
    await render(PUBLIC_PATH, 'public-variables');
    await click('编辑', rowOf(enabled.id)!);
    type(field(lastDialog(), 'name')!, '合成改名变量');
    await settle();
    await click('保存', lastDialog());
    expect(writes).toHaveLength(1);
    await click('重读最新版本', lastDialog());
    await click('已核对差异，继续编辑', lastDialog());
    expect(writes).toHaveLength(1);
    type(field(lastDialog(), 'name')!, enabled.name);
    await settle();
    await click('保存', lastDialog());
    expect(writes.map((item) => [item.body, item.headers.get('if-match')])).toEqual([
      [{ name: '合成改名变量' }, String(enabled.revision)],
      [{ name: enabled.name }, String(latest.revision)],
    ]);
  });

  // 第 2 轮 P2-3：打开时适用范围为「全部」，他人改成部分范围；409 重读回填后单选须跟着变成「指定范围」
  it('编辑 409：适用范围由全部变为部分，重读回填后显示「指定范围」与实际勾选，提交与显示一致', async () => {
    const latest = { ...enabled, usageScopes: ['business_rule'], revision: enabled.revision + 1 };
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith(`${API}/${enabled.id}`) && method === 'GET') return Response.json(latest);
      if (method !== 'PATCH') return original(input, init);
      const headers = new Headers(init?.headers);
      writes.push({ url, method, body: JSON.parse(String(init!.body)), headers });
      if (writes.length === 1)
        return Response.json({ error: { code: 'REVISION_CONFLICT', message: '版本冲突' } }, { status: 409 });
      const body = writes.at(-1)!.body as object;
      return Response.json({ ...latest, ...body, revision: Number(headers.get('if-match')) + 1 });
    });
    await render(PUBLIC_PATH, 'public-variables');
    await click('编辑', rowOf(enabled.id)!);
    const radio = (value: string) =>
      lastDialog().querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)!;
    const box = (value: string) =>
      lastDialog().querySelector<HTMLInputElement>(`input[type="checkbox"][value="${value}"]`);
    expect(radio('all').checked).toBe(true);
    type(field(lastDialog(), 'name')!, '合成改名变量');
    await settle();
    await click('保存', lastDialog());
    await click('重读最新版本', lastDialog());
    await click('已核对差异，继续编辑', lastDialog());
    expect(radio('some').checked, '回填部分范围后显示「指定范围」').toBe(true);
    expect(radio('all').checked).toBe(false);
    expect(box('business_rule')?.checked).toBe(true);
    expect(box('process')?.checked).toBe(false);
    expect(box('message_template')?.checked).toBe(false);
    await click('保存', lastDialog());
    expect(
      reads.filter((url) => url.endsWith('/references')),
      '未去掉「流程」不读引用',
    ).toEqual([]);
    expect(writes.map((item) => [item.body, item.headers.get('if-match')])).toEqual([
      [{ name: '合成改名变量' }, String(enabled.revision)],
      [{ name: '合成改名变量' }, String(latest.revision)],
    ]);
  });

  it('停用结果未知：本行锁定，编辑 / 停用都不可点，不生成新命令', async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (!String(input).endsWith('/disable')) return original(input, init);
      writes.push({ url: String(input), method: 'POST', body: JSON.parse(String(init!.body)), headers: new Headers() });
      throw new TypeError('synthetic network failure');
    });
    await render(PUBLIC_PATH, 'public-variables');
    await click('停用', rowOf(enabled.id)!);
    await click('确定', lastDialog());
    expect(writes).toHaveLength(1);
    expect(text()).toContain('处理中 / 结果待确认');
    const rowButton = (label: string) =>
      [...rowOf(enabled.id)!.querySelectorAll<HTMLButtonElement>('button')].find((node) => squash(node) === label);
    expect(rowButton('编辑')?.disabled).toBe(true);
    expect(rowButton('停用')?.disabled).toBe(true);
    expect(writes).toHaveLength(1);
  });

  // 第 2 轮 P2-4：51 条时第 2 页只剩 1 条，停用后总数变 50，页码须退回最后一页并重读，不留空列表
  it('边界：最后一页唯一一条停用后总数缩减，自动退回上一页并显示剩余记录', async () => {
    const last = publicVariable({
      id: '50000000-0000-4000-8000-000000000051',
      code: 'Global.B.SynthLast',
      name: '合成末页变量',
    });
    references = { ...references, [last.id]: [] };
    let total = 51;
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === `${API}/${last.id}/disable`) {
        writes.push({
          url: String(input),
          method: 'POST',
          body: JSON.parse(String(init!.body)),
          headers: new Headers(),
        });
        total = 50;
        return Response.json({ ...last, status: 'disabled', revision: last.revision + 1 });
      }
      if (url.pathname !== API || url.searchParams.get('status') !== 'active') return original(input, init);
      reads.push(String(input));
      const offset = Number(url.searchParams.get('offset'));
      const items = offset === 0 ? [draft] : total > 50 ? [last] : [];
      return Response.json({ ...page(items, offset), total });
    });
    await render(PUBLIC_PATH, 'public-variables');
    await act(async () => document.querySelector<HTMLElement>('.ant-pagination-item-2')!.click());
    await settle();
    expect(rowOf(last.id), '第 2 页唯一一条').not.toBeNull();
    await click('停用', rowOf(last.id)!);
    await click('确定', lastDialog());
    expect(writes.map((item) => [item.method, item.url])).toEqual([['POST', `${API}/${last.id}/disable`]]);
    expect(listReads().at(-1), '退回最后有效页重读').toMatchObject({ status: 'active', offset: '0' });
    expect(rowOf(draft.id), '显示剩余记录').not.toBeNull();
    expect(text()).not.toContain('暂无变量');
  });
});

describe('AC-APV-F326-23 应用变量管理页', () => {
  it('按路由应用读本应用变量；两个页签与提示文案；列不含适用范围与描述', async () => {
    await render(TRANSFER_PATH, 'app-variables-transfer');
    const tabs = [...document.querySelectorAll('[role="tab"]')].map((node) => squash(node));
    expect(tabs).toEqual(['启用的应用变量', '停用的应用变量']);
    expect(text()).toContain('当前页面展示草稿状态、启用状态的应用变量，本应用可使用列表展示的启用状态应用变量');
    expect(listReads()[0]).toMatchObject({ scope: 'application', appId: 'transfer', status: 'active' });
    expect(headers()).toEqual(['编码', '名称', '数据类型', '默认值', '状态', '最近修改人', '最近修改时间', '操作']);
    expect(cells(appRow.id).slice(0, 5)).toEqual(['B.SynthApp', '合成应用变量', '字符串', '合成默认值', '草稿']);
    await click('停用的应用变量');
    expect(listReads().at(-1)).toMatchObject({ scope: 'application', appId: 'transfer', status: 'disabled' });
  });

  it('边界：空页签显示暂无变量；超过一页（50）时翻到第 2 页按 offset=50 读取', async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname !== API || url.searchParams.get('status') !== 'active') return original(input, init);
      reads.push(String(input));
      return Response.json({ ...page([appRow], Number(url.searchParams.get('offset'))), total: 51 });
    });
    await render(TRANSFER_PATH, 'app-variables-transfer');
    expect(listReads()[0]).toMatchObject({ offset: '0', limit: '50' });
    const second = document.querySelector<HTMLElement>('.ant-pagination-item-2');
    expect(second, '第 2 页').not.toBeNull();
    await act(async () => second!.click());
    await settle();
    expect(listReads().at(-1)).toMatchObject({ status: 'active', offset: '50', limit: '50' });
    await click('停用的应用变量');
    expect(listReads().at(-1)).toMatchObject({ status: 'disabled', offset: '0' });
    expect(text()).toContain('暂无变量');
  });

  it('组织员工路径按 staff 读取', async () => {
    await render('/config-center/workflow/app-variables-staff', 'app-variables-staff');
    expect(listReads()[0]).toMatchObject({ scope: 'application', appId: 'staff', status: 'active' });
  });

  it('新建：编码前缀 B.，无适用范围与描述；按路由应用提交 appId', async () => {
    await render(TRANSFER_PATH, 'app-variables-transfer');
    await click('新建');
    const dialog = lastDialog();
    expect(dialog.textContent).toContain('新建应用变量');
    expect(dialog.textContent).toContain('B.');
    expect(dialog.textContent).not.toContain('适用范围');
    expect(dialog.textContent).not.toContain('描述');
    type(field(dialog, 'codeSuffix')!, 'SynthApp2');
    type(field(dialog, 'name')!, '合成应用变量乙');
    await settle();
    await click('保存', dialog);
    expect(writes.map((item) => [item.method, item.url])).toEqual([['POST', API]]);
    expect(writes[0]!.body).toEqual({
      scope: 'application',
      appId: 'transfer',
      codeSuffix: 'SynthApp2',
      name: '合成应用变量乙',
      dataType: 'string',
      enable: false,
    });
  });
});
