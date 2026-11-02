// @vitest-environment happy-dom
/**
 * F-323b（DEC-706）：设置 › 员工 › 人员类别页。原站口径见 docs/02_业务建模/17 §F-323：
 * 视图 启用 / 停用 / 全部；列 名称、顺序号、生效日期、失效日期、状态；列表按钮 新建；详情按钮 编辑、停用、删除。
 * 页面经 PAGES 登记加载（不直接引用页面文件）；按钮按 /permission/me/objects 的按钮授权显隐，不按角色写死。
 * 夹具形状由 tests/acceptance/AC-EMP-F323b-labels 用真实接口核对。
 */
import { act, createElement as h, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAGES } from '../foundation/routes.js';
import { menuNodes, type ServerSnapshot } from '../foundation/permission-snapshot.js';
import { SessionProvider } from '../foundation/Session.js';
import { PermissionsProvider } from '../foundation/Permissions.js';
import { tenantDate } from '../foundation/dates.js';
import { typeStore } from './commands.js';
import { employmentTypePermission, employmentTypeRow } from '../../smoke/employment-type-fixtures.js';

const OBJECT = 'TenantBase.EmploymentType';
const API = '/api/tenant/employment/employment-types';
const snapshotFixture = {
  session: { tenantId: 'synthetic-tenant', timezone: 'Asia/Shanghai' },
  apps: [],
  scope: [],
  adminMenus: [],
};
const enabledRow = employmentTypeRow({ expiryDate: '9999-12-31' });
const disabledRow = employmentTypeRow({
  id: '30000000-0000-4000-8000-000000000002',
  name: '合成类别乙',
  displayOrder: 20,
  enabled: false,
  revision: 3,
  expiryDate: '9999-12-31',
});
let host: HTMLDivElement;
let root: Root;
let permission: typeof employmentTypePermission;
let posts: { url: string; method: string; body: unknown; headers: Headers }[];

const entry = () => PAGES.entries.find((item) => item.id === 'employment-types');
const text = () => document.body.textContent ?? '';
const settle = async () => {
  for (let i = 0; i < 20; i += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
};
async function render() {
  expect(entry(), '人员类别设置页登记').toBeDefined();
  const Page = entry()!.page!.Component;
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
          children: h(MemoryRouter, { children: h(Suspense, { fallback: null, children: h(Page) }) }),
        }),
      }),
    ),
  );
  // 首个用例懒加载页面模块较慢：等 Suspense 换出页面后再等请求落定
  for (let i = 0; i < 200 && !host.firstElementChild; i += 1) await settle();
  await settle();
}
const buttons = (scope: ParentNode = document) =>
  [...scope.querySelectorAll('button')].map((node) => node.textContent?.replace(/\s/g, '') ?? '');
async function click(label: string, scope: ParentNode = document) {
  const button = [...scope.querySelectorAll('button, [role="tab"]')].find(
    (node) => node.textContent?.replace(/\s/g, '') === label,
  ) as HTMLElement | undefined;
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
  await settle();
}
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
const without = (...codes: string[]) => ({
  ...employmentTypePermission,
  buttons: employmentTypePermission.buttons.filter((button) => !codes.includes(button.buttonCode)),
});

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  permission = employmentTypePermission;
  posts = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/permission/me/snapshot')) return Response.json(snapshotFixture);
    if (url.endsWith(`/permission/me/objects/${OBJECT}`)) return Response.json(permission);
    if (method !== 'GET') {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      posts.push({ url, method, body, headers: new Headers(init?.headers) });
      if (method === 'POST' && url.endsWith(API))
        return Response.json(
          { ...enabledRow, id: '30000000-0000-4000-8000-000000000009', ...body, revision: 1 },
          {
            status: 201,
          },
        );
      return Response.json({ ...enabledRow, enabled: false, revision: enabledRow.revision + 1 });
    }
    if (url.includes(`${API}?view=disabled`)) return Response.json({ items: [disabledRow] });
    if (url.includes(`${API}?view=all`)) return Response.json({ items: [enabledRow, disabledRow] });
    if (url.includes(`${API}?view=enabled`)) return Response.json({ items: [enabledRow] });
    return Response.json({ items: [] });
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

describe('AC-FE-F323b 人员类别设置页', () => {
  it('登记在「企业设置」应用下，入口对象为人员类别；快照不含该对象时不显示', () => {
    expect(entry()).toMatchObject({
      app: 'settings',
      module: 'employment-types',
      label: '人员类别',
      objectCode: OBJECT,
      path: '/employment-types',
    });
    const snapshot = (entryObjects: string[]) =>
      ({ apps: [{ app: 'settings', visible: true, entryObjects }], adminMenus: [] }) as unknown as ServerSnapshot;
    expect(menuNodes(PAGES.menus, snapshot([])).some((item) => item.key === 'employment-types')).toBe(false);
    expect(menuNodes(PAGES.menus, snapshot([OBJECT])).some((item) => item.key === 'employment-types')).toBe(true);
  });

  it('三视图：默认读启用视图，列为名称、顺序号、生效日期、失效日期、状态；切到停用 / 全部按 view 重读', async () => {
    await render();
    const headers = [...document.querySelectorAll('th')].map((node) => node.textContent);
    expect(headers).toEqual(expect.arrayContaining(['名称', '顺序号', '生效日期', '失效日期', '状态']));
    const row = document.querySelector(`tr[data-row-key="${enabledRow.id}"]`);
    expect([...row!.querySelectorAll('td')].map((cell) => cell.textContent)).toEqual(
      expect.arrayContaining(['合成类别甲', '10', '2018-01-01', '9999-12-31', '启用']),
    );
    expect(text()).toContain('启用人员类别');
    await click('停用人员类别');
    expect(document.querySelector(`tr[data-row-key="${disabledRow.id}"]`)?.textContent).toContain('停用');
    expect(document.querySelector(`tr[data-row-key="${enabledRow.id}"]`)).toBeNull();
    await click('全部人员类别');
    expect(document.querySelectorAll('tbody tr[data-row-key]').length).toBe(2);
    const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
    for (const view of ['enabled', 'disabled', 'all']) expect(urls).toContain(`${API}?view=${view}`);
  });

  it('新建按列表级 create 按钮显隐；只填名称保存：顺序号排最后、生效日期为租户今天，If-Match 0', async () => {
    permission = without('create');
    await render();
    expect(buttons()).not.toContain('新建');
    await act(() => root.unmount());
    root = createRoot(host);
    permission = employmentTypePermission;
    await render();
    await click('新建');
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain('失效日期');
    type(dialog.querySelector<HTMLInputElement>('input[id$="name"]')!, '合成新类别');
    await settle();
    await click('保存', dialog);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toMatch(new RegExp(`${API}$`));
    expect(posts[0]!.headers.get('if-match')).toBe('0');
    expect(posts[0]!.body).toEqual({
      name: '合成新类别',
      displayOrder: 20,
      effectiveDate: tenantDate(new Date(), 'Asia/Shanghai'),
    });
  });

  it('详情：编辑 / 停用 / 删除按详情级按钮授权显隐，停用项给启用；停用带本行版本', async () => {
    permission = without('delete');
    await render();
    await click('合成类别甲');
    const drawer = () => document.querySelector<HTMLElement>('.detail-drawer')!;
    expect(drawer().textContent).toContain('2018-01-01');
    expect(buttons(drawer())).toEqual(expect.arrayContaining(['编辑', '停用']));
    expect(buttons(drawer())).not.toContain('删除');
    expect(buttons(drawer())).not.toContain('启用');
    await click('停用', drawer());
    const confirm = [...document.querySelectorAll('.ant-popconfirm button, .ant-popover button')].at(-1) as
      HTMLButtonElement | undefined;
    expect(confirm, '确认停用').toBeDefined();
    await act(async () => confirm!.click());
    await settle();
    expect(posts.map((post) => [post.method, post.url.replace(/^.*employment-types/, '')])).toEqual([
      ['POST', `/${enabledRow.id}/disable`],
    ]);
    expect(posts[0]!.headers.get('if-match')).toBe(String(enabledRow.revision));
  });

  it('停用视图的详情给「启用」，不给「停用」；没有 enable 按钮授权时不给', async () => {
    await render();
    await click('停用人员类别');
    await click('合成类别乙');
    const drawer = () => document.querySelector<HTMLElement>('.detail-drawer')!;
    expect(buttons(drawer())).toContain('启用');
    expect(buttons(drawer())).not.toContain('停用');
    await act(() => root.unmount());
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    permission = without('enable');
    await render();
    await click('停用人员类别');
    await click('合成类别乙');
    expect(buttons(drawer())).not.toContain('启用');
  });
});

describe('AC-FE-F455 人员类别审查后补', () => {
  it('P3-1 编辑清空失效日期时提交数据库默认的无限期日期', async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes(`${API}?view=enabled`))
        return Response.json({ items: [{ ...enabledRow, expiryDate: '2030-12-31' }] });
      return original(input, init);
    });
    await render();
    await click('合成类别甲');
    await click('编辑', document.querySelector('.detail-drawer')!);
    const dialog = document.querySelector<HTMLElement>('.ant-modal')!;
    const input = [...dialog.querySelectorAll<HTMLInputElement>('input')].find((item) => item.value === '2030-12-31')!;
    expect(input.value).toBe('2030-12-31');
    const clear = input.closest('.ant-picker')!.querySelector<HTMLElement>('.ant-picker-clear')!;
    await act(async () => clear.click());
    await settle();
    await click('保存', dialog);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.method).toBe('PUT');
    expect(posts[0]!.headers.get('if-match')).toBe('1');
    expect(posts[0]!.body).toEqual({ expiryDate: '9999-12-31' });
  });

  it('P3-4 顺序号不可编辑时不显示新建入口', async () => {
    permission = {
      ...employmentTypePermission,
      editableFields: employmentTypePermission.editableFields.filter((field) => field !== 'displayOrder'),
    };
    await render();
    expect(buttons()).not.toContain('新建');
    expect(posts).toEqual([]);
  });

  it('P3-5 删除回执丢失后回查确认记录消失，应关闭详情并释放原命令槽', async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    let removed = false;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (init?.method === 'DELETE') {
        posts.push({ url: String(input), method: 'DELETE', body: {}, headers: new Headers(init.headers) });
        removed = true;
        throw new TypeError('合成断网：删除已成功但回执丢失');
      }
      if (removed && String(input).includes(`${API}?view=`)) return Response.json({ items: [] });
      return original(input, init);
    });
    await render();
    await click('合成类别甲');
    await click('删除', document.querySelector('.detail-drawer')!);
    const confirm = [...document.querySelectorAll('.ant-popconfirm button')].at(-1) as HTMLButtonElement;
    await act(async () => confirm.click());
    await settle();
    expect(text()).toContain('结果待确认');
    await click('回查原单');
    expect(posts).toHaveLength(1);
    expect(document.querySelector('.detail-drawer') === null, '删除确认后关闭详情').toBe(true);
    const slot = JSON.stringify(['synthetic-tenant', 'synthetic-admin', `${API}/${enabledRow.id}`]);
    const holder = typeStore.holder([slot]);
    expect(holder && typeStore.get(holder), '删除确认后释放原命令').toBeUndefined();
  });
});
