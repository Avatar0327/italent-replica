/// <reference lib="dom" />
import { useTestDb } from '@italent/testkit';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import {
  BASE,
  seedPermissionWorld,
  createProfile,
  type PermissionWorld,
  type ProfileBody,
} from '../../../../tests/acceptance/AC-PRM-support.js';
import { uniqueSuffix } from '../../../../tests/acceptance/support/unique.js';
import { act, h, uiHarness } from '../../../../tests/acceptance/support/f474-ui.js';
import { ProfilesPage } from './ProfilesPage.js';
const database = useTestDb();
let world: PermissionWorld;
let profile: ProfileBody;
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
    'getComputedStyle',
    'ResizeObserver',
  ] as const)
    vi.stubGlobal(key, key === 'window' ? browser : browser[key]);
});
beforeAll(async () => {
  world = await seedPermissionWorld(database().db);
  profile = await createProfile(world, `PGP-UI-${uniqueSuffix()}`, { apps: ['Qualification'] });
});
async function wait(check: () => void) {
  await vi.waitFor(
    async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      check();
    },
    { timeout: 10000 },
  );
}
async function click(text: string, selector = 'button') {
  let target: HTMLElement | undefined;
  await wait(() => {
    target = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
      (b) => b.textContent?.replace(/\s/g, '') === text,
    );
    expect(target).toBeDefined();
  });
  await act(() => target!.click());
}
describe('AC-PGP-F474-05、06 前端经真实后端保存', () => {
  it('身份列表正常入口 → 新增 → 菜单显示载体 → 删除 → 页面清空', async () => {
    const path = `${BASE}/profiles/${profile.id}`;
    const detail = await (await world.api.request('GET', path, world.asAdmin)).json();
    ui = uiHarness();
    await ui.render(h(ProfilesPage, { title: '身份管理', editable: true }), '/', undefined, {
      [`${BASE}/profiles`]: { items: [detail], total: 1 },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((raw: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const url = new URL(raw, 'http://localhost');
        return world.api.request(init?.method ?? 'GET', url.pathname + url.search, {
          ...world.asAdmin,
          ifMatch: headers.get('if-match') ?? undefined,
          idempotencyKey: headers.get('idempotency-key') ?? undefined,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
      }),
    );
    await click(detail.name);
    await click('页面权限', '[role="tab"]');
    await click('新增');
    await wait(() => expect(document.querySelector('.ant-modal input[type="checkbox"]')).not.toBeNull());
    await act(() => document.querySelector<HTMLInputElement>('.ant-modal input[type="checkbox"]')!.click());
    await click('确定');
    await wait(() => expect(document.querySelector('.ant-modal')).toBeNull());
    await wait(() => expect(ui!.host.textContent).toContain('已授予'));
    await click('菜单组', '[role="tab"]');
    expect(ui.host.textContent).toContain('Qualification.Pages');
    await click('页面权限', '[role="tab"]');
    await click('删除');
    await click('确定');
    await wait(() => expect(document.querySelector('.ant-modal')).toBeNull());
    await wait(() => expect(ui!.host.textContent).toContain('暂无已授予页面'));
    const saved = await (await world.api.request('GET', path, world.asAdmin)).json();
    expect(saved.revision).toBe(detail.revision + 2);
    expect(saved.objects).toMatchObject([{ objectCode: 'Qualification.Pages', buttons: [] }]);
  });
});
