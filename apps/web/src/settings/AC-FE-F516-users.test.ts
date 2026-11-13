/// <reference lib="dom" />
// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, h, uiHarness } from '../../../../tests/acceptance/support/f474-ui.js';
import { UsersPage } from './UsersPage.js';
let ui: ReturnType<typeof uiHarness>;
beforeEach(() => {
  ui = uiHarness();
});
afterEach(async () => ui.close());
const path = '/api/tenant/permission/users';
const props = { code: 'users.all', title: '全部用户', editable: false };
it('AC-FE-F516 全部用户展示档案手机号与原名员工状态，默认启用', async () => {
  await ui.render(h(UsersPage, props), '/', undefined, {
    [path]: {
      items: ['pending', 'employed', 'left', 'retired'].map((employeeStatus, i) => ({
        userId: `person-${i}`,
        displayName: `合成人员${i}`,
        contactPhone: `1300000000${i}`,
        employeeStatus,
        membershipStatus: 'revoked',
        accountStatus: 'active',
      })),
      total: 4,
    },
  });
  const body = ui.host.querySelector('tbody')!.textContent;
  for (const text of ['13000000000', '待入职', '在职', '离职', '退休']) expect(body).toContain(text);
  expect(body).not.toContain('待确认');
  const urls = vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url), 'http://localhost'));
  expect(urls.find((url) => url.pathname === path)!.searchParams.get('accountStatus')).toBe('active');
});
it('AC-FE-F516 联系邮箱独立条件，清空后恢复启用默认值', async () => {
  await ui.render(h(UsersPage, props));
  const input = ui.host.querySelector<HTMLInputElement>('input[aria-label="联系邮箱"]');
  expect(input).not.toBeNull();
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Zhang');
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    input!.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => {
    ui.host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true }));
  });
  const queries = () =>
    vi
      .mocked(fetch)
      .mock.calls.map(([url]) => new URL(String(url), 'http://localhost'))
      .filter((url) => url.pathname === path);
  expect(queries().at(-1)!.searchParams.get('contactEmail')).toBe('Zhang');
  expect(queries().at(-1)!.searchParams.has('q')).toBe(false);
  const clear = Array.from(ui.host.querySelectorAll('button')).find(
    (button) => button.textContent?.replaceAll(' ', '') === '清空',
  );
  await act(async () => clear!.click());
  expect(queries().at(-1)!.searchParams.get('accountStatus')).toBe('active');
  expect(queries().at(-1)!.searchParams.has('contactEmail')).toBe(false);
});
