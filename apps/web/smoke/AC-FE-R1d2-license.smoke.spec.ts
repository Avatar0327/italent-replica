import { actionButton } from './action-button.js';
import { test, expect, user } from './fixtures.js';
import { rows, settingsFixtures } from './settings-fixtures.js';

for (const [licenseType, balance] of [
  ['pa_user', -1],
  ['custom_license', -3],
] as const) {
  test(`AC-PRM-09 授权成功后保留 ${licenseType} 超额 ${-balance} 的补发提醒`, async ({ page }) => {
    await settingsFixtures(page);
    let saved = false;
    let writes = 0;
    await page.route('**/permission/grants', async (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { items: saved ? [rows.grant] : [] } });
      saved = true;
      writes += 1;
      return route.fulfill({
        status: 201,
        json: {
          ...rows.grant,
          licenseOverage: { code: 'LICENSE_OVERAGE', licenseType, quota: 0, used: -balance, balance },
        },
      });
    });
    await page.goto('/settings/menu/permission.user_grant');
    await page.getByRole('button', { name: /^新\s*增$/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('用户编号', { exact: true }).fill(user);
    await dialog.getByRole('combobox').click();
    await page.getByText('合成人事身份 (DEMO_HR)', { exact: true }).click();
    await actionButton(dialog, '保存').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.ant-table-tbody').getByText(user, { exact: true })).toBeVisible();
    const warning = page.getByRole('alert').filter({ hasText: '授权已成功，但许可超额' });
    await expect(warning).toContainText(licenseType);
    await expect(warning).toContainText(`超出 ${-balance} 个`);
    await expect(warning).toContainText(`当前余额 ${balance}`);
    await expect(warning).toContainText('请联系平台运营补发许可');
    await page.getByRole('button', { name: /^刷\s*新$/ }).click();
    await expect(warning).toBeVisible();
    expect(writes).toBe(1);
  });
}

test('AC-PRM-09 普通授权成功不显示超额提醒', async ({ page }) => {
  await settingsFixtures(page);
  await page.route('**/permission/grants', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    return route.fulfill({ status: 201, json: { ...rows.grant, licenseOverage: null } });
  });
  await page.goto('/settings/menu/permission.user_grant');
  await page.getByRole('button', { name: /^新\s*增$/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('用户编号', { exact: true }).fill(user);
  await dialog.getByRole('combobox').click();
  await page.getByText('合成人事身份 (DEMO_HR)', { exact: true }).click();
  await actionButton(dialog, '保存').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('alert').filter({ hasText: '授权已成功，但许可超额' })).toHaveCount(0);
});
