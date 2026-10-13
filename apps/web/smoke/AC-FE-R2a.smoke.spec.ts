import { test, expect, user } from './fixtures.js';
import type { Page } from '@playwright/test';
const id = '40000000-0000-4000-8000-000000000001';
const record = {
  id,
  employeeId: 'employee',
  number: 'DEMO-CT-001',
  typeId: 'type',
  companyId: 'company',
  termType: 'fixed',
  effectiveDate: '2026-01-01',
  endDate: '2027-01-01',
  signingCount: 7,
  status: 'valid',
  approvalStatus: 'effective',
  rootContractId: id,
  versionNo: 2,
};
async function setup(page: Page) {
  await page.route('**/permission/me/objects/*', (route) =>
    route.fulfill({
      json: {
        objectCode: route.request().url().split('/').at(-1),
        dataOperations: { view: true },
        viewableFields: [
          ...Object.keys(record),
          'name',
          'code',
          'enabled',
          'autoRenew',
          'autoTerminate',
          'accumulateRehire',
          'postExitTypeIds',
          'indefiniteTypeIds',
          'renewalTypeIds',
          'priority',
          'orgIds',
          'personIds',
          'details',
        ],
        editableFields: [],
        buttons: [],
      },
    }),
  );
  await page.route('**/contracts?*', (route) => {
    const view = new URL(route.request().url()).searchParams.get('view');
    return route.fulfill({
      json: {
        items: [
          view === 'missing'
            ? { employeeId: 'employee', name: '合成甲', code: 'DEMO-001' }
            : { ...record, ...(view === 'all' ? { rowType: 'contract' } : {}) },
        ],
        hasDataPermission: true,
      },
    });
  });
  await page.route('**/contracts/records/*', (route) => route.fulfill({ json: record }));
  await page.route('**/contracts/master-data/types?*', (route) =>
    route.fulfill({ json: { items: [{ id: 'type', code: 'DEMO-T', name: '合成合同类型', enabled: true }] } }),
  );
  await page.route('**/contracts/rules', (route) =>
    route.fulfill({
      json: { items: [{ id: 'rule', name: '合成续签规则', priority: 1, orgIds: [], personIds: [], details: [] }] },
    }),
  );
  await page.route('**/contracts/settings', (route) =>
    route.fulfill({
      json: {
        autoRenew: false,
        autoTerminate: true,
        accumulateRehire: false,
        postExitTypeIds: [],
        indefiniteTypeIds: [],
        renewalTypeIds: [],
      },
    }),
  );
  await page.goto('/contracts');
  await page.getByLabel('切换演示身份').selectOption(user);
}
test('AC-FE-R2a-03 六视图请求、详情、高级筛选与三设置页', async ({ page }) => {
  const errors: string[] = [];
  const writes: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (r.url().includes('/contracts') && r.method() !== 'GET') writes.push(r.method());
  });
  await setup(page);
  for (const [view, label] of [
    ['expiring', '即将到期'],
    ['missing', '入职缺失'],
    ['expired_unrenewed', '过期未续签'],
    ['in_review', '审批中合同协议'],
    ['valid', '有效合同协议'],
    ['all', '全部合同协议'],
  ]) {
    const response = page.waitForResponse((r) => new URL(r.url()).searchParams.get('view') === view);
    await page.getByRole('button', { name: label, exact: true }).click();
    await response;
  }
  await page.getByRole('button', { name: '查看合同', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: '合同详情' })).toBeVisible();
  await expect(page.getByText('签订次数', { exact: true })).toBeVisible();
  await expect(page.locator('.contract-detail')).toContainText('7');
  await expect(page.locator('.contract-detail')).toContainText(id);
  await expect(page.getByText('演示数据', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '返回列表', exact: true }).click();
  await page.getByRole('button', { name: '高级筛选', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '高级筛选' });
  await expect(drawer).toBeVisible();
  await drawer.getByLabel('姓名', { exact: true }).fill('不存在');
  await drawer.getByRole('button', { name: '确定', exact: true }).click();
  await expect(page.getByText('演示数据', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '查看合同', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '清空已选', exact: true }).click();
  for (const [label, content] of [
    ['合同类型', '合成合同类型'],
    ['自动续签规则', '合成续签规则'],
    ['合同管理设置', '到期后自动终止'],
  ]) {
    await page.getByRole('link', { name: label, exact: true }).click();
    await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
    await expect(page.getByText(content, { exact: true }).first()).toBeVisible();
  }
  expect(errors).toEqual([]);
  expect(writes).toEqual([]);
});
test('AC-FE-R2a-04 无权限入口隐藏，直达拒绝；详情错误不接桩', async ({ page }) => {
  await setup(page);
  await page.route('**/contracts/records/*', (route) =>
    route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND' } } }),
  );
  await page.getByRole('button', { name: '查看合同', exact: true }).first().click();
  await expect(page.getByText('页面或记录不存在', { exact: true })).toBeVisible();
  await expect(page.locator('.contract-detail')).not.toContainText('DEMO-CT-001');
  await page.route('**/permission/me/objects/TenantBase.EmploymentContract', (route) =>
    route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN' } } }),
  );
  await page.goto('/contracts');
  await expect(page.getByText('暂无访问权限', { exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '合同协议', exact: true })).toHaveCount(0);
});
