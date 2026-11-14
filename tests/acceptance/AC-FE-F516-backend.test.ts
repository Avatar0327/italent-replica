/// <reference lib="dom" />
import { resolve } from 'node:path';
import { createTestDb } from '@italent/testkit';
import { afterEach, afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import {
  BASE,
  seedPermissionWorld,
  addMember,
  createProfile,
  makeGrantable,
  grant,
  type PermissionWorld,
} from './AC-PRM-support.js';
import { uniqueSuffix } from './support/unique.js';
import { act, h, uiHarness } from './support/f474-ui.js';
const { GrantsPage } = await import(resolve('apps/web/src/settings/GrantsPage.tsx'));
let handle: Awaited<ReturnType<typeof createTestDb>>;
// 本机多工作树并行时完整迁移可能超过 60 秒，与 F-039 重型建库钩子使用同一等待预算。
beforeAll(async () => {
  handle = await createTestDb();
}, 300_000);
afterAll(async () => {
  await handle?.close();
});
const database = () => handle;

let ui: ReturnType<typeof uiHarness> | undefined;
afterEach(async () => {
  await ui?.close();
  ui = undefined;
});
beforeEach(() => {
  const browser = new Window();
  for (const key of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLInputElement',
    'SVGElement',
    'Element',
    'ShadowRoot',
    'Node',
    'MouseEvent',
    'getComputedStyle',
    'ResizeObserver',
  ] as const) {
    vi.stubGlobal(key, key === 'window' ? browser : browser[key]);
  }
});

let world: PermissionWorld;
const profileIds: string[] = [];
const mouIds: string[] = [];
const users: string[] = [];
beforeAll(async () => {
  world = await seedPermissionWorld(database().db);
  for (let index = 0; index < 3; index++) {
    const member = await addMember(world, `筛选读者${index}`);
    users.push(member.id);
    const profile = await createProfile(world, `F516-${uniqueSuffix()}`);
    profileIds.push(profile.id);
    const mou = await world.api.request('POST', `${BASE}/mous`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { code: `F516-${uniqueSuffix()}`, name: `候选单元${index}`, orgRanges: [] },
    });
    expect(mou.status).toBe(201);
    mouIds.push(((await mou.json()) as { id: string }).id);
    expect(
      (
        await world.api.request('PUT', `${BASE}/scopes/${member.id}/TenantBase`, {
          ...world.asAdmin,
          ifMatch: 0,
          body: { kind: 'mou', mouId: mouIds[index] },
        })
      ).status,
    ).toBe(200);
  }
  await makeGrantable(world, profileIds);
  for (let index = 0; index < 3; index++)
    expect((await grant(world, users[index]!, profileIds[index]!)).status).toBe(201);
});

it('AC-FE-F516 真实候选响应多选后请求真实列表，返回两条授权和同口径 total', async () => {
  ui = uiHarness();
  const responses: Record<string, unknown> = {};
  for (const resource of ['grants', 'grants/profile-candidates', 'grants/mou-candidates']) {
    const response = await world.api.request('GET', `${BASE}/${resource}`, world.asAdmin);
    expect(response.status).toBe(200);
    responses[`${BASE}/${resource}`] = await response.json();
  }
  await ui.render(h(GrantsPage, { title: '用户授权', editable: false, canScope: false }), '/', undefined, responses);
  expect(ui.host.querySelectorAll('tbody .ant-table-row')).toHaveLength(3);
  const fallback = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (raw, options) => {
    const url = new URL(String(raw), 'http://localhost');
    if (url.pathname.startsWith(`${BASE}/grants`))
      return world.api.request('GET', `${url.pathname}${url.search}`, world.asAdmin);
    return fallback(raw, options);
  });
  const input = ui.host.querySelector('input[aria-label="管理单元"]')!;
  await act(async () => {
    input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  for (let index = 0; index < 2; index++) {
    const option = Array.from(document.querySelectorAll<HTMLElement>('.ant-select-item-option')).find(
      (node) => node.textContent === `候选单元${index}`,
    )!;
    expect(option).toBeDefined();
    await act(async () => {
      option.click();
    });
  }
  const submit = ui.host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  await act(async () => {
    submit.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  const query = vi
    .mocked(fetch)
    .mock.calls.map(([raw]) => new URL(String(raw), 'http://localhost'))
    .find((url) => url.searchParams.getAll('mouId').length === 2)!;
  expect(query.searchParams.getAll('mouId')).toEqual(mouIds.slice(0, 2));
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(ui!.host.querySelectorAll('tbody .ant-table-row')).toHaveLength(2);
  });
  expect(ui.host.querySelector('.page-total')?.textContent).toContain('2');
  expect(ui.host.textContent).toContain('筛选读者0');
  expect(ui.host.textContent).toContain('筛选读者1');
});
