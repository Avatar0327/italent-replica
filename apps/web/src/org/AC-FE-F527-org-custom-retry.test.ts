// @vitest-environment happy-dom
/**
 * F-527（DEC-918）：组织新建 / 变更弹窗的组织自定义字段定义目录读取失败时，“其他信息”分组显示一行
 * “自定义字段加载失败，重试”，点重试重新拉取；失败期间其余字段照常可填可提交，提交不带也不清空 custom:<id>。
 * 没有自定义字段区的弹窗（更正设立日期）不新增提示。定义目录形状照后端：{ items: [{ id, name, valueType, options }] }；
 * 组织详情 customFields 是 { <定义 ID>: 值 }（同 AC-FE-F4746b）。
 */
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../foundation/Session.js';
import { FormCommands } from '../foundation/forms/useCommandForm.js';
import type { ObjectPermission } from '../foundation/permission-model.js';
import { uniqueSuffix } from '../../../../tests/acceptance/support/unique.js';
import { orgObject, pageAccess, type OrgAction, type OrgRow } from './page-model.js';
import { useOrgCustomFields } from './custom-fields.js';
import { OrgCreate } from './OrgCreate.js';
import { OrgEditor } from './OrgEditor.js';

const DEFINITIONS = '/api/tenant/org/custom-field-definitions';
const NOTICE = '自定义字段加载失败，重试';
const LOADING = '自定义字段加载中';
const GROUP = '其他信息';
const date = '2026-10-13';
const orgId = '20000000-0000-4000-8000-0000000000a1';
const parentId = '20000000-0000-4000-8000-0000000000a0';
const fieldId = '40000000-0000-4000-8000-0000000000b1';
const customKey = `custom:${fieldId}`;
const orgPath = `/api/tenant/org/organizations/${orgId}`;
const success = () => Response.json({ items: [{ id: fieldId, name: '合成组织说明', valueType: 'text', options: [] }] });
const failures: Record<string, () => Promise<Response>> = {
  403: async () => Response.json({ error: { code: 'FORBIDDEN', message: '无权限' } }, { status: 403 }),
  500: async () => Response.json({ error: { code: 'INTERNAL', message: '服务异常' } }, { status: 500 }),
  network: () => Promise.reject(new TypeError('Failed to fetch')),
};
const fields = ['name', 'shortName', 'code', 'parents', 'establishedOn', 'isVirtual', 'broadType', 'remarks'];
const permission: ObjectPermission = {
  objectCode: orgObject,
  dataOperations: { read: true, create: true, update: true },
  viewableFields: [...fields, customKey],
  editableFields: [...fields.filter((key) => key !== 'code'), customKey],
  buttons: [],
};
const original: OrgRow = {
  id: orgId,
  revision: 2,
  code: 'ORG-SYN-001',
  name: '合成组织',
  shortName: '合成',
  establishedOn: '2025-01-01',
  isVirtual: false,
  broadType: '合成类型',
  customFields: { [fieldId]: '合成旧说明' },
};

let host: HTMLDivElement;
let root: Root;
let requests: { method: string; path: string; body?: Record<string, unknown> }[];
/** 每次请求定义目录依次取一个回应；取完后沿用最后一个。 */
let replies: (() => Response | Promise<Response>)[];

const settle = async () => {
  for (let i = 0; i < 8; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
};
const text = () => host.ownerDocument.body.textContent?.replace(/\s/g, '') ?? '';
const definitionReads = () => requests.filter((request) => request.path === DEFINITIONS).length;
const writes = () => requests.filter((request) => ['PATCH', 'POST'].includes(request.method));
const customInput = () => host.ownerDocument.querySelector<HTMLInputElement>('input[aria-label="合成组织说明"]');
const button = (label: string) =>
  [...host.ownerDocument.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent?.replace(/\s/g, '') === label,
  );
async function click(label: string) {
  const target = button(label);
  expect(target, `应存在按钮：${label}`).toBeDefined();
  await act(async () => target!.click());
  await settle();
}
async function type(selector: string, value: string) {
  const input = host.ownerDocument.querySelector<HTMLInputElement>(selector);
  expect(input, `应存在输入框：${selector}`).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}
/** 照 OrgPage：定义目录由页面读一次，交给新建 / 变更弹窗。 */
function Page({ open }: { open: OrgAction | 'create' }) {
  const access = pageAccess(permission);
  const custom = useOrgCustomFields(access);
  const common = { date, access, custom, onClose() {}, onSaved() {} };
  return open === 'create'
    ? h(OrgCreate, { ...common, parentId })
    : h(OrgEditor, { ...common, original, action: open });
}
async function render(open: OrgAction | 'create') {
  const session = {
    tenantId: 'synthetic-tenant',
    identityKey: uniqueSuffix(),
    tenantName: '合成租户',
    timezone: 'Asia/Shanghai',
    displayName: '合成人事',
    source: 'server' as const,
  };
  const page = h(FormCommands, { children: h(Page, { open }) });
  await act(async () => root.render(h(SessionProvider, { session, children: page })));
  await settle();
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  replies = [success];
  requests = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    requests.push({ method, path: `${url.pathname}${url.search}`, body });
    if (url.pathname === DEFINITIONS) return (replies.length > 1 ? replies.shift()! : replies[0]!)();
    if (url.pathname === orgPath && method === 'PATCH') return Response.json({ ...original, revision: 3 });
    if (url.pathname === orgPath) return Response.json(original);
    if (url.pathname === '/api/tenant/org/organizations' && method === 'POST')
      return Response.json({ id: '20000000-0000-4000-8000-0000000000a2', revision: 1 }, { status: 201 });
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

describe('AC-FE-F527 组织新建 / 变更：自定义字段定义加载失败改非阻塞提示 + 重试', () => {
  it.each(Object.keys(failures))(
    'AC-FE-F527-OG-01 定义接口失败（%s）：新建与变更的“其他信息”分组显示提示与重试，不出现字段控件，表单不锁',
    async (kind) => {
      replies = [failures[kind]!];
      for (const open of ['change', 'create'] as const) {
        await render(open);
        expect(text(), '“其他信息”分组仍在').toContain(GROUP);
        expect(text(), '自定义字段区显示一行失败提示').toContain(NOTICE);
        expect(button('重试'), '“重试”是可点的按钮').toBeDefined();
        expect(customInput()).toBeNull();
        expect(button('保存')?.disabled, '失败不锁表单').toBe(false);
      }
    },
  );

  it('AC-FE-F527-OG-02 点重试：期间显示加载态，成功后字段出现并取原值、提示消失', async () => {
    let resolve!: (response: Response) => void;
    replies = [failures[500]!, () => new Promise<Response>((done) => (resolve = done)), success];
    await render('change');
    expect(definitionReads()).toBe(1);
    await click('重试');
    expect(definitionReads(), '点重试重新拉取定义接口').toBe(2);
    expect(text(), '重试期间显示加载态').toContain(LOADING);
    expect(text()).not.toContain(NOTICE);
    expect(button('保存')?.disabled, '重试期间其余字段照常可提交').toBe(false);
    await act(async () => resolve(success()));
    await settle();
    expect(customInput()?.value, '重试成功后字段按 custom:<id> 查看权出现，取原值').toBe('合成旧说明');
    expect(text()).not.toContain(NOTICE);
    expect(text()).not.toContain(LOADING);
  });

  it('AC-FE-F527-OG-03 重试再失败：仍显示提示与重试', async () => {
    replies = [failures[403]!, failures.network!, success];
    await render('create');
    await click('重试');
    expect(definitionReads()).toBe(2);
    expect(text()).toContain(NOTICE);
    expect(customInput()).toBeNull();
    await click('重试');
    expect(definitionReads()).toBe(3);
    expect(customInput()).not.toBeNull();
  });

  it('AC-FE-F527-OG-04 失败期间变更可提交：载荷不含 customFields，已有自定义值不被清空', async () => {
    replies = [failures[403]!];
    await render('change');
    expect(text()).toContain(NOTICE);
    await type('input#shortName', '合成新简称');
    await click('保存');
    expect(writes()).toHaveLength(1);
    expect(writes()[0]!.path).toBe(orgPath);
    expect(writes()[0]!.body).toEqual({ effectiveDate: date, shortName: '合成新简称' });
  });

  it('AC-FE-F527-OG-05 失败期间新建可提交：载荷不含 customFields', async () => {
    replies = [failures[500]!];
    await render('create');
    expect(text()).toContain(NOTICE);
    await type('input#name', '合成新组织');
    await type('input#shortName', '合成新');
    await click('保存');
    expect(writes()).toHaveLength(1);
    expect(writes()[0]!.body).toMatchObject({ name: '合成新组织', shortName: '合成新' });
    expect(writes()[0]!.body).not.toHaveProperty('customFields');
  });

  it('AC-FE-F527-OG-06 没有自定义字段区的弹窗（更正设立日期）：失败时不新增提示', async () => {
    replies = [failures[500]!];
    await render('edit');
    expect(definitionReads()).toBe(1);
    expect(text()).not.toContain(NOTICE);
    expect(text()).not.toContain(GROUP);
  });

  it('AC-FE-F527-OG-07 成功路径不变：定义目录只读一次，字段出现，不显示提示', async () => {
    await render('change');
    expect(definitionReads()).toBe(1);
    expect(customInput()?.value).toBe('合成旧说明');
    expect(text()).not.toContain(NOTICE);
    expect(text()).not.toContain(LOADING);
    expect(button('重试')).toBeUndefined();
    await type('input[aria-label="合成组织说明"]', '合成新说明');
    await click('保存');
    expect(writes()[0]!.body).toEqual({ effectiveDate: date, customFields: { [fieldId]: '合成新说明' } });
  });
});
