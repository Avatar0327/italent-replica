// @vitest-environment happy-dom
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OFFER_VIEWS } from '@italent/domain';
import { SessionProvider } from '../foundation/Session.js';
import { PermissionsProvider } from '../foundation/Permissions.js';
import { ui } from '../foundation/messages.js';
const tenant = '10000000-0000-4000-8000-000000000001';
const snapshotFixture = {
  session: { tenantId: tenant, timezone: 'Asia/Shanghai' },
  apps: [],
  scope: [],
  adminMenus: [],
};
import { offerRow, offerPermission, listFixture } from '../../smoke/offer-list-fixture.js';
import { OfferList } from './OfferList.js';

let host: HTMLDivElement;
let root: Root;
let row: Record<string, unknown>;
let permission: typeof offerPermission;
let response: () => Promise<Response>;
const allText = () => document.body.textContent ?? '';
async function render(identityKey = 'reader') {
  await act(async () =>
    root.render(
      h(SessionProvider, {
        session: {
          tenantId: tenant,
          identityKey,
          tenantName: '',
          timezone: 'Asia/Shanghai',
          displayName: '',
          source: 'server',
        },
        children: h(PermissionsProvider, { children: h(MemoryRouter, { children: h(OfferList) }) }),
      }),
    ),
  );
}
async function click(text: string) {
  const button = [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === text);
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  row = { ...offerRow };
  permission = { ...offerPermission };
  response = async () => Response.json(listFixture([row]));
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith('/permission/me/snapshot')) return Response.json(snapshotFixture);
    if (url.includes('/permission/me/objects/')) return Response.json(permission);
    if (url.endsWith('/offers/views')) return Response.json({ items: OFFER_VIEWS });
    if (url.endsWith(`/offers/${offerRow.id}`)) return Response.json({ ...row, name: '合成详情候选人' });
    return response();
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AC-FE-F298 真实列表与详情', () => {
  it('列表显示服务端名称，点姓名用真实 ID 重读详情，六类名称不回落 UUID', async () => {
    await render();
    expect(allText()).toContain(offerRow.name);
    expect(allText()).toContain(offerRow.departmentName);
    await click(offerRow.name);
    expect(allText()).toContain('合成详情候选人');
    for (const key of ['departmentName', 'departmentFullName', 'positionName', 'postName', 'directManagerName'])
      expect(allText()).toContain(row[key]);
    for (const key of ['departmentId', 'positionId', 'postId', 'directManagerId'])
      expect(allText()).not.toContain(row[key]);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith(`/offers/${offerRow.id}`))).toBe(true);
    expect(allText()).not.toContain('演示数据');
  });
  it('字段裁剪后隐藏列及详情字段，不拿旧值或 ID 补回名称', async () => {
    for (const key of ['departmentId', 'departmentName', 'departmentFullName', 'positionId', 'positionName'])
      delete row[key];
    permission = {
      ...permission,
      viewableFields: permission.viewableFields.filter((key) => !['departmentId', 'positionId'].includes(key)),
    };
    await render();
    expect([...document.querySelectorAll('th')].map((node) => node.textContent)).not.toContain('录用部门');
    await click(offerRow.name);
    const detail = document.querySelector('.detail-drawer')!;
    expect(detail.textContent).not.toContain('录用部门');
    expect(detail.textContent).not.toContain('组织全称');
    expect(detail.textContent).not.toContain(offerRow.departmentName);
  });
  it('ID 可见且名称 null 时单元格为空占位，详情不显示 UUID', async () => {
    row.departmentName = null;
    row.departmentFullName = null;
    await render();
    const headers = [...document.querySelectorAll('th')].map((node) => node.textContent);
    const index = headers.findIndex((text) => text?.startsWith('录用部门'));
    const cells = document.querySelector(`tr[data-row-key="${offerRow.id}"]`)?.querySelectorAll('td');
    expect(cells?.[index]?.textContent).toBe('--');
    await click(offerRow.name);
    expect(document.querySelector('.detail-drawer')!.textContent).toContain('--');
    expect(allText()).not.toContain(offerRow.departmentId);
  });
  it.each(['empty', 'forbidden', 'network', 'scope'] as const)('区分列表状态 %s，不显示演示样例', async (state) => {
    response = async () => {
      if (state === 'network') throw new TypeError('Failed to fetch');
      if (state === 'forbidden') return Response.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
      return Response.json({ ...listFixture([]), hasDataPermission: state !== 'scope' });
    };
    await render();
    expect(allText()).toContain(
      { empty: ui.empty, forbidden: ui.denied, network: ui.failed, scope: ui.noScope }[state],
    );
    expect(allText()).not.toContain('合成社招甲');
  });
  it('切换身份立即清旧列表，迟到响应不能带回旧身份数据', async () => {
    await render();
    expect(allText()).toContain(offerRow.name);
    const old: ((value: Response) => void)[] = [];
    response = () => new Promise((resolve) => old.push(resolve));
    await render('second-reader');
    expect(allText()).not.toContain(offerRow.name);
    response = async () => Response.json(listFixture([{ ...offerRow, name: '合成新身份候选人' }]));
    await render('third-reader');
    await act(async () => old.forEach((resolve) => resolve(Response.json(listFixture([offerRow])))));
    expect(allText()).toContain('合成新身份候选人');
    expect(allText()).not.toContain(offerRow.name);
  });
  it.each([403, 404, 503])('详情读取 %s 不拿列表数据冒充详情', async (status) => {
    await render();
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) =>
      String(input).endsWith(`/offers/${offerRow.id}`)
        ? Promise.resolve(Response.json({ error: { code: 'READ_FAILED' } }, { status }))
        : original(input, init),
    );
    await click(offerRow.name);
    const detail = document.querySelector('.detail-drawer')!;
    expect(detail.textContent).toContain(status === 403 ? ui.denied : status === 404 ? ui.missing : ui.failed);
    expect(detail.textContent).not.toContain(offerRow.departmentName);
  });
});
