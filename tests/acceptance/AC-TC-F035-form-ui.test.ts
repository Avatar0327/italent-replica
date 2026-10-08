/// <reference lib="dom" />
// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;

const ID = '00000000-0000-4000-8000-000000000035';
const LIBRARY = { id: 'library', name: '候选指标库', type: 'ability', enabled: true };
const CATEGORY = { id: 'category', name: '候选分类' };
const UNIT = { id: 'unit', name: '授权管理单元' };
const base = { id: ID, revision: 3, name: '只读名称', enabled: true, displayOrder: 1 };

const panels = [
  { module: 'LibraryPanel', object: 'library', path: 'libraries', field: 'displayOrder', label: '顺序' },
  {
    module: 'CategoryPanel',
    object: 'criterionCategory',
    path: 'criterion-categories',
    field: 'displayOrder',
    label: '顺序',
  },
  {
    module: 'DimensionCategoryPanel',
    object: 'dimensionCategory',
    path: 'dimension-categories',
    field: 'displayOrder',
    label: '顺序',
  },
  {
    module: 'DescriptionTypePanel',
    object: 'descriptionType',
    path: 'description-types',
    field: 'displayOrder',
    label: '顺序',
  },
  { module: 'DimensionPanel', object: 'dimension', path: 'dimensions', field: 'definition', label: '定义' },
  { module: 'CriterionPanel', object: 'criterion', path: 'criteria', field: 'potentialNote', label: '潜力说明' },
] as const;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function fixture(path: string) {
  if (path === 'dimensions') return { ...base, libraryId: LIBRARY.id, type: 'ability', definition: null };
  if (path === 'criteria') return { ...base, categoryId: CATEGORY.id, potentialNote: null, dimensions: [] };
  if (path === 'dimension-categories') return { ...base, libraryId: LIBRARY.id };
  if (path === 'libraries') return { ...base, type: 'ability' };
  return base;
}

function mockRequests({
  path,
  editableFields,
  requiredFields = [],
  blockedReason,
  creating = false,
  ownerResponse,
  categories = [CATEGORY],
}: {
  path: string;
  editableFields: readonly string[];
  requiredFields?: readonly string[];
  blockedReason?: string;
  creating?: boolean;
  ownerResponse?: (options: RequestInit) => Response | Promise<Response>;
  categories?: readonly unknown[];
}) {
  const writes: { path: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, options: RequestInit = {}) => {
      const url = new URL(input, 'http://localhost');
      const route = url.pathname.replace('/api/tenant/talent/', '');
      if (options.method === 'PATCH' || options.method === 'POST') {
        writes.push({ path: route, body: JSON.parse(String(options.body)) as unknown });
        return json(fixture(path));
      }
      if (route.startsWith('forms/')) return json({ editableFields, requiredFields, blockedReason });
      if (route === 'candidates/owner-orgs') return ownerResponse ? ownerResponse(options) : json({ items: [UNIT] });
      if (route === `${path}/${ID}`) return json(fixture(path));
      if (route === path) return json({ items: creating ? [] : [fixture(path)], hasDataPermission: true });
      if (route === 'libraries') return json({ items: [LIBRARY], hasDataPermission: true });
      if (route === 'criterion-categories') return json({ items: categories, hasDataPermission: true });
      return json({ items: [], hasDataPermission: true });
    }),
  );
  return writes;
}

async function renderPanel(module: string, tenantId = 'tenant-a') {
  const components = (await import(resolve(`apps/web/src/talent/${module}.tsx`))) as Record<string, unknown>;
  await act(async () => root.render(createElement(components[module], { tenantId })));
}

async function click(label: string) {
  const button = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
    (item) => item.textContent === label,
  );
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}

function field(label: string) {
  const element = Array.from(host.querySelectorAll('form label')).find(
    (item) => item.firstChild?.textContent === label,
  );
  return (
    element?.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select') ??
    null
  );
}

async function enter(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype =
      control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, value);
    control.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it.each(panels)('AC-TC-F035 $object 只渲染服务端允许编辑的字段，其余编辑正常提交', async (panel) => {
  const writes = mockRequests({ path: panel.path, editableFields: [panel.field] });
  await renderPanel(panel.module);
  await click('编辑');
  const form = host.querySelector('form')!;
  expect(form).toBeTruthy();
  expect(field('名称')).toBeNull();
  expect(field('编码')).toBeNull();
  expect(field('指标库')).toBeNull();
  expect(field('人才标准分类')).toBeNull();
  expect(form.querySelector('[required]')).toBeNull();
  const control = field(panel.label)!;
  expect(control).toBeTruthy();
  await enter(control as HTMLInputElement | HTMLTextAreaElement, panel.field === 'displayOrder' ? '9' : '获准修改');
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(writes).toEqual([
    { path: `${panel.path}/${ID}`, body: { [panel.field]: panel.field === 'displayOrder' ? 9 : '获准修改' } },
  ]);
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes(`forms/${panel.object}`))).toBe(true);
  expect(
    vi
      .mocked(fetch)
      .mock.calls.some(([url]) => String(url).includes(`operation=update`) && String(url).includes(`id=${ID}`)),
  ).toBe(true);
});

it('AC-TC-F035 新建缺少必需字段编辑权，显示服务端阻止原因并禁用保存', async () => {
  const reason = '名称没有可见且可编辑权限，无法新建';
  const writes = mockRequests({
    path: 'libraries',
    editableFields: ['displayOrder'],
    requiredFields: ['name', 'type'],
    blockedReason: reason,
    creating: true,
  });
  await renderPanel('LibraryPanel');
  await click('新建');
  const form = host.querySelector('form')!;
  expect(form.textContent).toContain(reason);
  expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  expect(field('名称')).toBeNull();
  expect(writes).toEqual([]);
});

it('AC-TC-F035 管理单元候选加载中明确提示，字段不能直接消失', async () => {
  const { OwnerUnitField } = await import('../../apps/web/src/talent/OwnerOrgSelect.js');
  await act(async () =>
    root.render(
      createElement(OwnerUnitField, {
        editing: false,
        value: '',
        options: undefined,
        onChange: () => {},
      }),
    ),
  );
  expect(host.textContent).toMatch(/管理单元.*加载|加载.*管理单元/);
});

it.each(['失败', '为空'])('AC-TC-F035 新建的管理单元候选%s时在表单提示并禁用保存', async (state) => {
  const writes = mockRequests({
    path: 'libraries',
    editableFields: ['name', 'type', 'enabled', 'displayOrder', 'ownerOrgId'],
    requiredFields: ['name', 'type'],
    creating: true,
    ownerResponse: () =>
      state === '失败'
        ? json({ error: { code: 'FORBIDDEN', message: '管理单元候选没有访问权限' } }, 403)
        : json({ items: [] }),
  });
  await renderPanel('LibraryPanel');
  await click('新建');
  const form = host.querySelector('form')!;
  expect(form.textContent).toMatch(state === '失败' ? /管理单元.*(?:失败|权限|不可用)/ : /无可用的管理单元/);
  expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  expect(writes).toEqual([]);
});

it('AC-TC-F035 切换租户后候选失败，清除旧租户管理单元，不沿用旧选项', async () => {
  mockRequests({
    path: 'libraries',
    editableFields: ['name', 'type', 'ownerOrgId'],
    requiredFields: ['name', 'type'],
    creating: true,
    ownerResponse: (options) => {
      const tenant = (options.headers as Record<string, string>)['x-tenant-id'];
      return tenant === 'tenant-a'
        ? json({
            items: [
              { id: 'old-a', name: '旧租户单元甲' },
              { id: 'old-b', name: '旧租户单元乙' },
            ],
          })
        : json({ error: { message: '新租户管理单元候选读取失败' } }, 403);
    },
  });
  await renderPanel('LibraryPanel');
  await click('新建');
  expect(host.querySelector('form')!.textContent).toContain('旧租户单元甲');
  await renderPanel('LibraryPanel', 'tenant-b');
  expect(host.querySelector('form')!.textContent).not.toContain('旧租户单元');
  expect(host.querySelector('form')!.textContent).toMatch(/管理单元.*(?:失败|权限|不可用)/);
  expect(host.querySelector<HTMLButtonElement>('form button[type="submit"]')!.disabled).toBe(true);
});

it('AC-TC-F035 标准新建没有可选分类时明确提示并禁用保存', async () => {
  mockRequests({
    path: 'criteria',
    editableFields: ['categoryId', 'name', 'enabled'],
    requiredFields: ['categoryId', 'name'],
    creating: true,
    categories: [],
  });
  await renderPanel('CriterionPanel');
  await click('新建');
  const form = host.querySelector('form')!;
  expect(form.textContent).toMatch(/(?:无|没有|暂无).*可(?:用|选).*分类|分类.*(?:无|没有|暂无).*可(?:用|选)/);
  expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
});
