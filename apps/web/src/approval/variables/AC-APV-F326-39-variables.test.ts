// @vitest-environment happy-dom
/**
 * AC-APV-F326-39（F-326 S7b，F-326-L §5.5）变量页：启用自动变量撞上同位置已有启用的自动变量
 * （409 APPROVAL_AUTO_VARIABLE_SLOT_TAKEN，details.occupiedBy 照后端 auto-variables.ts）时，
 * 提示改用占位变量或回设计器重选人员，不显示服务端通用句。页面经 PAGES 登记加载，合成数据。
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
const disabled = publicVariable({
  id: '50000000-0000-4000-8000-000000000391',
  code: 'Global.B.SynthAutoOld',
  name: '合成自动变量（旧）',
  status: 'disabled',
  revision: 4,
});
const occupant = { id: '50000000-0000-4000-8000-000000000392', code: 'Global.B.SynthAutoNew', name: '合成自动变量' };
let host: HTMLDivElement;
let root: Root;
let writes: string[];

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

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  writes = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if ((init?.method ?? 'GET') !== 'GET') {
      writes.push(url);
      return Response.json(
        {
          error: {
            code: 'CONFLICT',
            message: '该位置已有启用的自动变量，请先停用后再启用',
            details: { reason: 'APPROVAL_AUTO_VARIABLE_SLOT_TAKEN', occupiedBy: occupant },
          },
        },
        { status: 409 },
      );
    }
    if (url.endsWith('/permission/me/snapshot'))
      return Response.json({
        session: { tenantId: 'synthetic-tenant', timezone: 'Asia/Shanghai' },
        apps: [],
        scope: [],
        adminMenus: [],
      });
    const status = new URL(url, 'http://localhost').searchParams.get('status');
    return Response.json(page(status === 'disabled' ? [disabled] : []));
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

it('AC-APV-F326-39-13 启用撞上同位置已启用的自动变量：提示占位变量编码，引导改用或回设计器重选', async () => {
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
  await click('停用的公共变量');
  const row = document.querySelector<HTMLElement>(`tr[data-row-key="${disabled.id}"]`);
  expect(row, '停用行').not.toBeNull();
  await click('启用', row!);
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('.ant-popover button')].at(-1);
  await act(async () => confirm!.click());
  await settle();
  expect(writes).toEqual([`${API}/${disabled.id}/enable`]);
  expect(text()).toContain('该位置已有自动变量Global.B.SynthAutoNew，请改用它，或在流程设计器里重新选择人员');
  expect(text()).not.toContain('请先停用后再启用');
});
