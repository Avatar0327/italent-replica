import { test, expect, tenant, user, snapshotFixture } from './fixtures.js';
import { ui } from '../src/foundation/messages.js';

const globalPath = '/config-center/global/synthetic-global';
const transferPath = '/config-center/apps/transfer/workflow/synthetic-transfer';
const orgPath = '/config-center/apps/org/workflow/synthetic-org';
const staffPath = '/config-center/workflow/processes';

test.beforeEach(async ({ page, baseURL }) => {
  await page.context().addCookies([
    { name: 'italent_demo_tenant', value: tenant, url: baseURL! },
    { name: 'italent_demo_user', value: user, url: baseURL! },
  ]);
  // 通过既有登记入口注入合成页，只验证 C1 外壳，不注册 F1 业务页面。
  await page.route(/\/src\/approval\/pages\.ts(?:\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      'configurations: [',
      `configurations: [
      { id: 'synthetic-global', label: '合成全局配置', placement: { kind: 'global' },
        access: { adminMenu: 'matrix.manage' }, page: { Component: () => '合成全局内容' } },
      { id: 'synthetic-transfer', label: '合成调动配置', placement: { kind: 'app', app: 'transfer' },
        section: 'workflow', access: { adminMenu: 'matrix.manage' },
        page: { Component: () => '合成调动内容' } },
      { id: 'synthetic-org', label: '合成组织配置', placement: { kind: 'app', app: 'org' },
        section: 'workflow', access: { adminMenu: 'matrix.manage' } },
    `,
    );
    expect(body).toContain('synthetic-global');
    await route.fulfill({ response, body });
  });
});

function snapshot(allowed: boolean) {
  return {
    ...snapshotFixture,
    apps: snapshotFixture.apps.map((app) =>
      app.app === 'approval' ? { ...app, entryObjects: ['TenantBase.ApprovalProcess'] } : app,
    ),
    adminMenus: allowed ? [{ code: 'matrix.manage', path: '流程矩阵', editable: true }] : [],
  };
}

test('AC-APV-F326-21 合成登记通过正常入口展示全局项和应用容器，独立展开、刷新及前进后退', async ({ page }) => {
  await page.route('**/permission/me/snapshot', (route) => route.fulfill({ json: snapshot(true) }));
  await page.goto('/config-center');
  await expect(page).toHaveURL(new RegExp(`${globalPath}$`));
  const nav = page.getByRole('navigation', { name: '配置中心目录' });
  await expect(nav.getByText('全局项', { exact: true })).toBeVisible();
  await expect(nav.locator('.configuration-application')).toHaveText(['▾ 组织管理', '▾ 组织员工', '▾ 调动管理']);
  await expect(nav.getByRole('link', { name: '合成全局配置' })).toHaveAttribute('href', globalPath);
  await expect(page.getByText('合成全局内容', { exact: true })).toBeVisible();
  const transfer = page.locator('#configuration-sections-transfer');
  await transfer.getByRole('button', { name: '流程任务管理', exact: true }).click();
  await transfer.getByRole('link', { name: '合成调动配置' }).click();
  await expect(page).toHaveURL(new RegExp(`${transferPath}$`));
  await expect(page.getByText('合成调动内容', { exact: true })).toBeVisible();
  await expect(transfer.getByRole('link', { name: '合成调动配置' })).toHaveAttribute('aria-current', 'page');
  await expect(transfer.getByRole('link', { name: '合成全局配置' })).toHaveCount(0);
  await nav.getByRole('button', { name: '组织员工', exact: true }).click();
  await expect(transfer.getByRole('link', { name: '合成调动配置' })).toBeVisible();
  await page.reload();
  await expect(transfer.getByRole('link', { name: '合成调动配置' })).toBeVisible();
  await page.goBack();
  await expect(page.getByText('合成全局内容', { exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByText('合成调动内容', { exact: true })).toBeVisible();
  await page.goto(orgPath);
  await expect(page.getByRole('heading', { name: '合成组织配置', exact: true })).toBeVisible();
  await page.goto(staffPath);
  await expect(page.getByRole('heading', { name: '流程', exact: true })).toBeVisible();
});

test('AC-APV-F326-21 新路径可直达及挂子路由，无权时隐藏全局组和空应用容器且拒绝直达', async ({ page }) => {
  let allowed = true;
  await page.route('**/permission/me/snapshot', (route) => route.fulfill({ json: snapshot(allowed) }));
  for (const path of [
    `${globalPath}/detail`,
    `${transferPath}/detail`,
    '/CONFIG-CENTER/apps/TRANSFER/workflow/synthetic-transfer/',
  ]) {
    await page.goto(path);
    await expect(
      page.getByText(path.includes('global') ? '合成全局内容' : '合成调动内容', { exact: true }),
    ).toBeVisible();
  }
  allowed = false;
  await page.reload();
  await expect(page.getByText(ui.denied, { exact: true })).toBeVisible();
  const nav = page.getByRole('navigation', { name: '配置中心目录' });
  await expect(nav.locator('.configuration-application')).toHaveText(['▾ 组织员工']);
  await expect(nav.getByText('全局项', { exact: true })).toHaveCount(0);
  for (const path of [globalPath, orgPath, transferPath]) {
    await page.goto(path);
    await expect(page.getByText(ui.denied, { exact: true })).toBeVisible();
  }
  await page.goto(staffPath);
  await expect(page.getByRole('heading', { name: '流程', exact: true })).toBeVisible();
});
