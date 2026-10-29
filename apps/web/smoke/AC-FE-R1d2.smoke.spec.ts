import { actionButton } from './action-button.js';
import { test, expect, snapshotFixture, user } from './fixtures.js';

import { menus, settingsFixtures } from './settings-fixtures.js';

test.use({ viewport: { width: 1440, height: 900 } });

for (const failure of ['network', '503'] as const) {
  test(`AC-FE-F114 企业设置快照 ${failure} 失败可重试，不提前读取业务列表`, async ({ page }) => {
    await settingsFixtures(page, false);
    const calls: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/tenant/')) calls.push(path);
    });
    let failed = true;
    await page.route('**/permission/me/snapshot', (route) => {
      if (!failed) return route.fallback();
      if (failure === 'network') return route.abort();
      return route.fulfill({ status: 503, json: { error: { code: 'FAILED' } } });
    });
    await page.goto('/settings/menu/users.all');
    await expect(page.getByRole('alert')).toContainText('加载失败');
    await expect(page.locator('.shell-sidebar [role="menuitem"]')).toHaveCount(0);
    await expect(page.locator('.settings-navigation')).toHaveCount(0);
    expect(calls).toEqual(['/api/tenant/permission/me/snapshot']);
    failed = false;
    await page.getByRole('button', { name: '重新加载', exact: true }).click();
    await expect(page.getByRole('heading', { name: '全部用户', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^新\s*增$/ })).toHaveCount(0);
    await expect(page.locator('.settings-navigation')).toContainText('当前用户权限');
    expect(calls.filter((path) => path.endsWith('/me/snapshot'))).toHaveLength(2);
    expect(calls.some((path) => path.includes('/me/objects/') || path.endsWith('/admin-menus'))).toBe(false);
  });
}

for (const [code, title] of menus) {
  test(`AC-FE-R1d2 ${title} 切换身份后列表、抽屉与注释可用`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await settingsFixtures(page);
    await page.goto(`/settings/menu/${code}`);
    await page.getByLabel('切换演示身份').selectOption(user);
    await page.waitForURL('**/staff');
    await page.goto(`/settings/menu/${code}`);
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(page.locator('.ant-table')).toBeVisible();
    if (code === 'users.internal') await page.screenshot({ path: '/tmp/fe-r1d2-users.png', fullPage: true });
    await page.locator('.ant-table-tbody .ant-btn-link').first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    const create = page.getByRole('button', { name: /^新\s*增$/ });
    if (!['users.internal', 'audit.business'].includes(code!)) {
      await create.click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.getByRole('button', { name: /^取\s*消$/ }).click();
    }
    await page.getByRole('switch', { name: '注释' }).click();
    await expect(page.getByText('DEC-043', { exact: true }).first()).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('AC-FE-R1d2 只读菜单隐藏写按钮，缺失菜单直达拒绝', async ({ page }) => {
  await settingsFixtures(page, false);
  await page.goto('/settings/menu/users.all');
  await expect(page.getByRole('heading', { name: '全部用户', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^新\s*增$/ })).toHaveCount(0);
  await page.goto('/settings/menu/permission.mous');
  await expect(page.getByRole('tab', { name: '数据范围', exact: true })).toHaveCount(0);
  await page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        adminMenus: [{ code: 'users.all', path: '全部用户', editable: false }],
      },
    }),
  );
  await page.goto('/settings/menu/permission.profiles');
  await expect(page.getByText('暂无访问权限', { exact: true })).toBeVisible();
});

test('AC-FE-R1d2 新用户校验后保存，409 不盲重试', async ({ page }) => {
  await settingsFixtures(page);
  const writes: { body: unknown; headers: Record<string, string> }[] = [];
  await page.route('**/permission/users', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    writes.push({ body: route.request().postDataJSON(), headers: route.request().headers() });
    return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT' } } });
  });
  await page.goto('/settings/menu/users.external');
  await page.getByRole('button', { name: /^新\s*增$/ }).click();
  const dialog = page.getByRole('dialog');
  await actionButton(dialog, '保存').click();
  await expect(dialog.getByText('请填写此项').first()).toBeVisible();
  expect(writes).toHaveLength(0);
  await dialog.getByLabel('姓名', { exact: true }).fill('合成用户乙');
  await dialog.getByLabel('联系邮箱').fill('user-b@example.com');
  await dialog.getByLabel('业务身份').fill('顾问');
  await actionButton(dialog, '保存').click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]!.body).toEqual({
    displayName: '合成用户乙',
    email: 'user-b@example.com',
    businessIdentity: '顾问',
    userType: 'external',
  });
  expect(writes[0]!.headers['idempotency-key']).toBeTruthy();
});

test('AC-PRM-03/14 共享范围从空值读取，保存携带当前 revision', async ({ page }) => {
  await settingsFixtures(page);
  const writes: { body: unknown; revision?: string }[] = [];
  await page.route('**/permission/scopes/**', (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    writes.push({ body: route.request().postDataJSON(), revision: route.request().headers()['if-match'] });
    return route.fulfill({ json: { revision: 7 } });
  });
  await page.goto('/settings/menu/permission.mous');
  await page.getByRole('tab', { name: '数据范围', exact: true }).click();
  await page.getByRole('textbox', { name: '用户编号', exact: true }).fill(user);
  await page.getByRole('textbox', { name: '应用编码', exact: true }).fill('TenantBase');
  await page.getByRole('button', { name: '查询数据范围', exact: true }).click();
  await expect(page.getByText('默认管理单元（空范围）', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^编\s*辑$/ }).click();
  await actionButton(page.getByRole('dialog'), '保存').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(writes).toEqual([{ body: { kind: 'default' }, revision: '6' }]);
});

test('AC-AUD-01/02 审计游标翻页、详情和筛选重置', async ({ page }) => {
  await settingsFixtures(page);
  const { ids, rows } = await import('./settings-fixtures.js');
  const queries: URLSearchParams[] = [];
  await page.route('**/audit/data-changes?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    queries.push(query);
    return route.fulfill({
      json: {
        items: [{ ...rows.audit, objectId: query.has('cursor') ? '第二页' : '第一页' }],
        nextCursor: query.has('cursor') ? null : ids.audit,
        window: { from: '2026-07-13', to: '2026-10-13' },
      },
    });
  });
  await page.goto('/settings/menu/audit.business');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.getByRole('button', { name: '第二页', exact: true })).toBeVisible();
  expect(queries.at(-1)!.get('cursor')).toBe(ids.audit);
  await page.getByRole('button', { name: '高级筛选', exact: true }).click();
  await page.getByRole('dialog').getByLabel('对象', { exact: true }).fill('employee');
  await page.getByRole('button', { name: /^确\s*定$/ }).click();
  await expect(page.getByRole('button', { name: '第一页', exact: true })).toBeVisible();
  expect(queries.at(-1)!.get('objectType')).toBe('employee');
  expect(queries.at(-1)!.has('cursor')).toBe(false);
});
