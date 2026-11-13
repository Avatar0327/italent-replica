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
  // 真实 GET 形状（configuration.ts fieldSelect）：非 select 也返回 options: []。
  options: [] as { value: string; label: string; enabled: boolean }[],
};
let mode = 'success';
let currentRow = { ...row };
let conflictRow: typeof row | undefined;
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
  conflictRow = undefined;
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
        currentRow = conflictRow ?? { ...row, revision: 2, inherit: false };
        return Response.json({ error: { code: 'REVISION_CONFLICT' } }, { status: 409 });
      }
      // 与后端 setCustomFieldOptions 同一规则（configuration.ts）：已保存的选项编码缺一个即 400。
      const saved = currentRow.options.map((option) => option.value);
      const sent = (body as { options?: { value: string }[] }).options?.map((option) => option.value);
      if (url.endsWith('/options') && saved.some((value) => !sent?.includes(value))) {
        return Response.json(
          { error: { code: 'VALIDATION_FAILED', message: '已有选项不可删除或修改编码' } },
          { status: 400 },
        );
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
  it('AC-F474-0BFE01 新建单选时编辑选项，以稳定编码提交 options', async () => {
    permission = {
      ...permissionFixture,
      viewableFields: [...permissionFixture.viewableFields, 'options'],
      editableFields: [...permissionFixture.editableFields, 'options'],
    };
    await render();
    await click('新建');
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    type(dialog.querySelector<HTMLInputElement>('input[id$="name"]')!, '合成下拉');
    await act(() =>
      dialog
        .querySelector('input[id$="valueType"]')!
        .closest('.ant-select')!
        .querySelector('.ant-select-selector')!
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true })),
    );
    await settle();
    const select = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')].find(
      (node) => node.textContent === '单选下拉',
    );
    expect(select, '第六种类型为单选下拉').toBeDefined();
    await act(() => select!.click());
    await settle();
    await click('新增选项', dialog);
    type(dialog.querySelector<HTMLInputElement>('[aria-label="选项名称 1"]')!, '合成东区');
    await settle();
    await click('保存', dialog);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({
      name: '合成下拉',
      objectType: 'employment',
      valueType: 'select',
      options: [{ value: expect.any(String), label: '合成东区', enabled: true }],
    });
  });

  it('AC-F474-0BFE02 选项结果未知，重开锁定编辑器并复用原命令', async () => {
    permission = {
      ...permissionFixture,
      viewableFields: [...permissionFixture.viewableFields, 'options'],
      editableFields: [...permissionFixture.editableFields, 'options'],
    };
    Object.assign(currentRow, { valueType: 'select', options: [{ value: 'east', label: '合成东区', enabled: true }] });
    mode = 'unknown';
    await render();
    await click('编辑选项');
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
    type(dialog().querySelector<HTMLInputElement>('[aria-label="选项名称 1"]')!, '合成新区');
    await settle();
    await click('保存', dialog());
    await click('取消', dialog());
    await click('编辑选项');
    expect(dialog().querySelector<HTMLInputElement>('[aria-label="选项名称 1"]')!.disabled).toBe(true);
    mode = 'success';
    await click('按原命令重试', dialog());
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toEqual({ options: [{ value: 'east', label: '合成新区', enabled: true }] });
    expect(posts[1]!.url).toContain('/options');
    expect([...posts[1]!.headers]).toEqual([...posts[0]!.headers]);
  });

  it('AC-F474-0BFE03 选项 409 重读后显示他人改名，改回打开时的原名以新 revision 提交', async () => {
    permission = {
      ...permissionFixture,
      viewableFields: [...permissionFixture.viewableFields, 'options'],
      editableFields: [...permissionFixture.editableFields, 'options'],
    };
    const east = { value: 'east', label: '合成东区', enabled: true };
    Object.assign(currentRow, { valueType: 'select', options: [east] });
    conflictRow = { ...currentRow, revision: 2, options: [{ ...east, label: '合成他人改名' }] };
    mode = 'conflict';
    await render();
    await click('编辑选项');
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
    const label = () => dialog().querySelector<HTMLInputElement>('[aria-label="选项名称 1"]')!;
    type(label(), '合成新区');
    await settle();
    await click('保存', dialog());
    expect(posts[0]!.body).toEqual({ options: [{ ...east, label: '合成新区' }] });
    await click('重读最新版本', dialog());
    await click('已核对差异，继续编辑', dialog());
    type(label(), '合成东区');
    await settle();
    await click('保存', dialog());
    expect(posts).toHaveLength(2);
    expect(posts[1]!.url).toContain(`/${row.id}/options`);
    expect(posts[1]!.body).toEqual({ options: [east] });
    expect(posts[1]!.headers.get('if-match')).toBe('2');
  });

  it('AC-F474-0BFE04 他人新增选项后本人改名 409，重读合并他人新增项并以新 revision 保存成功', async () => {
    permission = {
      ...permissionFixture,
      viewableFields: [...permissionFixture.viewableFields, 'options'],
      editableFields: [...permissionFixture.editableFields, 'options'],
    };
    const east = { value: 'east', label: '合成东区', enabled: true };
    const west = { value: 'west', label: '合成西区', enabled: true };
    Object.assign(currentRow, { valueType: 'select', options: [east] });
    conflictRow = { ...currentRow, revision: 2, options: [east, west] };
    mode = 'conflict';
    await render();
    await click('编辑选项');
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
    const label = (index: number) =>
      dialog().querySelector<HTMLInputElement>(`[aria-label="选项名称 ${index}"]`) ?? undefined;
    type(label(1)!, '合成新区');
    await settle();
    await click('保存', dialog());
    expect(posts[0]!.body).toEqual({ options: [{ ...east, label: '合成新区' }] });
    await click('重读最新版本', dialog());
    await click('已核对差异，继续编辑', dialog());
    expect(label(1)!.value).toBe('合成新区');
    expect(label(2)?.value, '他人新增的选项进入编辑器').toBe('合成西区');
    expect(buttons(dialog()), '他人新增项已保存，不可移除').not.toContain('移除');
    await click('保存', dialog());
    expect(posts).toHaveLength(2);
    expect(posts[1]!.url).toContain(`/${row.id}/options`);
    expect(posts[1]!.body).toEqual({ options: [{ ...east, label: '合成新区' }, west] });
    expect(posts[1]!.headers.get('if-match')).toBe('2');
    expect(document.querySelector('[role="dialog"]'), '保存成功后关闭').toBeNull();
  });

  it('AC-F474-0BFE05 他人改名并新增选项后本人只新增 409，重读保留他人改名与新增项', async () => {
    permission = {
      ...permissionFixture,
      viewableFields: [...permissionFixture.viewableFields, 'options'],
      editableFields: [...permissionFixture.editableFields, 'options'],
    };
    const east = { value: 'east', label: '合成东区', enabled: true };
    const renamed = { ...east, label: '合成他人改名' };
    const west = { value: 'west', label: '合成西区', enabled: false };
    Object.assign(currentRow, { valueType: 'select', options: [east] });
    conflictRow = { ...currentRow, revision: 2, options: [renamed, west] };
    mode = 'conflict';
    await render();
    await click('编辑选项');
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
    await click('新增选项', dialog());
    type(dialog().querySelector<HTMLInputElement>('[aria-label="选项名称 2"]')!, '合成本人新增');
    await settle();
    await click('保存', dialog());
    expect(posts[0]!.body).toEqual({
      options: [east, { value: expect.any(String), label: '合成本人新增', enabled: true }],
    });
    const mine = (posts[0]!.body as { options: { value: string }[] }).options[1]!.value;
    await click('重读最新版本', dialog());
    await click('已核对差异，继续编辑', dialog());
    await click('保存', dialog());
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toEqual({
      options: [renamed, west, { value: mine, label: '合成本人新增', enabled: true }],
    });
    expect(posts[1]!.headers.get('if-match')).toBe('2');
    expect(document.querySelector('[role="dialog"]'), '保存成功后关闭').toBeNull();
  });

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
    expect(buttons()).toContain('新建');
    expect([...document.querySelectorAll('th')].map((node) => node.textContent)).toEqual([
      '名称',
      '类型',
      '对象',
      '操作',
    ]);
    await chooseObject('人员');
    expect(buttons()).toContain('新建');
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
