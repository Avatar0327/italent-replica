import { test, expect, snapshotFixture } from './fixtures.js';
import { id, named, record, setupContracts as setup } from './contracts-fixtures.js';

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
  await expect(page.locator('.contract-card .ant-spin-spinning')).toHaveCount(0);
  await expect(page.locator('.contract-pagination')).toContainText('共 1 条');
  await page.screenshot({ path: '../../.demo/f127-list.png' });
  await page.getByRole('button', { name: '查看合同', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: '合同详情' })).toBeVisible();
  await expect(page.getByText('签订次数', { exact: true })).toBeVisible();
  await expect(page.locator('.contract-detail').getByText('7', { exact: true })).toBeVisible();
  await expect(page.locator('.contract-detail')).toContainText(id);
  // 原断言“详情末卡为演示数据”：任职已直连接口；按原站只有“合同协议”一个分区，先任职后合同，无版本链。
  await expect(page.locator('.contract-detail .contract-card')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: '合同协议', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '任职信息', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '版本链', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '返回列表', exact: true }).click();
  await page.getByRole('button', { name: '高级筛选', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '高级筛选' });
  await expect(drawer).toBeVisible();
  // 原断言“抽屉标演示数据”：筛选已按后端参数发送，改为核对服务端参数与结果。
  await expect(drawer.getByText('生效日期范围', { exact: true })).toBeVisible();
  await page.screenshot({ path: '../../.demo/f127-filter.png' });
  await drawer.getByLabel('姓名', { exact: true }).fill('不存在');
  const filtered = page.waitForRequest((r) => new URL(r.url()).searchParams.get('keyword') === '不存在');
  await drawer.getByRole('button', { name: /^确\s*定$/ }).click();
  await filtered;
  await expect(page.getByRole('button', { name: '查看合同', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '清空已选', exact: true }).click();
  await expect(page.getByRole('button', { name: '查看合同', exact: true }).first()).toBeVisible();
  for (const [label, content] of [
    ['合同类型', '合成合同类型'],
    ['自动续签规则', '合成续签规则'],
    ['合同管理设置', '到期后自动终止'],
  ]) {
    await page.getByRole('link', { name: label, exact: true }).click();
    await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
    await expect(page.getByText(content!, { exact: true }).first()).toBeVisible();
    // 原断言“查看独立样例”：类型列表已直连接口，改为核对按权限出现的新建入口。
    if (label === '合同类型') await expect(page.getByRole('button', named('新建'))).toBeVisible();
    if (label === '自动续签规则') {
      await page.getByRole('button', { name: '规则信息', exact: true }).click();
      await expect(page.getByRole('dialog', { name: '规则信息' })).toContainText('流程发起规则');
      await page.getByRole('dialog').getByRole('button', { name: '关闭' }).click();
    }
  }
  expect(errors).toEqual([]);
  expect(writes).toEqual([]);
});
test('AC-FE-R2a-04 无权限入口隐藏，直达拒绝；详情错误不接桩', async ({ page }) => {
  await setup(page);
  await page.route('**/api/tenant/contracts/records/*', (route) =>
    route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND' } } }),
  );
  await page.getByRole('button', { name: '查看合同', exact: true }).first().click();
  await expect(page.getByText('页面或记录不存在', { exact: true })).toBeVisible();
  await expect(page.locator('.contract-detail')).not.toContainText('DEMO-CT-001');
  await page.route('**/permission/me/snapshot', (route) => route.fulfill({ json: snapshotFixture }));
  await page.route('**/permission/me/objects/TenantBase.EmploymentContract', (route) =>
    route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN' } } }),
  );
  await page.goto('/contracts');
  await expect(page.getByText('暂无访问权限', { exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '合同协议', exact: true })).toHaveCount(0);
});

// 原“返回接口数据”按钮随演示筛选一起移除；刷新与清空已选仍须清除筛选并重读服务端结果。
for (const action of ['刷新', '清空已选']) {
  test(`AC-FE-R2a-07 ${action} 清除筛选并重读服务端结果`, async ({ page }) => {
    await setup(page);
    const tab = page.getByRole('button', { name: '全部合同协议', exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-pressed', 'true');
    const list = page.locator('.contract-card');
    const filtered = page.waitForRequest((r) => new URL(r.url()).searchParams.get('keyword') === '不存在');
    await list.getByLabel('姓名', { exact: true }).fill('不存在');
    await list.getByLabel('姓名', { exact: true }).press('Enter');
    await filtered;
    await expect(list.getByRole('cell', { name: 'DEMO-CT-001', exact: true })).toHaveCount(0);
    const cleared = page.waitForRequest((r) => {
      const params = new URL(r.url()).searchParams;
      return params.get('view') === 'all' && params.get('pageSize') === '15' && !params.has('keyword');
    });
    await list.getByRole('button', { name: action, exact: true }).click();
    await cleared;
    await expect(list.getByLabel('姓名', { exact: true })).toHaveValue('');
    await expect(list.getByRole('cell', { name: 'DEMO-CT-001', exact: true })).toBeVisible();
    await list.getByRole('button', { name: '高级筛选', exact: true }).click();
    await expect(page.getByRole('dialog').getByLabel('姓名', { exact: true })).toHaveValue('');
  });
}
test('AC-FE-R2a-08 列表、详情、类型、设置及规则只翻译枚举字段', async ({ page }) => {
  await setup(page);
  const collision = { ...record, number: 'fixed', companyId: 'task', typeId: 'valid' };
  await page.route('**/api/tenant/contracts?*', (route) => route.fulfill({ json: { items: [collision] } }));
  await page.route('**/api/tenant/contracts/records/*', (route) => route.fulfill({ json: collision }));
  await page.goto('/contracts?view=valid');
  for (const text of ['fixed', 'task', 'valid', '固定期限']) {
    await expect(page.locator('.contract-card').getByRole('cell', { name: text, exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: '查看合同', exact: true }).click();
  const detail = page.locator('.contract-detail .contract-card').first();
  for (const text of ['fixed', 'task', 'valid', '固定期限', '有效', '生效']) {
    await expect(detail.getByText(text, { exact: true })).toBeVisible();
  }
  await page.route('**/api/tenant/contracts/master-data/types?*', (route) =>
    route.fulfill({ json: { items: [{ id: 'type', code: 'fixed', name: 'task', enabled: true }] } }),
  );
  await page.getByRole('link', { name: '合同类型', exact: true }).click();
  for (const text of ['fixed', 'task', '启用']) {
    await expect(page.locator('.contract-card').getByRole('cell', { name: text, exact: true })).toBeVisible();
  }
  await page.route('**/api/tenant/contracts/settings', (route) =>
    route.fulfill({ json: { autoRenew: false, postExitTypeIds: ['fixed', 'task'] } }),
  );
  await page.getByRole('link', { name: '合同管理设置', exact: true }).click();
  await expect(page.locator('.contract-card').getByText('fixed、task', { exact: true })).toBeVisible();
  // 规则列表改为分页接口（?page&pageSize），桩路径随之从精确匹配改为带查询串。
  await page.route('**/api/tenant/contracts/rules?*', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: 'rule',
            name: 'renew',
            priority: 1,
            orgIds: ['fixed'],
            personIds: ['task'],
            details: [{ typeId: 'valid', daysBefore: 30, months: 12, initiatorId: 'approved', skipTypeIds: ['task'] }],
          },
        ],
        total: 1,
      },
    }),
  );
  await page.getByRole('link', { name: '自动续签规则', exact: true }).click();
  for (const text of ['renew', 'fixed', 'task', 'valid · 到期前天数 30 · 续签期限（月） 12']) {
    await expect(page.locator('.contract-card').getByRole('cell', { name: text, exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: '规则信息', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '规则信息' });
  for (const text of ['renew', 'fixed', 'valid', 'approved']) {
    await expect(drawer.getByText(text, { exact: true })).toBeVisible();
  }
  await expect(drawer.getByText('task', { exact: true })).toHaveCount(2);
});
// 原“人员”输入与“演示筛选 / 排序”随演示筛选移除：缺失视图改用姓名 / 工号关键字发到后端，列名在默认列中核对。
test('AC-FE-R2a-09 缺失视图关键字筛选及参考列名', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '入职缺失', exact: true }).click();
  const list = page.locator('.contract-card');
  const filtered = page.waitForRequest((r) => {
    const params = new URL(r.url()).searchParams;
    return params.get('view') === 'missing' && params.get('keyword') === '合成甲';
  });
  await list.getByLabel('姓名', { exact: true }).fill('合成甲');
  await list.getByLabel('姓名', { exact: true }).press('Enter');
  await filtered;
  await expect(list.getByRole('cell', { name: '合成甲', exact: true })).toBeVisible();
  for (const label of ['即将到期', '有效合同协议', '过期未续签', '全部合同协议']) {
    const tab = page.getByRole('button', { name: label, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-pressed', 'true');
    await expect(list.getByLabel('姓名', { exact: true })).toHaveValue('');
    const columns =
      label === '全部合同协议'
        ? ['公司', '邮箱', '最新电子协议签署状态', '最新电子协议附件', '电子协议签署记录']
        : ['法人公司'];
    for (const name of columns) await expect(list.getByRole('columnheader', { name, exact: true })).toBeVisible();
  }
});
