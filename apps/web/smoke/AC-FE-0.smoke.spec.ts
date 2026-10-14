import { test, expect, tenant, user, snapshotFixture } from './fixtures.js';
import { APP_ROUTES } from './page-registry.js';

test('AC-FE-0-04 通过现有演示身份选择器进入应用，注释可切换', async ({ page }) => {
  await page.goto('/staff');
  await page.getByLabel('切换演示身份').selectOption(user);
  await expect(page.getByRole('heading', { name: '员工', exact: true })).toBeVisible();
  await expect(page.locator('.ant-pagination-options')).toContainText('条/页');
  expect((await page.context().cookies()).find((cookie) => cookie.name === 'italent_demo_tenant')?.value).toBe(tenant);
  await expect(page.locator('.shell-content > .decision-note').getByText('DEC-456', { exact: true })).toHaveCount(0);
  await page.getByRole('switch', { name: '注释' }).click();
  await expect(page.locator('.shell-content > .decision-note').getByText('DEC-456', { exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: '人才盘点', exact: true }).click();
  await expect(page).toHaveURL(/\/talent-review$/);
  await expect(page.locator('.shell-content > .decision-note').getByText('DEC-456', { exact: true })).toBeVisible();
});

for (const app of APP_ROUTES) {
  test(`AC-FE-0-05 ${app.path} 应用首页无运行时错误`, async ({ page, baseURL }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.context().addCookies([
      { name: 'italent_demo_tenant', value: tenant, url: baseURL! },
      { name: 'italent_demo_user', value: user, url: baseURL! },
    ]);
    await page.goto(app.path);
    await expect(page.locator('.shell-workspace h1').first()).toBeVisible();
    await expect(page.getByRole('button', { name: '应用导航' })).toBeVisible();
    await expect(page.locator('.app-switch')).toContainText(app.label);
    await expect(page.locator('.shell-workspace')).not.toContainText('正在加载');
    expect(errors).toEqual([]);
  });
}

test('AC-FE-0-06 旧路径保留参数与锚点，无权限页和未知页面均可恢复', async ({ page, baseURL }) => {
  await page.context().addCookies([
    { name: 'italent_demo_tenant', value: tenant, url: baseURL! },
    { name: 'italent_demo_user', value: user, url: baseURL! },
  ]);
  await page.goto('/jobs?page=2#list');
  await expect(page).toHaveURL(/\/job\?page=2#list$/);
  await page.goto('/account');
  await expect(page).toHaveURL(/\/settings\/account$/);
  await page.route('**/permission/me/objects/TenantBase.Organization*', (route) =>
    route.fulfill({
      status: 403,
      json: { error: { code: 'FORBIDDEN' } },
    }),
  );
  await page.route('**/permission/me/snapshot', async (route) => {
    const body = structuredClone(snapshotFixture);
    body.apps = body.apps.map((app) => (app.app === 'org' ? { ...app, visible: false, entryObjects: [] } : app));
    await route.fulfill({ json: body });
  });
  let snapshots = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/permission/me/snapshot')) snapshots += 1;
  });
  await page.goto('/org');
  await expect(page.getByText('暂无访问权限', { exact: true })).toBeVisible();
  // 原站整页无权限在提示下给“刷新页面”，点击重新获取权限（#326 第 2 轮 P2-7）
  const before = snapshots;
  await page.getByRole('button', { name: '刷新页面' }).click();
  await expect.poll(() => snapshots).toBeGreaterThan(before);
  await page.goto('/not-a-page');
  await expect(page.getByRole('status').getByText('页面或记录不存在', { exact: true })).toBeVisible();
});

for (const path of ['/job', '/jobs?page=2#list']) {
  test(`AC-FE-0-07 只有职位权限仍能经 ${path} 进入职务体系`, async ({ page, baseURL }) => {
    await page.context().addCookies([
      { name: 'italent_demo_tenant', value: tenant, url: baseURL! },
      { name: 'italent_demo_user', value: user, url: baseURL! },
    ]);
    await page.route('**/permission/me/snapshot', (route) =>
      route.fulfill({
        json: {
          ...snapshotFixture,
          adminMenus: [],
          apps: [{ app: 'job', visible: true, entryObjects: ['TenantBase.Position'] }],
        },
      }),
    );
    await page.route('**/permission/me/objects/*', (route) => {
      if (route.request().url().endsWith('/TenantBase.Position'))
        return route.fulfill({
          json: {
            objectCode: 'TenantBase.Position',
            dataOperations: {},
            viewableFields: ['name'],
            editableFields: [],
            buttons: [],
          },
        });
      return route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN' } } });
    });
    await page.route('**/job/positions?*', (route) =>
      route.fulfill({
        json: {
          items: [{ id: 'position-example', name: '职位单权示例', revision: 1 }],
          page: 1,
          pageSize: 50,
          hasDataPermission: true,
          today: '2026-10-01',
        },
      }),
    );
    await page.goto(path);
    await expect(page.getByRole('menuitem', { name: '职务体系', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '职位', exact: true })).toBeVisible();
    await expect(page.locator('.shell-workspace')).not.toContainText('暂无访问权限');
    await expect(page.getByText('职位单权示例', { exact: true })).toBeVisible();
    if (path.startsWith('/jobs')) await expect(page).toHaveURL(/\/job\?page=2#list$/);
  });
}

test('AC-FE-0-09 无面包屑、视图标题、紧凑主题与可收起侧栏对齐原站', async ({ page }) => {
  await page.goto('/staff');
  await page.getByLabel('切换演示身份').selectOption(user);
  await expect(page.locator('.shell-workspace h1')).toBeVisible();
  await expect(page.locator('.ant-breadcrumb')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '切换视图' })).toContainText('员工');
  await expect(page.locator('.page-view-icon')).toBeVisible();
  await expect(page.locator('.ant-pagination-options')).toContainText('15条/页');
  await expect(page.locator('.shell-header')).toHaveCSS('height', '50px');
  await expect(page.locator('.shell-content')).toHaveCSS('background-color', 'rgb(247, 249, 250)');
  await expect(page.locator('.page-view-trigger')).toHaveCSS('color', 'rgb(0, 84, 240)');
  await expect(page.locator('.ant-table-thead th').first()).toHaveCSS('height', '40px');
  await expect(page.locator('.ant-table-thead th').first()).toHaveCSS('font-size', '12px');
  await expect(page.locator('.ant-table-thead th').first()).toHaveCSS('color', 'rgb(51, 56, 61)');
  await expect(page.locator('.shell-sidebar')).toHaveCSS('width', '200px');
  await page.getByRole('button', { name: '收起菜单' }).click();
  await expect(page.locator('.shell-sidebar')).toHaveCSS('width', '72px');
  await page.getByRole('button', { name: '展开菜单' }).click();
  await expect(page.locator('.shell-sidebar')).toHaveCSS('width', '200px');
});

test('AC-FE-0-10 行内操作保持 40px，详情与筛选从右侧打开', async ({ page }) => {
  await page.goto('/smoke/template-fixture.html');
  await expect(page.locator('tr[data-row-key]')).toHaveCSS('height', '40px');
  await expect(page.locator('.page-heading .ant-btn-primary')).toHaveCSS('background-color', 'rgb(20, 110, 255)');
  await expect(page.locator('.page-heading .ant-btn-primary')).toHaveCSS('height', '32px');
  await page.getByRole('button', { name: '合成示例组织', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '合成示例组织' })).toBeVisible();
  await expect(page.locator('.detail-drawer')).toHaveClass(/ant-drawer-right/);
  await page.getByRole('tab', { name: '变更记录' }).click();
  await expect(page.getByRole('tabpanel')).toHaveText('合成变更记录');
  await page.getByRole('button', { name: '关闭' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('tr[data-row-key]')).toBeVisible();
  await page.getByRole('button', { name: '高级筛选', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '高级筛选' })).toBeVisible();
  await expect(page.locator('.filter-drawer .ant-drawer-content-wrapper')).toHaveCSS('width', '500px');
  await expect(page.locator('.filter-footer button')).toHaveText(['清空', '取 消', '确 定']);
});

test('AC-FE-0-11 顶栏全部菜单面板、消息抽屉与个人菜单按原站交互', async ({ page }) => {
  await page.goto('/staff');
  await page.getByLabel('切换演示身份').selectOption(user);
  const apps = page.getByRole('button', { name: '应用导航' });
  // 原站顶栏显示当前应用名，左侧只列当前应用的菜单（#326 第 2 轮 P2-2）
  await expect(apps).toContainText('组织员工');
  const sidebar = page.locator('.shell-sidebar');
  await expect(sidebar.getByRole('menuitem', { name: '员工', exact: true })).toBeVisible();
  await expect(sidebar.getByRole('menuitem', { name: '人才盘点' })).toHaveCount(0);
  await apps.click();
  const panel = page.getByRole('dialog', { name: '全部菜单' });
  await expect(apps).toContainText('关闭菜单');
  await expect(panel.getByRole('region', { name: '人才管理' }).getByRole('link', { name: '人才盘点' })).toBeVisible();
  // 面板打开后焦点在搜索框，Tab 循环不离开面板
  await expect(panel.getByRole('searchbox', { name: '搜索菜单' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('.all-menus'))).toBe(true);
  // 点当前页面对应的菜单也收起面板
  await panel.getByRole('region', { name: '组织员工' }).getByRole('link', { name: '员工', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await apps.click();
  // 下级菜单同样可搜，结果平铺并带路径（#326 第 2 轮 P2-1）
  await panel.getByRole('searchbox', { name: '搜索菜单' }).fill('全部用户');
  await expect(panel.getByText('搜索结果 1', { exact: true })).toBeVisible();
  await expect(panel.getByRole('link', { name: /全部用户/ })).toContainText('设置 > 企业设置 > 用户管理');
  await panel.getByRole('searchbox', { name: '搜索菜单' }).fill('职务');
  await expect(panel.getByRole('link', { name: '人才盘点' })).toHaveCount(0);
  await panel.getByRole('link', { name: /职务体系/ }).click();
  await expect(page).toHaveURL(/\/job/);
  await expect(panel).toHaveCount(0);
  await page.getByRole('button', { name: '消息', exact: true }).click();
  const messages = page.getByRole('dialog', { name: '消息' });
  await expect(messages.getByRole('tab', { name: '@和回复我的' })).toBeVisible();
  await expect(messages).toContainText('暂无新消息');
  await expect(page.locator('.message-drawer .ant-drawer-content-wrapper')).toHaveCSS('width', '500px');
  await messages.getByRole('button', { name: '关闭' }).click();
  await page.getByRole('button', { name: '个人菜单' }).click();
  await page.getByRole('menuitem', { name: '个人设置' }).click();
  await expect(page).toHaveURL(/\/settings\/account$/);
});
