// @vitest-environment happy-dom
/**
 * AC-APV-F326-39（F-326 S7b，DEC-941，主设计 §5.5“管理员在变量页手改自动变量”）变量页：
 * - 39-21 列表多一列“来源”：人工 / 自动（流程名 · 节点名）；
 * - 39-22 编辑自动变量：适用范围固定为“流程”且置灰，编码、数据类型、来源只读；人工变量不受影响；
 * - 39-23 重新启用自动变量成功后提示：若已无引用，下次保存来源流程时会再次停用（DEC-861⑧）。
 * 页面经 PAGES 登记加载；行形状照后端 variableViews（含 origin / originProcessName / originNodeName），合成数据。
 */
import { act, createElement as h, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PAGES } from '../../foundation/routes.js';
import { SessionProvider } from '../../foundation/Session.js';
import { PermissionsProvider } from '../../foundation/Permissions.js';
import { page, publicVariable } from '../../../smoke/variable-fixtures.js';

const API = '/api/tenant/approval/variables';
const autoRow = publicVariable({
  id: '50000000-0000-4000-8000-000000000393',
  code: 'Global.B.SynthAutoA',
  name: '上级审批-指定人员',
  usageScopes: ['process'],
  origin: 'auto',
  originProcessName: '合成调动流程',
  originNodeName: '上级审批',
});
const manualRow = publicVariable({ id: '50000000-0000-4000-8000-000000000394' });
const disabledAuto = { ...autoRow, id: '50000000-0000-4000-8000-000000000395', status: 'disabled' as const };
let host: HTMLDivElement;
let root: Root;
let writes: { url: string; method: string; body: unknown }[];

const text = () => document.body.textContent ?? '';
const squash = (node: Element | null) => node?.textContent?.replace(/\s/g, '') ?? '';
const settle = async () => {
  for (let i = 0; i < 20; i += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
};
async function click(label: string, scope: ParentNode = document) {
  const target = [...scope.querySelectorAll<HTMLElement>('button, [role="tab"]')].find(
    (node) => squash(node) === label,
  );
  expect(target, label).toBeDefined();
  await act(async () => target!.click());
  await settle();
}
const row = (id: string) => document.querySelector<HTMLElement>(`tr[data-row-key="${id}"]`);
const header = () => [...document.querySelectorAll('thead th')].map((th) => squash(th));
function cell(id: string, title: string) {
  const index = header().indexOf(title);
  expect(index, `列 ${title}`).toBeGreaterThanOrEqual(0);
  return squash(row(id)!.querySelectorAll('td')[index]!);
}
const usageItem = () =>
  [...document.querySelectorAll<HTMLElement>('.ant-modal .ant-form-item')].find((item) =>
    item.querySelector('label')?.textContent?.includes('适用范围'),
  );

async function render() {
  const Page = PAGES.configurations.find((item) => item.id === 'public-variables')!.page!.Component;
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
          children: h(MemoryRouter, {
            initialEntries: ['/config-center/global/public-variables'],
            children: h(Suspense, { fallback: null, children: h(Page) }),
          }),
        }),
      }),
    ),
  );
  for (let i = 0; i < 200 && !host.querySelector('[role="tab"]'); i += 1) await settle();
  await settle();
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  writes = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      writes.push({ url: url.pathname, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.pathname.endsWith('/enable')) return Response.json({ ...disabledAuto, status: 'enabled', revision: 3 });
      return Response.json({ ...autoRow, revision: autoRow.revision + 1 });
    }
    if (url.pathname.endsWith('/permission/me/snapshot'))
      return Response.json({
        session: { tenantId: 'synthetic-tenant', timezone: 'Asia/Shanghai' },
        apps: [],
        scope: [],
        adminMenus: [],
      });
    if (url.pathname === `${API}/${disabledAuto.id}`) return Response.json(disabledAuto);
    if (url.pathname === `${API}/${autoRow.id}`) return Response.json(autoRow);
    const status = url.searchParams.get('status');
    return Response.json(page(status === 'disabled' ? [disabledAuto] : [autoRow, manualRow]));
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

it('AC-APV-F326-39-21 列表“来源”列：自动变量显示“自动（流程名 · 节点名）”，人工变量显示“人工”', async () => {
  await render();
  expect(header()).toContain('来源');
  expect(cell(autoRow.id, '来源')).toBe('自动（合成调动流程·上级审批）');
  expect(cell(manualRow.id, '来源')).toBe('人工');
});

it('AC-APV-F326-39-22 编辑自动变量：适用范围固定为流程并置灰、来源只读；人工变量适用范围仍可改', async () => {
  await render();
  await click('编辑', row(autoRow.id)!);
  const usage = usageItem();
  expect(usage, '适用范围').toBeDefined();
  const radios = [...usage!.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]')];
  expect(radios.length).toBeGreaterThan(0);
  expect(radios.every((input) => input.disabled)).toBe(true);
  expect(squash(document.querySelector('.ant-modal'))).toContain('自动（合成调动流程·上级审批）');
  await click('取消', document.querySelector('.ant-modal')!);
  await click('编辑', row(manualRow.id)!);
  const manual = usageItem();
  const inputs = [...manual!.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]')];
  expect(inputs.some((input) => !input.disabled)).toBe(true);
});

it('AC-APV-F326-39-23 重新启用自动变量成功：提示若已无引用，下次保存来源流程时将再次停用', async () => {
  await render();
  await click('停用的公共变量');
  await click('启用', row(disabledAuto.id)!);
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('.ant-popover button')].at(-1);
  await act(async () => confirm!.click());
  await settle();
  expect(writes.map((item) => item.url)).toEqual([`${API}/${disabledAuto.id}/enable`]);
  expect(text()).toContain(
    '已启用。若该自动变量已无流程引用，下次保存来源流程「合成调动流程」时会再次停用；需要长期使用请改建人工变量',
  );
});
