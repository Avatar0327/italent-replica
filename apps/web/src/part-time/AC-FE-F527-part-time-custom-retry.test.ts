// @vitest-environment happy-dom
/**
 * F-527（DEC-918）：兼职直接填写（新增弹窗 / 编辑抽屉）的任职自定义字段定义目录读取失败时，自定义字段区显示一行
 * “自定义字段加载失败，重试”，点重试重新拉取；失败期间表单其余部分照常可填可提交，提交不带也不清空 custom:<id>。
 * 夹具形状照后端 tests/acceptance/AC-EMP-F523-definitions.test.ts：{ items: [{ id, name, valueType, options, editable }] }；
 * 记录详情 customFields 是 { <定义 ID>: 值 }（part-time-fixtures.record），同 AC-FE-F523b。
 */
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../foundation/Session.js';
import { PermissionsProvider } from '../foundation/Permissions.js';
import { uniqueSuffix } from '../../../../tests/acceptance/support/unique.js';
import { fields, record, recordId } from '../../smoke/part-time-fixtures.js';
import { DirectCommands } from './direct-commands.js';
import { DirectEdit, DirectForm } from './DirectForm.js';

vi.mock('../../smoke/fixtures.js', () => ({
  employee: '30000000-0000-4000-8000-000000000001',
  user: '20000000-0000-4000-8000-000000000001',
  snapshotFixture: {},
}));

const DEFINITIONS = '/api/tenant/employment/custom-field-definitions';
const editId = '70000000-0000-4000-8000-0000000000c1';
const snapshot = {
  session: { tenantId: 'synthetic-tenant', timezone: 'Asia/Shanghai', today: '2026-10-13' },
  apps: [],
  scope: [],
  adminMenus: [],
};
const recordPath = `/api/tenant/employment/part-times/${recordId}`;
const NOTICE = '自定义字段加载失败，重试';
const LOADING = '自定义字段加载中';
const custom = `custom:${editId}`;
const success = () =>
  Response.json({ items: [{ id: editId, name: '合成兼职说明', valueType: 'text', editable: true }] });
const failures: Record<string, () => Promise<Response>> = {
  403: async () => Response.json({ error: { code: 'FORBIDDEN', message: '无权限' } }, { status: 403 }),
  500: async () => Response.json({ error: { code: 'INTERNAL', message: '服务异常' } }, { status: 500 }),
  network: () => Promise.reject(new TypeError('Failed to fetch')),
};

let host: HTMLDivElement;
let root: Root;
let requests: { method: string; path: string; body?: Record<string, unknown> }[];
/** 每次请求定义目录依次取一个回应；取完后沿用最后一个。 */
let replies: (() => Response | Promise<Response>)[];

const settle = async () => {
  for (let i = 0; i < 12; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
};
const doc = () => host.ownerDocument;
const text = () => doc().body.textContent?.replace(/\s/g, '') ?? '';
const definitionReads = () => requests.filter((request) => request.path === DEFINITIONS).length;
const input = (label: string) => doc().querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
const button = (label: string) =>
  [...doc().querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent?.replace(/\s/g, '') === label,
  );
const writes = () => requests.filter((request) => ['PATCH', 'POST'].includes(request.method));

async function render(child: ReturnType<typeof h>) {
  await act(async () =>
    root.render(
      h(SessionProvider, {
        session: {
          tenantId: 'synthetic-tenant',
          identityKey: uniqueSuffix(),
          tenantName: '合成租户',
          timezone: 'Asia/Shanghai',
          displayName: '合成人事',
          source: 'server',
        },
        children: h(PermissionsProvider, { children: h(MemoryRouter, null, h(DirectCommands, null, child)) }),
      }),
    ),
  );
  await settle();
}
const props = { onClose() {}, refresh: async () => {} };
const openEdit = () => render(h(DirectEdit, { id: recordId, ...props }));
const openCreate = () => render(h(DirectForm, props));
async function type(label: string, value: string) {
  const target = input(label);
  expect(target, `应存在输入框：${label}`).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(target, value);
    target!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}
async function click(label: string) {
  const target = button(label);
  expect(target, `应存在按钮：${label}`).toBeDefined();
  await act(async () => target!.click());
  await settle();
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  replies = [success];
  requests = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (resource, init) => {
    const url = new URL(String(resource), window.location.origin);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    requests.push({ method, path: `${url.pathname}${url.search}`, body });
    if (url.pathname.endsWith('/permission/me/snapshot')) return Response.json(snapshot);
    if (url.pathname.includes('/permission/me/objects/'))
      return Response.json({
        objectCode: decodeURIComponent(url.pathname.split('/').at(-1)!),
        dataOperations: { read: true, create: true, update: true },
        viewableFields: [...fields, 'employmentForm', custom],
        editableFields: [...fields.filter((key) => key !== 'serviceType'), 'partTimeType', 'employmentForm', custom],
        buttons: [],
      });
    if (url.pathname === DEFINITIONS) return (replies.length > 1 ? replies.shift()! : replies[0]!)();
    if (url.pathname === recordPath && method === 'GET')
      return Response.json({ ...record, customFields: { [editId]: '合成旧说明' } });
    if (url.pathname === recordPath && method === 'PATCH')
      return Response.json({ ...record, revision: 2, customFields: { [editId]: '合成旧说明' } });
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

describe('AC-FE-F527 兼职直接填写：自定义字段定义加载失败改非阻塞提示 + 重试', () => {
  it.each(Object.keys(failures))(
    'AC-FE-F527-PT-01 定义接口失败（%s）：编辑与新增的自定义字段区显示提示与重试，不出现字段控件，表单不锁',
    async (kind) => {
      replies = [failures[kind]!];
      for (const open of [openEdit, openCreate]) {
        await open();
        expect(text(), '自定义字段区显示一行失败提示').toContain(NOTICE);
        expect(button('重试'), '“重试”是可点的按钮').toBeDefined();
        expect(input('合成兼职说明')).toBeNull();
        expect(button('保存')?.disabled, '失败不锁表单').toBe(false);
      }
    },
  );

  it('AC-FE-F527-PT-02 点重试：期间显示加载态且不锁表单，成功后字段出现、提示消失', async () => {
    let resolve!: (response: Response) => void;
    replies = [failures[500]!, () => new Promise<Response>((done) => (resolve = done)), success];
    await openEdit();
    expect(definitionReads()).toBe(1);
    await click('重试');
    expect(definitionReads(), '点重试重新拉取定义接口').toBe(2);
    expect(text(), '重试期间显示加载态').toContain(LOADING);
    expect(text()).not.toContain(NOTICE);
    expect(button('保存')?.disabled, '重试期间表单其余部分照常可提交').toBe(false);
    await act(async () => resolve(success()));
    await settle();
    expect(input('合成兼职说明')?.value, '重试成功后字段按快照查看权出现，取原单值').toBe('合成旧说明');
    expect(text()).not.toContain(NOTICE);
    expect(text()).not.toContain(LOADING);
  });

  it('AC-FE-F527-PT-03 重试再失败：仍显示提示与重试', async () => {
    replies = [failures[500]!, failures.network!, success];
    await openCreate();
    await click('重试');
    expect(definitionReads()).toBe(2);
    expect(text()).toContain(NOTICE);
    expect(input('合成兼职说明')).toBeNull();
    await click('重试');
    expect(definitionReads()).toBe(3);
    expect(input('合成兼职说明')).not.toBeNull();
  });

  it('AC-FE-F527-PT-04 失败期间编辑可提交：载荷不含 customFields，已有自定义值不被清空', async () => {
    replies = [failures[403]!];
    await openEdit();
    expect(text()).toContain(NOTICE);
    await type('用工形式', '合成用工形式');
    await click('保存');
    expect(writes()).toHaveLength(1);
    expect(writes()[0]!.path).toBe(recordPath);
    expect(writes()[0]!.body).toEqual({ fields: { employmentForm: '合成用工形式' } });
  });

  it('AC-FE-F527-PT-05 成功路径不变：定义目录只读一次，字段出现，不显示提示', async () => {
    await openEdit();
    expect(definitionReads()).toBe(1);
    expect(input('合成兼职说明')?.value).toBe('合成旧说明');
    expect(text()).not.toContain(NOTICE);
    expect(text()).not.toContain(LOADING);
    expect(button('重试')).toBeUndefined();
    await type('合成兼职说明', '合成新说明');
    await click('保存');
    expect(writes()[0]!.body).toEqual({ customFields: { [editId]: '合成新说明' } });
  });
});
