import type { Page } from '@playwright/test';
import { test, expect, user, employee } from './fixtures.js';

const fields = [
  'name',
  'code',
  'gender',
  'entryDate',
  'employeeStatus',
  'email',
  'educationLevel',
  'school',
  'effectiveDate',
  'stopDate',
  'kind',
  'isCurrent',
  'staffId',
  'departmentId',
  'postId',
  'entryDate',
];
async function staffFixtures(page: Page) {
  await page.route('**/permission/me/objects/*', (route) =>
    route.fulfill({
      json: {
        objectCode: route.request().url().split('/').at(-1),
        dataOperations: { view: true },
        viewableFields: fields,
        editableFields: [],
        buttons: [],
      },
    }),
  );
  await page.route('**/personnel/employees?*', (route) => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({
      json: {
        items:
          params.get('employeeName') === '不存在'
            ? []
            : [
                {
                  id: employee,
                  name: '合成林晓',
                  code: 'DEMO-001',
                  gender: '女',
                  employeeStatus: 3,
                  entryDate: '2024-01-01',
                },
              ],
        hasDataPermission: true,
        page: Number(params.get('page')),
        pageSize: 15,
      },
    });
  });
  await page.route(`**/personnel/employees/${employee}`, (route) =>
    route.fulfill({
      json: {
        id: employee,
        name: '合成林晓',
        code: 'DEMO-001',
        gender: '女',
        email: 'lin@example.com',
        revision: 1,
      },
    }),
  );
  await profileFixtures(page);
}

test('AC-FE-R1b-03 切换身份，列表筛选、列设置、档案三个页签与注释正常渲染', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await staffFixtures(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/staff');
  await page.getByLabel('切换演示身份').selectOption(user);
  await expect(page.getByRole('button', { name: '合成林晓', exact: true })).toBeVisible();
  await page.screenshot({ path: '../../.demo/fe-r1b-list.png' });
  await page.getByRole('button', { name: '高级筛选', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '高级筛选' })).toBeVisible();
  await page.getByRole('dialog', { name: '高级筛选' }).getByLabel('员工姓名（精确）').fill('不存在');
  await page.getByRole('button', { name: /^确\s*定$/ }).click();
  await expect(page.getByRole('button', { name: '合成林晓', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '重置筛选', exact: true }).click();
  await page.getByRole('button', { name: '列设置', exact: true }).click();
  await page.getByRole('checkbox', { name: '性别', exact: true }).uncheck();
  await page.getByRole('button', { name: /^确\s*定$/ }).click();
  await expect(page.getByRole('columnheader', { name: '性别', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '合成林晓', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '员工档案' })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('lin@example.com');
  await page.screenshot({ path: '../../.demo/fe-r1b-detail.png' });
  await page.getByRole('tab', { name: '任职记录', exact: true }).click();
  await expect(page.getByText('当前生效', { exact: true })).toBeVisible();
  await expect(page.getByText('2024-01-01 → 2026-09-30', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '人员子集', exact: true }).click();
  await expect(page.getByText('合成示例大学', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('switch', { name: '注释' }).click();
  await expect(page.getByText('DEC-108', { exact: true }).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('AC-FE-R1b-04 隐藏字段不显示，详情失败不回退列表快照', async ({ page }) => {
  await staffFixtures(page);
  await page.route('**/permission/me/objects/TenantBase.EmployeeInformation', (route) =>
    route.fulfill({
      json: {
        objectCode: 'TenantBase.EmployeeInformation',
        dataOperations: { view: true },
        viewableFields: ['name'],
        editableFields: [],
        buttons: [],
      },
    }),
  );
  await page.route(`**/personnel/employees/${employee}`, (route) =>
    route.fulfill({
      status: 404,
      json: { error: { code: 'NOT_FOUND' } },
    }),
  );
  await page.goto('/staff');
  await page.getByLabel('切换演示身份').selectOption(user);
  await expect(page.getByRole('columnheader', { name: '性别', exact: true })).toHaveCount(0);
  await expect(page.getByText('DEMO-001', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '合成林晓', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('页面或记录不存在');
  await expect(page.getByRole('dialog')).not.toContainText('lin@example.com');
});

async function profileFixtures(page: Page) {
  await page.route('**/employment/employees/*/records?*', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: 'record-first',
            kind: 'hire',
            staffId: 'cycle-a',
            effectiveDate: '2024-01-01',
            stopDate: '2026-09-30',
            isCurrent: false,
            status: 'effective',
            fields: { departmentId: 'org-a' },
          },
          {
            id: 'record-second',
            kind: 'transfer',
            staffId: 'cycle-a',
            effectiveDate: '2026-10-01',
            stopDate: '9999-12-31',
            isCurrent: true,
            status: 'effective',
            fields: { departmentId: 'org-b' },
          },
        ],
      },
    }),
  );
  await page.route('**/personnel/employees/*/subsets/*?*', (route) =>
    route.fulfill({
      json: {
        items: route.request().url().includes('/education?') ? [{ id: 'edu-a', school: '合成示例大学' }] : [],
      },
    }),
  );
}

test('AC-FE-R1b-07 子集导航按对象权限隐藏，不请求无权限子集', async ({ page }) => {
  await staffFixtures(page);
  await page.route('**/permission/me/objects/TenantBase.Education', (route) =>
    route.fulfill({
      status: 403,
      json: { error: { code: 'FORBIDDEN' } },
    }),
  );
  const educationRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/subsets/education')) educationRequests.push(request.url());
  });
  await page.goto('/staff');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.getByRole('button', { name: '合成林晓', exact: true }).click();
  await page.getByRole('tab', { name: '人员子集', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '人员子集' })).toBeVisible();
  await expect(page.getByRole('button', { name: '教育经历', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '培训经历', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: '人员子集' })).toContainText('暂无子集记录');
  expect(educationRequests).toEqual([]);
});
