import { test, expect, tenant, user, snapshotFixture } from './fixtures.js';
import { mockInfo } from './f154-fixtures.js';
import { ui } from '../src/foundation/messages.js';

test.beforeEach(async ({ page, baseURL }) => {
  await page.context().addCookies([
    { name: 'italent_demo_tenant', value: tenant, url: baseURL! },
    { name: 'italent_demo_user', value: user, url: baseURL! },
  ]);
});

test('AC-FE-F220-02 无应用权限时大小写直达均在外壳拦截', async ({ page }) => {
  // 合成哨兵只替换页面，保留真实登记与权限守卫，避免模块内重定向掩盖外壳曾放行。
  await page.route(/\/src\/idp\/pages\.ts(?:\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replaceAll('page: IdpPage,', "page: { Component: () => '合成应用已挂载' },");
    await route.fulfill({ response, body });
  });
  let visible = false;
  await page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        apps: snapshotFixture.apps.map((app) =>
          app.app === 'idp' ? { ...app, visible, entryObjects: ['IDP.TutorShip'] } : app,
        ),
      },
    }),
  );
  for (const path of ['/idp', '/IDP', '/Idp', '/Idp/plans', '/tutorship-information', '/TUTORSHIP-INFORMATION']) {
    await page.goto(path);
    await expect(page.locator('.shell-workspace')).toContainText(ui.denied);
    await expect(page.getByText('合成应用已挂载', { exact: true })).toHaveCount(0);
  }
  visible = true;
  for (const path of ['/idp', '/IDP', '/Idp']) {
    await page.goto(path);
    await expect(page.locator('.shell-workspace')).toHaveText('合成应用已挂载');
  }
});

test('AC-FE-F220-03 有权限时大小写入口进入真实列表；缺带教对象时均拒绝', async ({ page }) => {
  await mockInfo(page);
  for (const path of ['/idp', '/IDP', '/Idp', '/tutorship-information', '/TUTORSHIP-INFORMATION']) {
    await page.goto(path);
    const title = path.toLowerCase() === '/idp' ? '未开始&进行中' : '带教信息';
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  }
  await page.route('**/permission/me/snapshot', (route) => route.fulfill({ json: snapshotFixture }));
  for (const path of ['/tutorship-information', '/TUTORSHIP-INFORMATION']) {
    await page.goto(path);
    await expect(page.locator('.shell-workspace')).toContainText(ui.denied);
  }
});

test('AC-FE-F220-04 个人设置大小写变体仍仅要求会话，不误用企业设置权限', async ({ page }) => {
  await page.route(/\/src\/account\/AccountPage\.tsx?(?:\?.*)?$/, (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: "export const AccountPage = () => '合成个人设置已挂载';",
    }),
  );
  await page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        apps: snapshotFixture.apps.map((app) => (app.app === 'settings' ? { ...app, visible: false } : app)),
      },
    }),
  );
  for (const path of ['/settings/account', '/SETTINGS/account', '/Settings/Account']) {
    await page.goto(path);
    await expect(page.locator('.shell-workspace')).toHaveText('合成个人设置已挂载');
  }
});
