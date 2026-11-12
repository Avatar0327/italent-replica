// @vitest-environment happy-dom
import { act, createElement as h, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomFieldDefinitionsPage } from './CustomFieldDefinitionsPage.js';
import { pages } from './pages.js';
import { SessionProvider } from '../foundation/Session.js';
import { PermissionsProvider } from '../foundation/Permissions.js';

const OBJECT = 'TenantBase.EmploymentCustomField';
const permissionFixture = {
  objectCode: OBJECT,
  dataOperations: { create: true, update: true, delete: false },
  buttons: [],
  viewableFields: ['id', 'revision', 'name', 'objectType', 'valueType', 'inherit'],
  editableFields: ['name', 'objectType', 'valueType', 'inherit'],
};
const snapshotFixture = {
  session: { tenantId: 'synthetic-tenant', timezone: 'Asia/Shanghai' },
  apps: [],
  scope: [],
  adminMenus: [],
};
const row = {
  id: '30000000-0000-4000-8000-000000000001',
  revision: 1,
  name: '合成备注',
  objectType: 'employment',
  valueType: 'text',
  inherit: true,
};
let mode = 'success';
let currentRow = { ...row };
let host: HTMLDivElement;
let root: Root;
let permission: typeof permissionFixture;
let posts: { url: string; method: string; body: unknown; headers: Headers }[];

const entry = () => pages.entries!.find((item) => item.id === 'custom-field-definitions');
const text = () => document.body.textContent ?? '';
const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
};
async function render() {
  expect(entry(), '自定义字段设置页登记').toBeDefined();
  const Page = CustomFieldDefinitionsPage;
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
async function chooseObject(label: string) {
  const select = document.querySelector('.ant-select-selector');
  expect(select, '对象类型下拉框').not.toBeNull();
  await act(() => select!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  await settle();
  const option = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')].find(
    (node) => node.textContent === label,
  );
  expect(option).toBeDefined();
  await act(() => option!.click());
  await settle();
}
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  permission = permissionFixture;
  mode = 'success';
  currentRow = { ...row };
  posts = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/permission/me/snapshot')) return Response.json(snapshotFixture);
    if (url.endsWith(`/permission/me/objects/${OBJECT}`)) return Response.json(permission);
    if (method !== 'GET') {
      const body = JSON.parse(String(init?.body));
      posts.push({ url, method, body, headers: new Headers(init?.headers) });
      if (mode === 'unknown') throw new TypeError('synthetic network failure');
      if (mode === 'conflict' && posts.length === 1) {
        currentRow = { ...row, revision: 2, inherit: false };
        return Response.json({ error: { code: 'REVISION_CONFLICT' } }, { status: 409 });
      }
      return Response.json(
        {
          ...currentRow,
          ...body,
          revision: method === 'POST' ? 1 : Number(new Headers(init?.headers).get('if-match')) + 1,
        },
        { status: method === 'POST' ? 201 : 200 },
      );
    }
    return Response.json({ items: url.includes('objectType=employment') ? [currentRow] : [] });
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

describe('AC-FE-F4746b0 定义管理', () => {
  it('AC-F474-FE01 通过登记入口展示字段，配置对象按数据操作授权，无按钮码依赖', async () => {
    expect(entry()).toMatchObject({ app: 'settings', objectCode: OBJECT, label: '自定义字段' });
    await render();
    expect([...document.querySelectorAll('th')].map((node) => node.textContent)).toEqual([
      '名称',
      '类型',
      '对象',
      '是否继承',
      '操作',
    ]);
    expect(text()).toContain('合成备注');
    expect(buttons()).toContain('新建');
    await chooseObject('组织');
    expect(buttons()).not.toContain('新建');
    expect([...document.querySelectorAll('th')].map((node) => node.textContent)).toEqual(['名称', '类型', '对象']);
    await chooseObject('人员');
    expect(buttons()).not.toContain('新建');
  });
  it('AC-F474-FE02 新建选择现有类型，提交真实协议字段并刷新', async () => {
    await render();
    await click('新建');
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    type(dialog.querySelector<HTMLInputElement>('input[id$="name"]')!, '合成新字段');
    await settle();
    await click('保存', dialog);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({ name: '合成新字段', objectType: 'employment', valueType: 'text' });
    expect(posts[0]!.headers.get('if-match')).toBe('0');
    expect(posts[0]!.headers.get('idempotency-key')).toBeTruthy();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it('AC-F474-FE03 缺少类型编辑权时不给新建入口', async () => {
    permission = { ...permissionFixture, editableFields: ['name', 'objectType', 'inherit'] };
    await render();
    expect(buttons()).not.toContain('新建');
  });
  it('AC-F474-FE05 继承值未变直接关闭，409 重读后改回原值以新 revision 提交', async () => {
    await render();
    await click('设置继承');
    await click('保存', document.querySelector('[role="dialog"]')!);
    expect(posts).toHaveLength(0);
    await click('设置继承');
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
    const toggle = async () => {
      await act(() => dialog().querySelector<HTMLElement>('[role="switch"]')!.click());
      await settle();
    };
    mode = 'conflict';
    await toggle();
    await click('保存', dialog());
    expect(posts[0]!.body).toEqual({ inherit: false });
    await click('重读最新版本', dialog());
    await click('已核对差异，继续编辑', dialog());
    await toggle();
    await click('保存', dialog());
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toEqual({ inherit: true });
    expect(posts[1]!.headers.get('if-match')).toBe('2');
  });
  it('AC-F474-FE07 继承结果未知，关闭重开锁定，按原命令重试保留正文和版本', async () => {
    mode = 'unknown';
    await render();
    await click('设置继承');
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(() => dialog().querySelector<HTMLElement>('[role="switch"]')!.click());
    await click('保存', dialog());
    await click('取消', dialog());
    await click('设置继承');
    expect(dialog().querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(true);
    expect(posts).toHaveLength(1);
    mode = 'success';
    await click('按原命令重试', dialog());
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toEqual({ inherit: false });
    expect([...posts[1]!.headers]).toEqual([...posts[0]!.headers]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it('AC-F474-FE04 创建结果未知，关闭重开保留原命令和原输入', async () => {
    mode = 'unknown';
    await render();
    await click('新建');
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
    type(dialog().querySelector<HTMLInputElement>('input[id$="name"]')!, '合成待确认字段');
    await settle();
    await click('保存', dialog());
    expect(posts).toHaveLength(1);
    await click('取消', dialog());
    await click('新建');
    expect(dialog().querySelector<HTMLInputElement>('input[id$="name"]')!.value).toBe('合成待确认字段');
    const save = [...dialog().querySelectorAll('button')].find(
      (node) => node.textContent?.replace(/\s/g, '') === '保存',
    );
    expect(save?.disabled).toBe(true);
    expect(posts).toHaveLength(1);
  });
});
