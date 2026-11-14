// @vitest-environment happy-dom
// F-474-6c 第 2 轮返工（Codex 审查 942a21d4c 的 P2-1、P2-2、P2-3）：渲染真实的「编辑人员」抽屉与档案基本信息，
// 网络夹具的形态照后端：详情 customFields 是 { <定义 ID>: 值 }，定义目录是 { items: [{ id, name, valueType, options, editable }] }。
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PermissionsModule from '../foundation/Permissions.js';
import { PERSONNEL_OBJECT } from '@italent/domain';
import { fieldAccess, type ObjectPermission } from '../foundation/permission-model.js';
import { SessionProvider } from '../foundation/Session.js';
import { uniqueSuffix } from '../../../../tests/acceptance/support/unique.js';
import { EditPersonButton } from './EditCommands.js';
import { PersonnelProfile } from './ProfileSections.js';

// ensure / refresh 必须引用稳定：档案分区的 effect 依赖它们，每次渲染换新函数会无限重取。
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

const employeeId = '10000000-0000-4000-8000-0000000000e1';
const fieldId = '30000000-0000-4000-8000-0000000000c1';
const otherId = '30000000-0000-4000-8000-0000000000c2';
const customKey = (id: string) => `custom:${id}`;
const detailPath = `/api/tenant/personnel/employees/${employeeId}`;
let host: HTMLDivElement;
let root: Root;
let detail: Record<string, unknown>;
let requests: { method: string; path: string; headers: Headers; body?: Record<string, unknown> }[];
let conflicts: number;
let afterConflict: Record<string, unknown> | undefined;

const permission = (view: string[], edit: string[]): ObjectPermission => ({
  objectCode: PERSONNEL_OBJECT,
  dataOperations: { update: true },
  viewableFields: view,
  editableFields: edit,
  buttons: [{ buttonCode: 'update', level: 'detail' }],
});
const definitions = {
  items: [
    { id: fieldId, name: '合成文本', valueType: 'text', options: [], editable: true },
    { id: otherId, name: '合成备注', valueType: 'text', options: [], editable: true },
  ],
};
const settle = async () => {
  for (let i = 0; i < 8; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
};
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
        children: child,
      }),
    ),
  );
  await settle();
}
async function click(text: string) {
  const target = [...host.ownerDocument.querySelectorAll('button')].find(
    (node) => node.textContent?.replace(/\s/g, '') === text,
  );
  expect(target, `应存在按钮：${text}`).toBeDefined();
  await act(async () => (target as HTMLElement).click());
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
const writes = () => requests.filter((request) => request.method === 'PATCH');
async function openEditor() {
  await render(h(EditPersonButton, { employeeId, saved() {} }));
  await click('编辑人员');
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  permissions.current = permission(['name', customKey(fieldId), customKey(otherId)], ['name', customKey(fieldId)]);
  detail = {
    id: employeeId,
    revision: 3,
    name: '合成员工',
    customFields: { [fieldId]: '合成旧值', [otherId]: '合成备注值' },
  };
  requests = [];
  conflicts = 0;
  afterConflict = undefined;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    requests.push({ method, path, headers: new Headers(init?.headers), body });
    // 定义目录：旧实现读配置接口，新实现读人员业务侧接口，两边都回同一份夹具，只看前端行为。
    if (path.includes('custom-field')) return Response.json(definitions);
    if (path === detailPath && method === 'GET') return Response.json(detail);
    if (path === detailPath && method === 'PATCH') {
      if (conflicts > 0) {
        conflicts -= 1;
        if (afterConflict) detail = afterConflict;
        return Response.json({ error: { code: 'REVISION_CONFLICT', message: '资料已被他人修改' } }, { status: 409 });
      }
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

describe('AC-FE-F4746c-R2 编辑人员的自定义字段提交', () => {
  it('P2-1 只清空已有的自定义值：发出 PATCH，该键为 null，没改的字段不提交', async () => {
    await openEditor();
    await type(`[aria-label="合成文本"]`, '');
    await click('保存');
    expect(writes().length).toBe(1);
    expect(writes()[0]!.body).toEqual({ customFields: { [fieldId]: null } });
    expect(writes()[0]!.headers.get('if-match')).toBe('3');
  });

  it('P2-1 只改预置字段：请求体不带任何没改的自定义字段', async () => {
    await openEditor();
    await type('input#name', '合成新名');
    await click('保存');
    expect(writes().length).toBe(1);
    expect(writes()[0]!.body).toEqual({ name: '合成新名' });
  });

  it('P2-1 409 后重读并确认：同事刚改的自定义值保留，只提交用户自己改过的键', async () => {
    conflicts = 1;
    afterConflict = {
      ...detail,
      revision: 4,
      customFields: { [fieldId]: '同事新值', [otherId]: '合成备注值' },
    };
    await openEditor();
    await type('input#name', '合成新名');
    await click('保存');
    expect(writes().length).toBe(1);
    await click('重读最新版本');
    await click('已核对差异，继续编辑');
    await click('保存');
    expect(writes().length).toBe(2);
    expect(writes()[1]!.body).toEqual({ name: '合成新名' });
    expect(writes()[1]!.headers.get('if-match')).toBe('4');
    expect((detail.customFields as Record<string, unknown>)[fieldId]).toBe('同事新值');
  });
});

describe('AC-FE-F4746c-R2 定义目录与档案分区', () => {
  it('P2-2 人员页读业务侧目录，不碰需要配置管理能力的配置接口', async () => {
    await openEditor();
    const paths = requests.map((request) => request.path.split('?')[0]);
    expect(paths).toContain('/api/tenant/personnel/custom-field-definitions');
    expect(paths.filter((path) => path.startsWith('/api/tenant/employment/custom-fields'))).toEqual([]);
  });

  it('P2-3 只有 custom:<id> 查看权（预置字段只有 id、revision）：基本信息分区仍显示该字段', async () => {
    permissions.current = permission(['id', 'revision', customKey(fieldId)], []);
    await render(h(PersonnelProfile, { row: detail, employeeId }));
    const text = host.textContent ?? '';
    expect(text).toContain('合成文本');
    expect(text).toContain('合成旧值');
    expect(text).not.toContain('合成备注');
  });
});
