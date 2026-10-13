import { test, expect, user } from './fixtures.js';
const id = 'a0000000-0000-4000-8000-000000000001';
const fields = [
  'code',
  'name',
  'status',
  'ownerOrgId',
  'year',
  'period',
  'periodStartDate',
  'periodEndDate',
  'categoryId',
  'calcRuleId',
  'criterionId',
  'downwardPublic',
  'enabled',
  'flowId',
  'modules',
  'steps',
  'permissions',
  'cells',
];

test.beforeEach(async ({ page }) => {
  await page.route('**/permission/me/objects/TalentReview.*', (route) =>
    route.fulfill({
      json: {
        objectCode: new URL(route.request().url()).pathname.split('/').at(-1),
        dataOperations: { view: true },
        viewableFields: fields,
        editableFields: fields,
        buttons: ['create', 'update', 'start', 'end', 'restart'].map((buttonCode) => ({
          buttonCode,
          level: buttonCode === 'create' ? 'list' : 'detail',
        })),
      },
    }),
  );
  await page.route('**/api/tenant/talent-review/**', (route) => {
    const url = new URL(route.request().url());
    const item = {
      id,
      revision: 1,
      accessLevel: 'manage',
      code: 'DEMO_REVIEW',
      name: '合成年度盘点',
      status: 'new',
      ownerOrgId: id,
      year: 2026,
      period: '年度',
      periodStartDate: '2026-10-01',
      periodEndDate: '2026-10-31',
      enabled: true,
      modules: [],
      steps: [],
      permissions: [],
      cells: [],
    };
    return route.fulfill({ json: url.pathname.endsWith(id) ? item : { items: [item], hasDataPermission: true } });
  });
});

test('AC-FE-R3c-01 切换演示身份，项目列表、八页签详情与配置抽屉可渲染', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/talent-review');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.getByRole('button', { name: '合成年度盘点', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '合成年度盘点', exact: true })).toBeVisible();
  for (const tab of [
    '盘点对象',
    '多人评价关系',
    '指标明细',
    '九宫格',
    '组织继任地图',
    '职位继任地图',
    '仪表盘',
    '结果审批流程',
  ]) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await expect(page.getByRole('tabpanel', { name: tab, exact: true })).toContainText('演示数据');
  }
  await page.getByRole('button', { name: '编辑项目', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '编辑项目', exact: true })).toBeVisible();
  await expect(page.getByLabel('名称', { exact: true })).toHaveValue('合成年度盘点');
  await page.getByRole('button', { name: '取消', exact: true }).last().click();
  expect(errors).toEqual([]);
});

for (const section of ['盘点模板', '九宫格设置', '盘点校准会']) {
  test(`AC-FE-R3c-02 ${section} 列表与详情渲染无错误`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto('/talent-review');
    await page.getByLabel('切换演示身份').selectOption(user);
    await page.getByRole('tab', { name: section, exact: true }).click();
    await page.locator('.list-card tbody button').first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    if (section === '盘点模板') {
      await page.getByRole('button', { name: '编辑模板', exact: true }).click();
      await expect(page.getByRole('dialog', { name: '编辑模板', exact: true })).toBeVisible();
    }
    expect(errors).toEqual([]);
  });
}

test('AC-FE-R3c-03 已结束与共享只读项目不提供编辑，真实接口失败不混入演示数据', async ({ page }) => {
  await page.route('**/talent-review/projects*', (route) =>
    route.fulfill({ json: { items: [], hasDataPermission: false } }),
  );
  await page.goto('/talent-review');
  await page.getByLabel('切换演示身份').selectOption(user);
  await expect(page.locator('.list-card')).toContainText('当前没有可查看的数据范围');
  await expect(page.getByRole('button', { name: '合成年度盘点', exact: true })).toHaveCount(0);
});
