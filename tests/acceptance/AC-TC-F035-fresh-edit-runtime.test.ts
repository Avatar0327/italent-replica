/// <reference lib="dom" />
/**
 * AC-TC-F035：列表被旧权限裁剪后再授权，打开编辑必须读取当前详情（DEC-285②）。
 * DOM 的 fetch 直接转发真实 createApp；权限、PATCH 和最终管理员详情均经过同一个测试数据库。
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { TALENT_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { Window } from 'happy-dom';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { seedPermissionWorld, setObjectPermission, type PermissionWorld } from './AC-PRM-support.js';
import { clock, seedTalentData, talentOperator, type TalentPermissionData } from './AC-TC-permission-support.js';
import { TC_BASE, type DimensionCategoryView, type DimensionView } from './AC-TC-support.js';
import { tenantApi } from './support/tenant-api.js';

// API / PGlite 保留 Node URL、Request 与 Response；只注入表单交互所需的 DOM。
const domWindow = new Window({ url: 'http://localhost' });
Object.assign(globalThis, {
  window: domWindow,
  document: domWindow.document,
  HTMLElement: domWindow.HTMLElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
  HTMLIFrameElement: domWindow.HTMLIFrameElement,
  Event: domWindow.Event,
  Node: domWindow.Node,
});

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const testDb = useTestDb();
let world: PermissionWorld;
let data: TalentPermissionData;
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;

beforeAll(async () => {
  world = await seedPermissionWorld(testDb().db);
  world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock }) };
  data = await seedTalentData(world);
});

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

interface ApiCall {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
  readonly status: number;
  readonly result: Record<string, unknown>;
}

function forwardPanelRequests(operator: Awaited<ReturnType<typeof talentOperator>>): ApiCall[] {
  const calls: ApiCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, options: RequestInit = {}) => {
      const url = new URL(input, 'http://localhost');
      const headers = new Headers(options.headers);
      expect(headers.get('x-tenant-id')).toBe(world.tenant.id);
      expect(headers.get('content-type')).toBe('application/json');
      expect(options.credentials).toBe('same-origin');
      const path = `${url.pathname.slice(TC_BASE.length)}${url.search}`;
      const method = options.method ?? 'GET';
      const body = options.body === undefined ? undefined : (JSON.parse(String(options.body)) as unknown);
      const response = await operator.request(method, path, {
        body,
        ifMatch: headers.get('if-match') ?? undefined,
        idempotencyKey: headers.get('idempotency-key') ?? undefined,
        headers: { origin: 'http://localhost' },
      });
      calls.push({ method, path, body, status: response.status, result: await response.clone().json() });
      return response;
    }),
  );
  return calls;
}

async function settleUntil(condition: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!condition() && Date.now() < deadline) {
    await act(async () => new Promise((done) => setTimeout(done, 5)));
  }
  expect(condition(), host.textContent ?? '未渲染').toBe(true);
}

async function renderPanel(module: string) {
  const components = (await import(resolve(`apps/web/src/talent/${module}.tsx`))) as Record<string, unknown>;
  await act(async () => root.render(createElement(components[module], { tenantId: world.tenant.id })));
}

async function click(label: string, within: Element = host) {
  const button = Array.from(within.querySelectorAll<HTMLButtonElement>('button')).find(
    (item) => item.textContent === label,
  );
  expect(button).toBeTruthy();
  expect(button!.disabled).toBe(false);
  await act(async () => button!.click());
}

function nameInput() {
  const label = Array.from(host.querySelectorAll('form label')).find((item) => item.firstChild?.textContent === '名称');
  return label?.querySelector<HTMLInputElement>('input');
}

async function enter(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype =
      control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, value);
    control.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function grantCurrentFields(
  operator: Awaited<ReturnType<typeof talentOperator>>,
  object: 'dimensionCategory' | 'dimension',
) {
  const definition = TALENT_OBJECTS[object];
  const response = await setObjectPermission(
    world,
    operator.profile,
    {
      dataOperations: { create: true, update: true, delete: true },
      fields: definition.fields.map((field) => ({ fieldCode: field.code, view: true, edit: !field.system })),
      buttons: definition.buttons.map((button) => ({ buttonCode: button.code, level: button.level })),
    },
    definition.code,
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

async function adminRead<T>(path: string): Promise<T> {
  const response = await data.setup.request('GET', `${TC_BASE}${path}`, world.asAdmin);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as T;
}

async function saveAndRead<T>(calls: ApiCall[], path: string): Promise<T> {
  await act(async () =>
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  await settleUntil(() => calls.some((call) => call.method === 'PATCH' && call.path === path));
  const write = calls.find((call) => call.method === 'PATCH' && call.path === path)!;
  expect(write.status, JSON.stringify(write.result)).toBe(200);
  await settleUntil(() => !host.querySelector('form'));
  return adminRead<T>(path);
}

it('AC-TC-F035 旧列表隐藏顺序，授权后只改分类名称，真实库内顺序 7 保持不变', async () => {
  const path = `/dimension-categories/${data.inside.dimensionCategory.id}`;
  const initial = await adminRead<DimensionCategoryView>(path);
  const prepared = await data.setup.request('PATCH', `${TC_BASE}${path}`, {
    ...world.asAdmin,
    ifMatch: initial.revision,
    body: { displayOrder: 7 },
  });
  expect(prepared.status, await prepared.clone().text()).toBe(200);
  const operator = await talentOperator(world, {
    mouId: data.mouId,
    hidden: { dimensionCategory: ['displayOrder'] },
  });
  const calls = forwardPanelRequests(operator);
  await renderPanel('DimensionCategoryPanel');
  await settleUntil(() => host.textContent?.includes(initial.name) === true);
  const oldList = calls.find((call) => call.method === 'GET' && call.path.startsWith('/dimension-categories?'))!;
  const listed = (oldList.result.items as Record<string, unknown>[]).find((item) => item.id === initial.id)!;
  expect(listed).not.toHaveProperty('displayOrder');
  await grantCurrentFields(operator, 'dimensionCategory');
  await click('编辑');
  await settleUntil(() => !!nameInput() && !host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled);
  await enter(nameInput()!, '重新授权后改分类名称');
  const saved = await saveAndRead<DimensionCategoryView>(calls, path);
  expect(saved.name).toBe('重新授权后改分类名称');
  expect(saved.displayOrder).toBe(7);
});

it('AC-TC-F035 旧列表隐藏等级明细，授权后新增等级行，真实库内原等级行仍保留', async () => {
  const path = `/dimensions/${data.inside.dimension.id}`;
  const before = await adminRead<DimensionView>(path);
  expect(before.grades).toHaveLength(1);
  const operator = await talentOperator(world, { mouId: data.mouId, hidden: { dimension: ['grades'] } });
  const calls = forwardPanelRequests(operator);
  await renderPanel('DimensionPanel');
  await settleUntil(() => host.textContent?.includes(before.name) === true);
  const oldList = calls.find((call) => call.method === 'GET' && call.path.startsWith('/dimensions?'))!;
  const listed = (oldList.result.items as Record<string, unknown>[]).find((item) => item.id === before.id)!;
  expect(listed).not.toHaveProperty('grades');
  await grantCurrentFields(operator, 'dimension');
  await click('编辑');
  await settleUntil(() => !!nameInput() && !host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled);
  const grades = Array.from(host.querySelectorAll('form fieldset')).find(
    (fieldset) => fieldset.querySelector(':scope > legend')?.textContent === '等级描述',
  )!;
  expect(grades).toBeTruthy();
  await click('添加一行', grades);
  const rows = grades.querySelectorAll('tbody tr');
  const added = rows[rows.length - 1]!;
  await enter(added.querySelector<HTMLInputElement>('input[aria-label="等级顺序"]')!, '2');
  await enter(added.querySelector<HTMLInputElement>('input[aria-label="别称"]')!, '新增');
  await enter(added.querySelector<HTMLTextAreaElement>('textarea[aria-label="说明"]')!, '新增等级说明');
  const saved = await saveAndRead<DimensionView>(calls, path);
  expect(saved.grades).toEqual([...before.grades, { gradeOrder: 2, alias: '新增', description: '新增等级说明' }]);
});
