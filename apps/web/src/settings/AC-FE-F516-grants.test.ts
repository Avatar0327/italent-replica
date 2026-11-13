/// <reference lib="dom" />
// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { h, uiHarness } from '../../../../tests/acceptance/support/f474-ui.js';
import { GrantsPage } from './GrantsPage.js';
let ui: ReturnType<typeof uiHarness>;
beforeEach(() => {
  ui = uiHarness();
});
afterEach(async () => ui.close());
it('AC-FE-F516 用户授权手机号列读取真实投影，空值保持空', async () => {
  await ui.render(
    h(GrantsPage, { code: 'permission.user_grant', title: '用户授权', editable: false, canScope: false }),
    '/',
    undefined,
    {
      '/api/tenant/permission/grants': {
        items: [
          { id: 'grant', userId: 'user', userName: '合成授权人', phone: '13000000009', mous: [], apps: [] },
          { id: 'empty', userId: 'external', userName: '合成外部人', phone: null, mous: [], apps: [] },
        ],
        total: 2,
      },
    },
  );
  expect(ui.host.querySelector('tbody')!.textContent).toContain('13000000009');
  const rows = ui.host.querySelectorAll('tbody .ant-table-row');
  expect(rows[1]!.querySelectorAll('td')[3]!.textContent).toBe('—');
});
