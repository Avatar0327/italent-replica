/// <reference lib="dom" />
import { useTestDb } from '@italent/testkit';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import {
  BASE,
  DEMO_OBJECT,
  seedPermissionWorld,
  createProfile,
  setObjectPermission,
  addMember,
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
  ] as const) {
    vi.stubGlobal(key, key === 'window' ? browser : browser[key]);
  }
});

beforeAll(async () => {
  world = await seedPermissionWorld(database().db);
  profile = await createProfile(world, `A2B_${uniqueSuffix()}`);
  expect(
    (
      await setObjectPermission(world, profile, {
        dataOperations: { create: true, update: false, delete: false },
        fields: [{ fieldCode: 'CreatedBy', view: true, edit: false }],
        buttons: [{ buttonCode: 'EmploymentRecord.Print', level: 'detail' }],
      })
    ).status,
  ).toBe(200);
});
const path = () => `${BASE}/profiles/${profile.id}`;
const object = () => `${path()}/objects/${DEMO_OBJECT.code}`;
async function click(text: string) {
  let button: HTMLButtonElement | undefined;
  await wait(() => {
    button = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.replace(/\s/g, '') === text,
    );
    expect(button).toBeDefined();
  });
  await act(() => button!.click());
}
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
describe('AC-FE-F4745-A2b 真实 HTTP 权限弹窗', () => {
  it('列表正常入口、GET 当前值、PUT 数据和字段，其他权限保持并能重新读取', async () => {
    const detail = await (await world.api.request('GET', path(), world.asAdmin)).json();
    ui = uiHarness();
    await ui.render(h(ProfilesPage, { title: '身份管理', editable: true }), '/', undefined, {
      [`${BASE}/profiles`]: { items: [detail], total: 1 },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((raw: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        return world.api.request(
          init?.method ?? 'GET',
          new URL(raw, 'http://localhost').pathname + new URL(raw, 'http://localhost').search,
          {
            ...world.asAdmin,
            ifMatch: headers.get('if-match') ?? undefined,
            idempotencyKey: headers.get('idempotency-key') ?? undefined,
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
          },
        );
      }),
    );
    await click(detail.name);
    await wait(() => expect(ui!.headers()).toContain('最新修改时间'));
    await click('数据操作权限');
    await wait(() =>
      expect(document.querySelector<HTMLInputElement>('input[aria-label="新增 开启"]')?.checked).toBe(true),
    );
    await act(() => document.querySelector<HTMLInputElement>('input[aria-label="编辑 开启"]')!.click());
    await click('确定');
    await wait(() => expect(document.querySelector('.ant-modal')).toBeNull());
    await wait(() => expect(ui!.host.querySelector('tbody')?.textContent).toContain(DEMO_OBJECT.code));
    await click('字段权限');
    await wait(() =>
      expect(document.querySelector<HTMLInputElement>('input[aria-label="CreatedBy 编辑"]')?.disabled).toBe(true),
    );
    await act(() => document.querySelector<HTMLInputElement>('input[aria-label="Name 查看"]')!.click());
    await click('确定');
    await wait(() => expect(document.querySelector('.ant-modal')).toBeNull());
    const saved = await (await world.api.request('GET', path(), world.asAdmin)).json();
    expect(saved.revision).toBe(profile.revision + 2);
    expect(saved.objects[0]).toMatchObject({
      dataOperations: { create: true, update: true, delete: false },
      buttons: [{ buttonCode: 'EmploymentRecord.Print', level: 'detail' }],
    });
    expect(saved.objects[0].fields).toEqual(
      expect.arrayContaining([
        { fieldCode: 'Name', view: true, edit: false },
        { fieldCode: 'CreatedBy', view: true, edit: false },
      ]),
    );
  });
  it('无管理员查看权时两种弹窗的 GET/PUT 均返回 403', async () => {
    const member = await addMember(world, '合成普通成员');
    for (const mode of ['data-operations', 'fields'])
      for (const method of ['GET', 'PUT']) {
        const response = await world.api.request(method, `${object()}/${mode}`, {
          tenant: world.tenant.id,
          user: member.id,
          ifMatch: profile.revision,
          body: method === 'PUT' ? {} : undefined,
        });
        expect(response.status).toBe(403);
      }
  });
});
