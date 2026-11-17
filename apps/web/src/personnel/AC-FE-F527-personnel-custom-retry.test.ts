// @vitest-environment happy-dom
/**
 * F-527（DEC-918）：「编辑人员」抽屉的人员自定义字段定义目录读取失败时，“员工信息”分组里显示一行
 * “自定义字段加载失败，重试”，点重试重新拉取；失败期间预置字段照常可改可提交，提交不带也不清空 custom:<id>。
 * 网络夹具的形态同 AC-FE-F4746c-r2（照后端）：详情 customFields 是 { <定义 ID>: 值 }，
 * 定义目录是 { items: [{ id, name, valueType, options, editable }] }。
 */
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PermissionsModule from '../foundation/Permissions.js';
import { PERSONNEL_OBJECT } from '@italent/domain';
import { fieldAccess, type ObjectPermission } from '../foundation/permission-model.js';
import { SessionProvider } from '../foundation/Session.js';
import { uniqueSuffix } from '../../../../tests/acceptance/support/unique.js';
import { EditPersonButton } from './EditCommands.js';

// ensure / refresh 必须引用稳定：依赖它们的 effect 每次渲染换新函数会无限重取。
const permissions = vi.hoisted(() => ({
  current: undefined as ObjectPermission | undefined,
  ensure: async () => undefined,
  refresh: () => {},
}));
vi.mock('../foundation/Permissions.js', async (original) => ({
  ...(await original<typeof PermissionsModule>()),
  usePermissions: () => ({
    snapshot: { objects: permissions.current ? { [PERSONNEL_OBJECT]: permissions.current } : {} },
    menus: [],
    loading: false,
    refresh: permissions.refresh,
    ensure: permissions.ensure,
    can: () => false,
    field: (name: string) => fieldAccess(permissions.current, name),
  }),
}));
vi.mock('../foundation/DecisionNote.js', () => ({ DecisionNote: () => null }));

const DEFINITIONS = '/api/tenant/personnel/custom-field-definitions';
const NOTICE = '自定义字段加载失败，重试';
const LOADING = '自定义字段加载中';
const employeeId = '10000000-0000-4000-8000-0000000000f1';
const fieldId = '30000000-0000-4000-8000-0000000000d1';
const customKey = `custom:${fieldId}`;
const detailPath = `/api/tenant/personnel/employees/${employeeId}`;
const success = () =>
  Response.json({ items: [{ id: fieldId, name: '合成文本', valueType: 'text', options: [], editable: true }] });
const failures: Record<string, () => Promise<Response>> = {
  403: async () => Response.json({ error: { code: 'FORBIDDEN', message: '无权限' } }, { status: 403 }),
  500: async () => Response.json({ error: { code: 'INTERNAL', message: '服务异常' } }, { status: 500 }),
  network: () => Promise.reject(new TypeError('Failed to fetch')),
};

let host: HTMLDivElement;
let root: Root;
let detail: Record<string, unknown>;
let requests: { method: string; path: string; body?: Record<string, unknown> }[];
/** 每次请求定义目录依次取一个回应；取完后沿用最后一个。 */
let replies: (() => Response | Promise<Response>)[];

const settle = async () => {
  for (let i = 0; i < 8; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
};
const text = () => host.ownerDocument.body.textContent?.replace(/\s/g, '') ?? '';
const definitionReads = () => requests.filter((request) => request.path === DEFINITIONS).length;
const writes = () => requests.filter((request) => request.method === 'PATCH');
const customInput = () => host.ownerDocument.querySelector<HTMLInputElement>('input[aria-label="合成文本"]');
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
async function openEditor() {
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
        children: h(EditPersonButton, { employeeId, saved() {} }),
      }),
    ),
  );
  await settle();
  await click('编辑人员');
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  permissions.current = {
    objectCode: PERSONNEL_OBJECT,
    dataOperations: { update: true },
    viewableFields: ['name', customKey],
    editableFields: ['name', customKey],
    buttons: [{ buttonCode: 'update', level: 'detail' }],
  };
  detail = { id: employeeId, revision: 3, name: '合成员工', customFields: { [fieldId]: '合成旧值' } };
  replies = [success];
  requests = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    requests.push({ method, path, body });
    if (path === DEFINITIONS) return (replies.length > 1 ? replies.shift()! : replies[0]!)();
    if (path === detailPath && method === 'GET') return Response.json(detail);
    if (path === detailPath && method === 'PATCH') {
      detail = { ...detail, ...body, revision: Number(detail.revision) + 1 };
      return Response.json(detail);
    }
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

describe('AC-FE-F527 编辑人员：自定义字段定义加载失败改非阻塞提示 + 重试', () => {
  it.each(Object.keys(failures))(
    'AC-FE-F527-PN-01 定义接口失败（%s）：员工信息分组显示提示与重试，不出现字段控件，表单不锁',
    async (kind) => {
      replies = [failures[kind]!];
      await openEditor();
      expect(text(), '员工信息分组里显示一行失败提示').toContain(NOTICE);
      expect(button('重试'), '“重试”是可点的按钮').toBeDefined();
      expect(customInput()).toBeNull();
      expect(host.ownerDocument.querySelector('input#name')).not.toBeNull();
      expect(button('保存')?.disabled, '失败不锁表单').toBe(false);
    },
  );

  it('AC-FE-F527-PN-02 点重试：期间显示加载态，成功后字段出现并取原值、提示消失', async () => {
    let resolve!: (response: Response) => void;
    replies = [failures[500]!, () => new Promise<Response>((done) => (resolve = done)), success];
    await openEditor();
    expect(definitionReads()).toBe(1);
    await click('重试');
    expect(definitionReads(), '点重试重新拉取定义接口').toBe(2);
    expect(text(), '重试期间显示加载态').toContain(LOADING);
    expect(text()).not.toContain(NOTICE);
    expect(button('保存')?.disabled, '重试期间预置字段照常可提交').toBe(false);
    await act(async () => resolve(success()));
    await settle();
    expect(customInput()?.value, '重试成功后字段按 custom:<id> 查看权出现，取原值').toBe('合成旧值');
    expect(text()).not.toContain(NOTICE);
    expect(text()).not.toContain(LOADING);
  });

  it('AC-FE-F527-PN-03 重试再失败：仍显示提示与重试', async () => {
    replies = [failures.network!, failures[403]!, success];
    await openEditor();
    await click('重试');
    expect(definitionReads()).toBe(2);
    expect(text()).toContain(NOTICE);
    expect(customInput()).toBeNull();
    await click('重试');
    expect(definitionReads()).toBe(3);
    expect(customInput()?.value).toBe('合成旧值');
  });

  it('AC-FE-F527-PN-04 失败期间改预置字段可提交：载荷不含 customFields，已有自定义值不被清空', async () => {
    replies = [failures[403]!];
    await openEditor();
    expect(text()).toContain(NOTICE);
    await type('input#name', '合成新名');
    await click('保存');
    expect(writes()).toHaveLength(1);
    expect(writes()[0]!.body).toEqual({ name: '合成新名' });
    expect(detail.customFields).toEqual({ [fieldId]: '合成旧值' });
  });

  it('AC-FE-F527-PN-05 成功路径不变：定义目录只读一次，字段出现，不显示提示', async () => {
    await openEditor();
    expect(definitionReads()).toBe(1);
    expect(customInput()?.value).toBe('合成旧值');
    expect(text()).not.toContain(NOTICE);
    expect(text()).not.toContain(LOADING);
    expect(button('重试')).toBeUndefined();
    await type('input[aria-label="合成文本"]', '合成新值');
    await click('保存');
    expect(writes()[0]!.body).toEqual({ customFields: { [fieldId]: '合成新值' } });
  });
});
