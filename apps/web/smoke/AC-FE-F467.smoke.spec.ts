import type { Page } from '@playwright/test';
import { test, expect, tenant } from './fixtures.js';

// F-467 团队人事看板（35 §2.1b）：只用合成数据；页面挂在管理者工作台 /manager/team-dashboard 下。
const board = (hasDataPermission: boolean) => ({
  asOf: '2026-10-01',
  hasDataPermission,
  components: [
    { code: '6.01', name: '在职人数', kind: 'value', value: hasDataPermission ? 5 : 0, groups: null },
    { code: '6.03', name: '平均司龄', kind: 'average', value: hasDataPermission ? 4.5 : null, count: 5, groups: null },
    {
      code: '6.08',
      name: '司龄分布',
      kind: 'groups',
      value: null,
      groups: [
        { key: 'under6m', label: '6月以下', count: 1 },
        { key: '10yplus', label: '10年及以上', count: 1 },
      ],
    },
  ],
});

async function open(page: Page, hasDataPermission: boolean) {
  await page.route('**/api/tenant/employment/transfers/manager', (route) =>
    route.fulfill({ json: { canApply: false, canViewReporting: true } }),
  );
  await page.route('**/api/tenant/analytics/team-dashboard', (route) =>
    route.fulfill({ json: board(hasDataPermission) }),
  );
}

test.beforeEach(async ({ page, baseURL }) => {
  await page.context().addCookies([{ name: 'italent_demo_tenant', value: tenant, url: baseURL! }]);
});

test('AC-FE-F467-1 团队人事看板：显示在职人数、平均司龄和司龄分布，不出现内部编码', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await open(page, true);
  await page.goto('/manager/team-dashboard');
  const workspace = page.locator('.shell-workspace');
  await expect(workspace).toContainText('团队人事看板');
  await expect(workspace).toContainText('在职人数');
  await expect(workspace).toContainText('4.5');
  await expect(workspace).toContainText('6月以下');
  await expect(workspace).not.toContainText('6.01');
  await expect(workspace).not.toContainText('under6m');
  await page.screenshot({ path: testInfo.outputPath('team-dashboard.png') });
  expect(errors).toEqual([]);
});

test('AC-FE-F467-2 没有可统计成员时显示空状态，不显示数字', async ({ page }) => {
  await open(page, false);
  await page.goto('/manager/team-dashboard');
  await expect(page.locator('.shell-workspace')).toContainText('当前没有可统计的团队成员');
  await expect(page.locator('.shell-workspace .ant-statistic')).toHaveCount(0);
});
