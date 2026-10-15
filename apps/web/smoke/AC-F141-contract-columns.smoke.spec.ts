import { test, expect } from './fixtures.js';
import { setupContracts as setup } from './contracts-fixtures.js';

// F-141 缺陷 6（DEC-500）：入职缺失的行是人员，不是合同，七个人员列都不受合同对象字段清单过滤。
// 合同对象的可见字段只有 name 以外的少数几项（夹具），姓名 / 工号不在其中。
test('AC-F141-contract-columns 入职缺失显示七个人员列，其他视图仍按合同字段清单裁剪', async ({ page }) => {
  await setup(page);
  const list = page.locator('.contract-card');
  const response = page.waitForResponse((r) => new URL(r.url()).searchParams.get('view') === 'missing');
  await page.getByRole('button', { name: '入职缺失', exact: true }).click();
  await response;
  for (const name of ['姓名', '电子邮件', '员工', '入职日期', '部门', '职务', '职位'])
    await expect(list.getByRole('columnheader', { name, exact: true })).toBeVisible();

  const valid = page.waitForResponse((r) => new URL(r.url()).searchParams.get('view') === 'valid');
  await page.getByRole('button', { name: '有效合同协议', exact: true }).click();
  await valid;
  // 合同视图没有“员工”（工号）列：它不在合同对象的可见字段里
  await expect(list.getByRole('columnheader', { name: '员工', exact: true })).toHaveCount(0);
});
