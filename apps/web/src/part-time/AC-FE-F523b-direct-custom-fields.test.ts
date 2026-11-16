// @vitest-environment happy-dom
/**
 * F-523b：兼职直接填写（新增弹窗 / 编辑抽屉）的任职自定义字段定义改读业务侧只读目录
 * GET /api/tenant/employment/custom-field-definitions（F-523a，准入为任职对象查看权），不再读需要
 * TenantBase.EmploymentCustomField 配置权的配置接口。普通 HR 读配置接口得 403，旧实现因此把整块控件丢掉并锁住表单。
 * 夹具形状照后端 tests/acceptance/AC-EMP-F523-definitions.test.ts：{ items: [{ id, name, valueType, options, editable }] }，
 * 不分页、按 id 升序；记录详情 customFields 是 { <定义 ID>: 值 }（part-time-fixtures.record）。
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

// smoke/fixtures.ts 依赖 Playwright 与文件系统（page-registry），这里只取兼职夹具用到的合成 ID。
vi.mock('../../smoke/fixtures.js', () => ({
  employee: '30000000-0000-4000-8000-000000000001',
  user: '20000000-0000-4000-8000-000000000001',
  snapshotFixture: {},
}));

const DEFINITIONS = '/api/tenant/employment/custom-field-definitions';
const CONFIG = '/api/tenant/employment/custom-fields';
// 按 id 升序，与后端排序一致。
const editId = '70000000-0000-4000-8000-0000000000b1';
const viewId = '70000000-0000-4000-8000-0000000000b2';
const hiddenId = '70000000-0000-4000-8000-0000000000b3';
const options = [
  { value: 'east', label: '合成东区', enabled: true },
  { value: 'west', label: '合成西区', enabled: false },
];
const snapshot = {
  session: { tenantId: 'synthetic-tenant', timezone: 'Asia/Shanghai', today: '2026-10-13' },
  apps: [],
  scope: [],
  adminMenus: [],
};
const recordPath = `/api/tenant/employment/part-times/${recordId}`;

let host: HTMLDivElement;
let root: Root;
let requests: { method: string; path: string; body?: Record<string, unknown> }[];
let view: string[];
let edit: string[];
let definitions: () => Response;

const custom = (id: string) => `custom:${id}`;
const definitionItems = () => ({
  items: [
    { id: editId, name: '合成兼职说明', valueType: 'text', options: [], editable: true },
    { id: viewId, name: '合成兼职区域', valueType: 'select', options, editable: false },
    // 服务端本应裁掉；这里故意多给一条，核对前端仍按快照 custom:<id> 查看权再裁一遍（与 6b / 6c 先例一致）。
    { id: hiddenId, name: '合成不该出现', valueType: 'text', options: [], editable: true },
  ],
});
const settle = async () => {
  for (let i = 0; i < 12; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
};
const doc = () => host.ownerDocument;
const paths = () => requests.map((request) => request.path.split('?')[0]!);
const input = (label: string) => doc().querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
const saveButton = () =>
  [...doc().querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent?.replace(/\s/g, '') === '保存',
  );
/** Form.Item 的标签与只读文字：只读字段渲染成 label + span，没有输入控件。 */
const itemText = (label: string) =>
  [...doc().querySelectorAll('.ant-form-item')]
    .find((node) => node.querySelector('label')?.textContent === label)
    ?.querySelector('.ant-form-item-control')?.textContent;

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

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  // 无配置权、有任职对象查看 / 修改权的普通 HR：custom:edit 可改，custom:view 只读，custom:hidden 无查看权。
  view = [...fields, custom(editId), custom(viewId)];
  edit = [...fields.filter((key) => key !== 'serviceType'), 'partTimeType', custom(editId)];
  definitions = () => Response.json(definitionItems());
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
        viewableFields: view,
        editableFields: edit,
        buttons: [],
      });
    if (url.pathname === DEFINITIONS) return definitions();
    // 配置接口保持配置准入：同一普通 HR 得 403（F-523a 契约）。
    if (url.pathname.startsWith(CONFIG))
      return Response.json({ error: { code: 'FORBIDDEN', message: '无权限' } }, { status: 403 });
    if (url.pathname === recordPath && method === 'GET')
      return Response.json({ ...record, customFields: { [editId]: '合成旧说明', [viewId]: 'west' } });
    if (url.pathname === recordPath && method === 'PATCH')
      return Response.json({ ...record, revision: 2, customFields: { [editId]: '合成新说明', [viewId]: 'west' } });
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

describe('AC-FE-F523b 兼职直接填写的自定义字段读业务侧只读定义', () => {
  it('AC-FE-F523b-01 编辑：无配置权 HR 读业务侧目录，看到可见字段控件，不再请求配置接口', async () => {
    await openEdit();
    expect(paths()).toContain(DEFINITIONS);
    expect(requests.find((request) => request.path.startsWith(DEFINITIONS))!.path, '契约不带查询参数').toBe(
      DEFINITIONS,
    );
    expect(
      paths().filter((path) => path.startsWith(CONFIG)),
      '本页不得请求配置接口',
    ).toEqual([]);
    expect(input('合成兼职说明')?.value).toBe('合成旧说明');
    expect(saveButton()?.disabled, '表单不被锁住').toBe(false);
  });

  it('AC-FE-F523b-02 无字段查看权的字段不出现（服务端多给也按快照再裁）', async () => {
    await openEdit();
    expect(doc().body.textContent).toContain('合成兼职说明');
    expect(doc().body.textContent).not.toContain('合成不该出现');
    expect(input('合成不该出现')).toBeNull();
  });

  it('AC-FE-F523b-03 只读字段（editable=false、快照无编辑权）显示为只读文字，停用选项显示名称', async () => {
    await openEdit();
    expect(itemText('合成兼职区域')).toBe('合成西区');
    expect(input('合成兼职区域'), '只读字段没有输入控件').toBeNull();
  });

  it('AC-FE-F523b-04 编辑保存：只提交可编辑的自定义字段，只读字段不进请求体', async () => {
    await openEdit();
    await type('合成兼职说明', '合成新说明');
    await act(async () => saveButton()!.click());
    await settle();
    const writes = requests.filter((request) => request.method === 'PATCH');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe(recordPath);
    expect(writes[0]!.body).toEqual({ customFields: { [editId]: '合成新说明' } });
  });

  it('AC-FE-F523b-05 新增：弹窗里同样出现可见字段控件，只读字段只读，不请求配置接口', async () => {
    await openCreate();
    expect(paths()).toContain(DEFINITIONS);
    expect(paths().filter((path) => path.startsWith(CONFIG))).toEqual([]);
    expect(input('合成兼职说明')).not.toBeNull();
    expect(itemText('合成兼职区域')).toBe('--');
    expect(input('合成兼职区域')).toBeNull();
    expect(doc().body.textContent).not.toContain('合成不该出现');
  });

  it('AC-FE-F523b-06 定义目录失败（403）：照 6b / 6c 先例按无字段处理，不显示错误、不锁表单', async () => {
    definitions = () => Response.json({ error: { code: 'FORBIDDEN', message: '无权限' } }, { status: 403 });
    await openEdit();
    expect(paths()).toContain(DEFINITIONS);
    expect(input('合成兼职说明')).toBeNull();
    expect(doc().body.textContent).not.toContain('合成兼职区域');
    expect(doc().querySelector('.ant-alert-error, .ant-result-error'), '不因定义目录失败挡住表单').toBeNull();
    expect(saveButton()?.disabled).toBe(false);
  });

  it('AC-FE-F523b-07 无任何 custom:<id> 查看权：两个定义接口都不请求，表单照常可用', async () => {
    view = [...fields];
    edit = fields.filter((key) => key !== 'serviceType');
    await openEdit();
    expect(paths().filter((path) => path.includes('custom-field'))).toEqual([]);
    expect(doc().body.textContent).not.toContain('合成兼职说明');
    expect(saveButton()?.disabled).toBe(false);
  });
});
