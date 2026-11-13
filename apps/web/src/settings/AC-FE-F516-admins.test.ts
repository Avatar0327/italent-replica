/// <reference lib="dom" />
// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { h, uiHarness } from '../../../../tests/acceptance/support/f474-ui.js';
import { AdminsPage } from './AdminsPage.js';
let ui: ReturnType<typeof uiHarness>;
beforeEach(() => {
  ui = uiHarness();
});
afterEach(async () => ui.close());
it('AC-FE-F516 管理员显示主职部门，并从现有范围裁剪组织树读取筛选候选', async () => {
  await ui.render(h(AdminsPage, { code: 'permission.admins', title: '管理员', editable: false }), '/', undefined, {
    '/api/tenant/permission/admins': {
      items: [
        {
          id: 'admin',
          userId: 'user',
          displayName: '合成管理员',
          department: { id: 'org', name: '合成主职部门' },
          mous: [],
          role: 'audit_admin',
        },
      ],
      total: 1,
    },
    '/api/tenant/org/organizations/tree': {
      roots: [{ id: 'org', name: '合成主职部门', children: [] }],
      total: 1,
      hasDataPermission: true,
    },
  });
  expect(ui.host.querySelector('tbody')!.textContent).toContain('合成主职部门');
  expect(ui.host.querySelector('input[aria-label="部门"]')).not.toBeNull();
  const urls = vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url), 'http://localhost'));
  expect(urls.find((url) => url.pathname.endsWith('/organizations/tree'))!.searchParams.get('dimension')).toBe('admin');
});
