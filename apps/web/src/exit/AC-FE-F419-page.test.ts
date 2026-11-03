// @vitest-environment happy-dom
// F-419：通过既有设置页路由渲染真实表单与 F-123 内核，网络夹具形态另由 HTTP 契约用例核对。
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_TERMINATION_FLOWS, EXIT_TERMINATION_PRESET } from '@italent/domain';
import { ExitSettingsPage } from './ExitSettingsPage.js';
import { SessionProvider } from '../foundation/Session.js';
import { uniqueSuffix } from '../../../../tests/acceptance/support/unique.js';
import { terminationDefault, terminationRejected } from '../../smoke/exit-termination-fixtures.js';

const permissions = vi.hoisted(() => ({ editable: true }));
vi.mock('../foundation/Permissions.js', () => ({
  usePermissions: () => ({
    snapshot: { objects: {} },
    menus: [{ key: 'settings', children: [{ key: 'other.mou_settings', editable: permissions.editable }] }],
  }),
}));
vi.mock('../foundation/DecisionNote.js', () => ({ DecisionNote: () => null }));
const PATH = '/api/tenant/settings/exit.termination_flow_types';
const TITLE = '离职/退休生效时终止在途流程';
let host: HTMLDivElement;
let root: Root;
let setting: typeof terminationDefault;
let writes: { body: { value: Record<string, boolean> }; headers: Headers }[];
let response: (() => Promise<Response>) | undefined;
let identity: string;
const settle = async () => {
  for (let i = 0; i < 8; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
};
async function render() {
  await act(async () =>
    root.render(
      h(SessionProvider, {
        session: {
          tenantId: 'synthetic-tenant',
          identityKey: identity,
          tenantName: '合成租户',
          timezone: 'Asia/Shanghai',
          displayName: '合成管理员',
          source: 'server',
        },
        children: h(
          MemoryRouter,
          { initialEntries: ['/exit-settings/termination-flows'] },
          h(Routes, null, h(Route, { path: '/exit-settings/*', element: h(ExitSettingsPage) })),
        ),
      }),
    ),
  );
  await settle();
}
const checkbox = (name: string) => {
  const label = [...host.querySelectorAll('label')].find((node) => node.textContent === name);
  const input = label?.querySelector('input');
  expect(input, `应渲染流程勾选框：${name}`).toBeDefined();
  return input!;
};
async function click(text: string) {
  const button = [...host.querySelectorAll('button, [role="tab"]')].find(
    (node) => node.textContent?.replace(/\s/g, '') === text,
  );
  expect(button, `应存在操作：${text}`).toBeDefined();
  await act(async () => (button as HTMLElement).click());
  await settle();
}
async function toggle(name: string) {
  await act(async () => checkbox(name).click());
  await settle();
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  identity = uniqueSuffix();
  setting = structuredClone(terminationDefault);
  permissions.editable = true;
  writes = [];
  response = undefined;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input) !== PATH) return Response.json({ items: [] });
    if (!init?.method || init.method === 'GET') return Response.json(setting);
    const body = JSON.parse(String(init.body)) as { value: Record<string, boolean> };
    const headers = new Headers(init.headers);
    writes.push({ body, headers });
    if (response) return response();
    if (headers.get('if-match') !== String(setting.revision))
      return Response.json({ error: { code: 'REVISION_CONFLICT', message: '配置已被他人修改' } }, { status: 409 });
    setting = { ...setting, value: body.value, revision: setting.revision + 1, source: 'tenant' };
    return Response.json(setting);
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

describe('AC-FE-F419 离职终止配置页', () => {
  it('按原站目录顺序渲染 28 类、四组；缺键按预置，新增兼职已勾选且禁用', async () => {
    setting.value = {};
    await render();
    expect([...host.querySelectorAll('[role="tab"]')].map((node) => node.textContent)).toContain(TITLE);
    expect([...host.querySelectorAll('h2')].map((node) => node.textContent)).toEqual([
      '任职流程',
      '合同流程',
      '考核流程',
      '个人信息流程',
    ]);
    const boxes = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes).toHaveLength(28);
    expect(boxes.map((node) => node.closest('label')?.textContent)).toEqual(
      Object.values(EXIT_TERMINATION_FLOWS).map((flow) => flow.name),
    );
    expect(boxes.filter((box) => box.checked)).toHaveLength(27);
    expect(checkbox('新增兼职').checked).toBe(true);
    expect(checkbox('新增兼职').disabled).toBe(true);
    expect(checkbox('新建合同协议').checked).toBe(false);
  });

  it('三类调动分别可取消，保存全量配置并带实际 revision；成功后读取最新值', async () => {
    setting.revision = 4;
    await render();
    await toggle('机构间调动');
    await toggle('批量调动');
    await click('保存');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.body).toEqual({
      value: { ...EXIT_TERMINATION_PRESET, inter_org_transfer: false, batch_transfer: false },
    });
    expect(writes[0]!.headers.get('if-match')).toBe('4');
    expect(writes[0]!.headers.get('idempotency-key')).toBeTruthy();
    expect(checkbox('调动').checked).toBe(true);
    expect(checkbox('机构间调动').checked).toBe(false);
    await toggle('调动');
    await click('保存');
    expect(writes[1]!.headers.get('if-match')).toBe('5');
    expect(writes[1]!.body.value.transfer).toBe(false);
  });

  it('400 SETTING_VALUE_INVALID 明确拒绝保留勾选与原因，允许改正重提', async () => {
    response = async () => Response.json(terminationRejected, { status: 400 });
    await render();
    await toggle('调动');
    await click('保存');
    expect(host.textContent).toContain('配置值不合法');
    expect(checkbox('调动').checked).toBe(false);
    expect(checkbox('调动').disabled).toBe(false);
    response = undefined;
    await toggle('新建合同协议');
    await click('保存');
    expect(setting.value).toMatchObject({ transfer: false, contract_create: true });
    expect(writes[0]!.headers.get('idempotency-key')).not.toBe(writes[1]!.headers.get('idempotency-key'));
  });

  it('409 重读回填未改项；核对后把改过字段改回原值，仍按最新版本提交', async () => {
    await render();
    setting = {
      ...setting,
      revision: 1,
      value: { ...EXIT_TERMINATION_PRESET, contract_create: true, transfer: false },
    };
    await toggle('调动');
    await click('保存');
    expect(host.textContent).toContain('版本冲突：输入已保留');
    await click('重读最新版本');
    await click('已核对差异，继续编辑');
    expect(checkbox('新建合同协议').checked).toBe(true);
    await toggle('调动');
    await click('保存');
    expect(writes[1]!.headers.get('if-match')).toBe('1');
    expect(writes[1]!.body.value).toMatchObject({ contract_create: true, transfer: true });
  });

  it('回执丢失后切换页签再返回，原输入和只读锁保留，不再发命令', async () => {
    response = async () => {
      throw new TypeError('network');
    };
    await render();
    await toggle('调动');
    await click('保存');
    expect(host.textContent).toContain('处理中 / 结果待确认');
    await click('离职类型');
    await click(TITLE);
    expect(checkbox('调动').checked).toBe(false);
    expect(checkbox('调动').disabled).toBe(true);
    expect(host.textContent).toContain('处理中 / 结果待确认');
    await click('保存');
    expect(writes).toHaveLength(1);
  });

  it.each(['permission', 'overridable'])('无编辑能力 %s 时只读展示，不显示保存', async (reason) => {
    if (reason === 'permission') permissions.editable = false;
    else setting.overridable = false;
    await render();
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(28);
    expect([...host.querySelectorAll<HTMLInputElement>('input')].every((node) => node.disabled)).toBe(true);
    expect([...host.querySelectorAll('button')].some((node) => node.textContent?.replace(/\s/g, '') === '保存')).toBe(
      false,
    );
    expect(writes).toEqual([]);
  });
});
