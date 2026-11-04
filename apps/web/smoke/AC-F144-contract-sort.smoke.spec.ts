import { test, expect } from './fixtures.js';
import { setupContracts } from './contracts-fixtures.js';
import { objectPermissions } from './contracts-permissions.js';
import type { Page } from '@playwright/test';

// F-144：合同列表“排序”选项按编号字段查看权裁剪——编号不可查看时不提供“编号”排序（不发 sort=number）。
async function sortOptions(page: Page) {
  await page.getByRole('button', { name: '高级筛选', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '高级筛选' });
  await drawer.getByRole('combobox', { name: '排序', exact: true }).click();
  const options = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option');
  await expect(options.first()).toBeVisible();
  return options.allTextContents();
}

test('AC-F144-01 编号可查看：排序选项含“编号”', async ({ page }) => {
  await setupContracts(page);
  expect(await sortOptions(page)).toEqual(['终止日期', '生效日期', '签订日期', '姓名', '编号']);
});

test('AC-F144-02 编号不可查看：排序选项不含“编号”，其余照旧', async ({ page }) => {
  const viewableFields = objectPermissions.contract.viewableFields.filter((key) => key !== 'number');
  await setupContracts(page, {
    'TenantBase.EmploymentContract': { ...objectPermissions.contract, viewableFields },
  });
  expect(await sortOptions(page)).toEqual(['终止日期', '生效日期', '签订日期', '姓名']);
});
