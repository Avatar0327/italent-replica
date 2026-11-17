// @vitest-environment happy-dom
// F-478 S7 AC-EMP-F478-27：经离职退休设置页路由渲染真实表单与 F-123 内核；夹具信封另由 AC-EMP-F478-27.contract 按真实接口核对。
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { message } from 'antd';
import { ExitSettingsPage } from './ExitSettingsPage.js';
import { SessionProvider } from '../foundation/Session.js';
import { uniqueSuffix } from '../../../../tests/acceptance/support/unique.js';
import { retireSeniorityConflict, retireSeniorityDefault } from '../../smoke/retire-seniority-fixtures.js';

const permissions = vi.hoisted(() => ({ editable: true }));
vi.mock('../foundation/Permissions.js', () => ({
  usePermissions: () => ({
    snapshot: { objects: {} },
    menus: [{ key: 'settings', children: [{ key: 'other.mou_settings', editable: permissions.editable }] }],
  }),
}));
vi.mock('../foundation/DecisionNote.js', () => ({ DecisionNote: () => null }));
const PATH = `/api/tenant/settings/${retireSeniorityDefault.key}`;
const TITLE = '退休返聘累计司龄';
// docs/02_业务建模/17 第 120 行原文（设计 §7.2：设置页在开关旁显示该提示原文）。
const HINT =
  '实习转正和退休返聘也可以用“表单不放入职日期、自动继承原入职日期”的方式来累计司龄。' +
  '此时开关必须保持关闭，否则会重复累计。';
let host: HTMLDivElement;
let root: Root;
let setting: typeof retireSeniorityDefault;
let writes: { body: unknown; headers: Headers }[];
let response: (() => Promise<Response>) | undefined;
let getStatus: number;
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
          { initialEntries: ['/exit-settings/retire-rehire-seniority'] },
          h(Routes, null, h(Route, { path: '/exit-settings/*', element: h(ExitSettingsPage) })),
        ),
      }),
    ),
  );
  await settle();
}
const toggleNode = () => {
  const node = host.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${TITLE}"]`);
  expect(node, `应渲染开关：${TITLE}`).toBeTruthy();
  return node!;
};
const checked = () => toggleNode().getAttribute('aria-checked') === 'true';
const hasButton = (text: string) =>
  [...host.querySelectorAll('button')].some((node) => node.textContent?.replace(/\s/g, '') === text);
async function click(text: string) {
  const button = [...host.querySelectorAll('button, [role="tab"]')].find(
    (node) => node.textContent?.replace(/\s/g, '') === text,
  );
  expect(button, `应存在操作：${text}`).toBeDefined();
  await act(async () => (button as HTMLElement).click());
  await settle();
}
async function flip() {
  await act(async () => toggleNode().click());
  await settle();
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  identity = uniqueSuffix();
  setting = structuredClone(retireSeniorityDefault);
  permissions.editable = true;
  writes = [];
  response = undefined;
  getStatus = 200;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input) !== PATH) return Response.json({ items: [] });
    if (!init?.method || init.method === 'GET') {
      if (getStatus !== 200)
        return Response.json({ error: { code: 'FORBIDDEN', message: '无权访问' } }, { status: getStatus });
      return Response.json(setting);
    }
    const body = JSON.parse(String(init.body)) as { value: boolean };
    const headers = new Headers(init.headers);
    writes.push({ body, headers });
    if (response) return response();
    if (headers.get('if-match') !== String(setting.revision))
      return Response.json(retireSeniorityConflict, { status: 409 });
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

describe('AC-EMP-F478-27 设置页“退休返聘累计司龄”开关', () => {
  it('离职退休设置显示该页签、默认关闭的开关与“继承原入职日期须关闭”提示原文', async () => {
    await render();
    expect([...host.querySelectorAll('[role="tab"]')].map((node) => node.textContent)).toContain(TITLE);
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(TITLE);
    expect(host.querySelector('h1')?.textContent).toBe(TITLE);
    expect(checked()).toBe(false);
    expect(toggleNode().disabled).toBe(false);
    expect(host.textContent).toContain(HINT);
    expect(hasButton('保存')).toBe(true);
  });

  it('打开后保存只提交 { value: true } 并带实际 revision；成功后按新版本读回，再关闭按新版本提交', async () => {
    setting.revision = 3;
    const success = vi.spyOn(message, 'success');
    await render();
    await flip();
    await click('保存');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.body).toEqual({ value: true });
    expect(writes[0]!.headers.get('if-match')).toBe('3');
    expect(writes[0]!.headers.get('idempotency-key')).toBeTruthy();
    expect(success).toHaveBeenCalled();
    expect(checked()).toBe(true);
    await flip();
    await click('保存');
    expect(writes[1]!.headers.get('if-match')).toBe('4');
    expect(writes[1]!.body).toEqual({ value: false });
    expect(setting).toMatchObject({ value: false, revision: 5, source: 'tenant' });
  });

  it('没有改动时不发请求', async () => {
    const info = vi.spyOn(message, 'info');
    await render();
    await click('保存');
    expect(writes).toEqual([]);
    expect(info).toHaveBeenCalled();
  });

  it('保存 409：保留输入并提示刷新，不自动重提；重读后把开关改回原值仍按最新版本提交', async () => {
    await render();
    // 他人已打开开关：本页仍按 revision 0 提交
    setting = { ...setting, value: true, revision: 1, source: 'tenant' };
    await flip();
    await click('保存');
    expect(writes).toHaveLength(1);
    expect(host.textContent).toContain('版本冲突：输入已保留');
    expect(checked()).toBe(true);
    await click('重读最新版本');
    await click('已核对差异，继续编辑');
    expect(writes).toHaveLength(1);
    expect(checked()).toBe(true);
    await flip();
    await click('保存');
    expect(writes).toHaveLength(2);
    expect(writes[1]!.headers.get('if-match')).toBe('1');
    expect(writes[1]!.body).toEqual({ value: false });
    expect(writes[0]!.headers.get('idempotency-key')).not.toBe(writes[1]!.headers.get('idempotency-key'));
  });

  it('回执丢失：只读锁定“处理中 / 结果待确认”，切换页签再返回仍锁定，不再发命令', async () => {
    response = async () => {
      throw new TypeError('network');
    };
    await render();
    await flip();
    await click('保存');
    expect(host.textContent).toContain('处理中 / 结果待确认');
    await click('离职类型');
    await click(TITLE);
    expect(checked()).toBe(true);
    expect(toggleNode().disabled).toBe(true);
    expect(host.textContent).toContain('处理中 / 结果待确认');
    await click('保存');
    expect(writes).toHaveLength(1);
  });

  it('回执值与发送值相反：按结果未知锁定，不提示成功', async () => {
    const success = vi.spyOn(message, 'success');
    response = async () => Response.json({ ...setting, value: false, source: 'tenant', revision: 1 });
    await render();
    await flip();
    await click('保存');
    expect(host.textContent).toContain('处理中 / 结果待确认');
    expect(success).not.toHaveBeenCalled();
    expect(toggleNode().disabled).toBe(true);
  });

  it('保存回执迟到：已切到别的页签不跳回；回来读取已保存的新值', async () => {
    let finish!: (reply: Response) => void;
    response = () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      });
    await render();
    await flip();
    await click('保存');
    await click('离职类型');
    setting = { ...setting, value: true, revision: 1, source: 'tenant' };
    await act(async () => finish(Response.json(setting)));
    await settle();
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('离职类型');
    await click(TITLE);
    expect(checked()).toBe(true);
    expect(toggleNode().disabled).toBe(false);
    expect(writes).toHaveLength(1);
  });

  it.each([
    ['无其他设置编辑权', '当前身份只能查看'],
    ['系统不可覆盖', '该设置由系统统一管控'],
  ])('%s：开关与提示只读显示，不显示保存', async (reason, hint) => {
    if (reason === '无其他设置编辑权') permissions.editable = false;
    else setting.overridable = false;
    setting.value = true;
    await render();
    expect(checked()).toBe(true);
    expect(toggleNode().disabled).toBe(true);
    expect(host.textContent).toContain(HINT);
    expect(host.textContent).toContain(hint);
    expect(hasButton('保存')).toBe(false);
    expect(writes).toEqual([]);
  });

  it('读取 403：显示无权限，不渲染开关', async () => {
    getStatus = 403;
    await render();
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(TITLE);
    expect(host.querySelector('[role="switch"]')).toBeNull();
    expect(hasButton('保存')).toBe(false);
  });
});
