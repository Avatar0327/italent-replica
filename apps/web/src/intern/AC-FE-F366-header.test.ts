// @vitest-environment happy-dom
/**
 * F-366 R1 P2-1：真实 antd Table 表头接线。同一可排表头连点三次 = 升 → 降 → 取消；取消后箭头清空、
 * 请求不带 sortBy / direction、回第 1 页（规格 31 末尾 F-366 补充）。antd 取消时回调的 columnKey、order
 * 都是 undefined，纯函数 nextSort 的单测覆盖不到这段接线，所以整页渲染、点真实表头。
 * R1 P3-4：浏览器后退 / 前进改了 view 参数时排序也要清空，回到「实习中」不自动套用旧排序。
 */
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../foundation/Permissions.js';
import { SessionProvider } from '../foundation/Session.js';
import { InternPage } from './InternPage.js';
import { m } from './messages.js';
import { interns, object, pageSize, personObject } from './model.js';

const tenant = '10000000-0000-4000-8000-000000000366';
const session = {
  tenantId: tenant,
  identityKey: 'synthetic-f366',
  tenantName: '合成租户',
  timezone: 'Asia/Shanghai',
  displayName: '合成用户',
  source: 'server' as const,
};
const snapshot = { session: { tenantId: tenant, timezone: 'Asia/Shanghai' }, apps: [], scope: [], adminMenus: [] };
const permission = (objectCode: string, viewableFields: string[]) => ({
  objectCode,
  dataOperations: { read: true },
  viewableFields,
  editableFields: [],
  buttons: [],
});
const employmentFields = ['institutionId', 'departmentId', 'positionId', 'directManagerId', 'entryDate'];
// 形状照 intern-views.ts InternViewItem；引用列给 null，免得 NameOf 再去读名称
const rows = Array.from({ length: pageSize }, (_, index) => ({
  id: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  employeeId: `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  name: `合成实习生${index}`,
  code: `F366${index}`,
  institutionId: null,
  departmentId: null,
  positionId: null,
  directManagerId: null,
  entryDate: '2026-09-01',
  employeeStatus: 1,
  revision: 1,
}));

let root: Root;
let lists: URL[];
let navigate: ReturnType<typeof useNavigate> | undefined;
function Probe() {
  navigate = useNavigate();
  return null;
}
const lastList = () => lists.at(-1)!.searchParams;
const header = (title: string | undefined) => {
  const cell = [...document.querySelectorAll('th')].find((node) => node.textContent === title);
  expect(cell, title).toBeDefined();
  return cell!;
};
const sorted = () => [...document.querySelectorAll('th[aria-sort]')].map((node) => node.getAttribute('aria-sort'));
const pageText = () => document.querySelector('.intern-pagination > span')?.textContent;
async function click(node: HTMLElement) {
  await act(async () => node.click());
}
const button = (text: string) => {
  const found = [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === text);
  expect(found, text).toBeDefined();
  return found!;
};
async function render() {
  const page = h(PermissionsProvider, { children: [h(Probe, { key: 'probe' }), h(InternPage, { key: 'page' })] });
  const routed = h(MemoryRouter, { initialEntries: ['/interns?view=interning'], children: page });
  await act(async () => root.render(h(SessionProvider, { session, children: routed })));
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  lists = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname.endsWith('/permission/me/snapshot')) return Response.json(snapshot);
    if (url.pathname.endsWith(`/permission/me/objects/${object}`))
      return Response.json(permission(object, employmentFields));
    if (url.pathname.endsWith(`/permission/me/objects/${personObject}`))
      return Response.json(permission(personObject, ['name', 'code', 'employeeStatus']));
    const other = /\/permission\/me\/objects\/([^/]+)$/.exec(url.pathname);
    if (other) return Response.json(permission(decodeURIComponent(other[1]!), []));
    if (url.pathname === interns) {
      lists.push(url);
      return Response.json({ items: rows, hasDataPermission: true });
    }
    return Response.json({ items: [] });
  });
  root = createRoot(document.body.appendChild(document.createElement('div')));
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AC-FE-F366 实习中表头点击（真实 antd Table）', () => {
  it('同一表头连点三次：升 → 降 → 取消；取消后箭头清空、请求不带排序、回第 1 页', async () => {
    await render();
    await click(header(m.fields.departmentId));
    expect(sorted()).toEqual(['ascending']);
    expect([lastList().get('sortBy'), lastList().get('direction')]).toEqual(['departmentId', 'asc']);
    await click(header(m.fields.departmentId));
    expect(sorted()).toEqual(['descending']);
    expect([lastList().get('sortBy'), lastList().get('direction')]).toEqual(['departmentId', 'desc']);
    await click(button(m.next));
    expect(pageText()).toBe(m.page(2));
    expect(lastList().get('page')).toBe('2');

    await click(header(m.fields.departmentId));
    expect(sorted()).toEqual([]);
    expect(lastList().has('sortBy')).toBe(false);
    expect(lastList().has('direction')).toBe(false);
    expect(lastList().get('page')).toBe('1');
    expect(pageText()).toBe(m.page(1));
  });

  it('浏览器后退 / 前进换了页签：排序清空，回到实习中不自动套用旧排序', async () => {
    await render();
    await click(button(m.views.converting));
    await act(async () => void navigate!(-1));
    await click(header(m.fields.institutionId));
    expect(lastList().get('sortBy')).toBe('institutionId');
    await act(async () => void navigate!(1));
    expect(lastList().get('view')).toBe('converting');
    await act(async () => void navigate!(-1));
    expect(lastList().get('view')).toBe('interning');
    expect(sorted()).toEqual([]);
    expect(lastList().has('sortBy')).toBe(false);
    expect(lastList().has('direction')).toBe(false);
  });
});
