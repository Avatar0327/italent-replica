import { test, expect, tenant, user, snapshotFixture } from './fixtures.js';
import { ui } from '../src/foundation/messages.js';

const flowPath = '/config-center/workflow/processes';
test.beforeEach(async ({ page, baseURL }) => {
  await page.context().addCookies([
    { name: 'italent_demo_tenant', value: tenant, url: baseURL! },
    { name: 'italent_demo_user', value: user, url: baseURL! },
  ]);
});

function withFlow(allowed: boolean) {
  return {
    ...snapshotFixture,
    apps: snapshotFixture.apps.map((app) =>
      app.app === 'approval' ? { ...app, entryObjects: allowed ? ['TenantBase.ApprovalProcess'] : [] } : app,
    ),
  };
}

test('AC-FE-F320-05 头像进入配置中心，目录展开、流程列表、其余占位不可写、刷新与返回企业设置', async ({ page }) => {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/') && !['GET', 'HEAD'].includes(request.method())) writes.push(request.url());
  });
  await page.route('**/permission/me/snapshot', (route) => route.fulfill({ json: withFlow(true) }));
  await page.goto('/settings');
  await page.getByRole('button', { name: ui.personalMenu, exact: true }).click();
  await page.getByRole('menuitem', { name: '应用配置', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${flowPath}$`));
  await expect(page.getByRole('heading', { name: '配置中心', exact: true })).toBeVisible();
  const nav = page.getByRole('navigation', { name: '配置中心目录' });
  const workflow = nav.getByRole('button', { name: '流程任务管理', exact: true });
  await expect(workflow).toHaveAttribute('aria-expanded', 'true');
  await workflow.click();
  await expect(nav.getByRole('link', { name: '流程', exact: true })).not.toBeVisible();
  await workflow.click();
  await nav.getByRole('link', { name: '流程', exact: true }).click();
  await expect(page.getByRole('heading', { name: '流程', exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '流程名称', exact: true })).toBeVisible();
  await page.reload();
  await expect(nav.getByRole('link', { name: '流程', exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('configuration-center.png'), fullPage: true });
  await nav.getByRole('link', { name: '数据源', exact: true }).click();
  await expect(page.getByRole('heading', { name: '数据源', exact: true })).toBeVisible();
  await expect(page.getByText('此配置页尚未开放', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: '数据源', exact: true })).toBeVisible();
  await page.goto('/settings');
  await expect(page.locator('.shell-sidebar').getByText('企业设置', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: ui.personalMenu, exact: true }).click();
  await expect(page.getByRole('menuitem', { name: ui.account, exact: true })).toBeVisible();
  expect(writes).toEqual([]);
});

test('AC-FE-F320-06 无权隐藏头像入口，直达和撤权刷新均拒绝', async ({ page }) => {
  let allowed = false;
  await page.route('**/permission/me/snapshot', (route) => route.fulfill({ json: withFlow(allowed) }));
  await page.goto('/settings');
  await page.getByRole('button', { name: ui.personalMenu, exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '应用配置', exact: true })).toHaveCount(0);
  for (const path of ['/config-center', flowPath, '/CONFIG-CENTER/workflow/processes', '/%63onfig-center']) {
    await page.goto(path);
    await expect(page.getByText(ui.denied, { exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: '配置中心目录' })).toHaveCount(0);
  }
  allowed = true;
  await page.goto(flowPath);
  await expect(page.getByRole('heading', { name: '流程', exact: true })).toBeVisible();
  allowed = false;
  await page.reload();
  await expect(page.getByText(ui.denied, { exact: true })).toBeVisible();
});

test('AC-FE-F320-07 有权直达、大小写和编码路径、未知页及流程非法子路由拒绝', async ({ page }) => {
  await page.route('**/permission/me/snapshot', (route) => route.fulfill({ json: withFlow(true) }));
  for (const path of [flowPath, '/CONFIG-CENTER/workflow/PROCESSES/', '/%63onfig-center/workflow/processes']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: '流程', exact: true })).toBeVisible();
  }
  for (const path of ['/config-center/unknown', `${flowPath}/unimplemented`, '/config-center/data/unknown']) {
    await page.goto(path);
    await expect(page.getByText(ui.missing, { exact: true })).toBeVisible();
  }
});

test('AC-FE-F320-12 后续模块挂载页及子路由，独立鉴权不借流程权限放行', async ({ page }) => {
  await page.route(/\/src\/approval\/pages\.ts(?:\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      'configurations: [',
      `configurations: [{
        id: 'synthetic-tasks', label: '合成任务配置', section: 'workflow',
        access: { adminMenu: 'users.all' },
        page: { Component: () => '合成配置页面内容' }
      },`,
    );
    expect(body).toContain('synthetic-tasks');
    await route.fulfill({ response, body });
  });
  let allowed = true;
  await page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({ json: { ...withFlow(true), adminMenus: allowed ? snapshotFixture.adminMenus : [] } }),
  );
  await page.goto('/config-center/workflow/synthetic-tasks/detail');
  await expect(page.getByText('合成配置页面内容', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('合成配置页面内容', { exact: true })).toBeVisible();
  allowed = false;
  await page.reload();
  await expect(page.getByText(ui.denied, { exact: true })).toBeVisible();
  await expect(page.getByText('合成配置页面内容', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '合成任务配置', exact: true })).toHaveCount(0);
  await page.goto(flowPath);
  await expect(page.getByRole('heading', { name: '流程', exact: true })).toBeVisible();
});
