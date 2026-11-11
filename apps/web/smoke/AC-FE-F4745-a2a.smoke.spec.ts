import { test, expect, snapshotFixture } from './fixtures.js';
import { settingsFixtures, rows, ids, menus } from './settings-fixtures.js';

test.use({ viewport: { width: 1440, height: 900 } });
const cases = [
  {
    code: 'users.all',
    resource: 'users',
    title: '全部用户',
    field: '姓名 / 登录邮箱',
    query: 'q',
    row: {
      ...rows.user,
      contactEmail: 'contact@example.com',
      accountStatus: 'active',
      createdAt: '2026-11-10T23:30:00Z',
    },
  },
  {
    code: 'permission.user_grant',
    resource: 'grants',
    title: '用户授权',
    field: '姓名 / 邮箱',
    query: 'q',
    row: {
      ...rows.grant,
      userName: '合成用户甲',
      userEmail: 'grant@example.com',
      profileName: '合成人事身份',
      apps: ['TenantBase'],
      mous: [{ mouId: ids.mou, name: '合成范围', appCode: 'TenantBase' }],
    },
  },
  {
    code: 'permission.admins',
    resource: 'admins',
    title: '管理员',
    field: '姓名 / 邮箱',
    query: 'q',
    row: {
      id: ids.grant,
      userId: ids.user,
      displayName: '合成管理员',
      email: 'admin@example.com',
      role: 'tenant_admin',
      mous: [],
      createdBy: null,
      createdAt: '2026-11-10T23:30:00Z',
    },
  },
  {
    code: 'permission.profiles',
    resource: 'profiles',
    title: '身份管理',
    field: '名称',
    query: 'name',
    row: { ...rows.profile, updatedBy: null, updatedAt: '2026-11-10T23:30:00Z', grantCount: 8 },
  },
];
for (const item of cases) {
  test(`AC-FE-F4745-A2a ${item.title} 查询、分页、空值、失败与返回刷新`, async ({ page }, info) => {
    await settingsFixtures(page, false);
    await page.route('**/permission/me/snapshot', (route) =>
      route.fulfill({
        json: {
          ...snapshotFixture,
          adminMenus: [...menus, ['permission.admins', '管理员']].map(([code, path]) => ({
            code,
            path,
            editable: false,
            implemented: true,
          })),
        },
      }),
    );
    const queries: URLSearchParams[] = [];
    const writes: string[] = [];
    let failed = false;
    page.on('request', (request) => {
      if (request.method() !== 'GET') writes.push(request.method());
    });
    await page.route(`**/permission/${item.resource}?*`, (route) => {
      const query = new URL(route.request().url()).searchParams;
      queries.push(query);
      return failed
        ? route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN', message: '无权访问' } } })
        : route.fulfill({
            json: {
              items: query.get(item.query) === '空集' ? [] : [item.row],
              total: query.get(item.query) === '空集' ? 0 : 31,
            },
          });
    });
    await page.goto(`/settings/menu/${item.code}`);
    await expect(page.getByRole('heading', { name: item.title, exact: true })).toBeVisible();
    await expect(page.locator('.page-total')).toContainText('31');
    await page.locator('.ant-pagination-next button').click();
    await expect.poll(() => queries.at(-1)?.get('offset')).toBe('15');
    await expect(page.locator('tbody .ant-table-row')).toHaveCount(1);
    const input = page.getByRole('textbox', { name: item.field, exact: true });
    await input.fill('合成%_\\');
    await page.getByRole('button', { name: /^查\s*询$/ }).click();
    await expect.poll(() => queries.at(-1)?.get(item.query)).toBe('合成%_\\');
    expect(queries.at(-1)?.get('offset')).toBe('0');
    await input.fill('空集');
    await page.getByRole('button', { name: /^查\s*询$/ }).click();
    await expect(page.locator('.page-total')).toContainText('0');
    await expect(page.locator('tbody .ant-table-row')).toHaveCount(0);
    await page.getByRole('button', { name: /^清\s*空$/ }).click();
    await expect.poll(() => queries.at(-1)?.has(item.query)).toBe(false);
    await expect(input).toHaveValue('');
    failed = true;
    await page.getByRole('button', { name: /^刷\s*新$/ }).click();
    await expect(page.locator('.list-card [role="alert"]')).toBeVisible();
    failed = false;
    await page.locator('.list-card').getByRole('button', { name: '重新加载', exact: true }).click();
    await expect(page.locator('tbody .ant-table-row')).toHaveCount(1);
    await page.screenshot({ path: info.outputPath(`${item.resource}.png`), fullPage: true });
    expect(writes).toEqual([]);
  });
}
