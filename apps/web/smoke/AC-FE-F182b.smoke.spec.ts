import { test, expect, employee, user } from './fixtures.js';
import { mockIdp, otherEmployee, plan, thirdEmployee } from './r3d2-fixtures.js';

// F-182a 真实 my-plans 形状：分页信封、员工 ID / null，不带显示名、tutorRole、processId。
const { tutorRole: _role, processId: _process, ...summary } = plan;
const row = (suffix: string, name: string, tutorEmployeeId: string | null) => ({
  ...summary,
  id: `b0000000-0000-4000-8000-0000000003${suffix}`,
  name,
  tutorEmployeeId,
});
const items = [
  row('01', '合成乙指导计划一', otherEmployee),
  row('02', '合成乙指导计划二', otherEmployee),
  { ...row('03', '合成丙指导计划', thirdEmployee), status: 'ended' },
  row('04', '合成无指导人计划', null),
  { ...row('05', '合成他人待办计划', null), employeeId: otherEmployee },
  { ...row('06', '合成他人辅导计划', employee), employeeId: thirdEmployee },
];

test.beforeEach(async ({ page }) => {
  await mockIdp(page);
  await page.route(/\/api\/tenant\/idp\/my-plans(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { page: 1, pageSize: 200, items } }),
  );
  await page.goto('/idp');
  await page.getByLabel('切换演示身份').selectOption(user);
  await expect(page).toHaveURL(/\/staff$/);
  await page.goto('/self/idp');
  await expect(page.getByText('共4条')).toBeVisible();
});

test('AC-FE-F182b-01 指导人列解析姓名；null 显示 --；本人列表不纳入他人计划', async ({ page }) => {
  const tableRow = (name: string) => page.getByRole('row').filter({ hasText: name });
  await expect(tableRow('合成乙指导计划一').getByRole('cell').nth(2)).toHaveText('合成员工乙');
  await expect(tableRow('合成丙指导计划').getByRole('cell').nth(2)).toHaveText('合成员工丙');
  await expect(tableRow('合成无指导人计划').getByRole('cell').nth(2)).toHaveText('--');
  await expect(page.getByRole('button', { name: /合成他人/ })).toHaveCount(0);
});

test('AC-FE-F182b-02 按指导人筛选只剩对应行、排除 null；选项去重且清空恢复，不新增查询参数', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/idp/my-plans')) requests.push(request.url());
  });
  const tutor = page.getByRole('combobox', { name: '指导人', exact: true });
  await expect(tutor).toBeEnabled();
  await tutor.click();
  const options = page.locator('.ant-select-dropdown:visible .ant-select-item-option');
  await expect(options).toHaveText(['合成员工乙', '合成员工丙']);
  await options.filter({ hasText: '合成员工乙' }).click();
  await expect(page.getByText('共2条')).toBeVisible();
  await expect(page.locator('tbody .idp-link')).toHaveText(['合成乙指导计划一', '合成乙指导计划二']);
  await expect(page.getByRole('button', { name: '合成无指导人计划' })).toHaveCount(0);
  // 候选仍来自筛选前的本页已加载行，可以直接改选另一个指导人。
  await tutor.click();
  await expect(options).toHaveText(['合成员工乙', '合成员工丙']);
  await options.filter({ hasText: '合成员工丙' }).click();
  await expect(page.getByText('共1条')).toBeVisible();
  await expect(page.locator('tbody .idp-link')).toHaveText(['合成丙指导计划']);
  const select = page.locator('.ant-select').filter({ has: tutor });
  await select.hover();
  await select.locator('.ant-select-clear').click();
  await expect(page.getByText('共4条')).toBeVisible();
  await expect(page.getByRole('button', { name: '合成无指导人计划' })).toBeVisible();
  expect(requests).toEqual([]);
});
