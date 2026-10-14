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
  await openColumnSettings(page);
  await page.getByRole('checkbox', { name: '性别', exact: true }).uncheck();
  await page.getByRole('dialog', { name: '设置显示字段' }).getByRole('button', { name: /^确\s*定$/ }).click();
  await expect(page.getByRole('columnheader', { name: '性别', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '合成林晓', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '员工档案' })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('lin@example.com');
  await expect(page.locator('.detail-drawer .ant-drawer-content-wrapper')).toHaveCSS('transform', 'none');
  await page.screenshot({ path: '../../.demo/fe-r1b-detail.png' });
  await expect(page.getByRole('tab', { name: '人员信息', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('合成示例大学', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '任职记录', exact: true }).click();
  await expect(page.getByText('生效中', { exact: true })).toBeVisible();
  await expect(page.getByText('2024-01-01 至 2026-09-30', { exact: true })).toBeVisible();
  await expect(page.getByText('2026-10-01 至今', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('switch', { name: '注释' }).click();
  await expect(page.getByText('DEC-108', { exact: true }).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('AC-FE-R1b-03b 列设置勾选在点击事件内同步生效，同一帧连续点击不丢操作', async ({ page }) => {
  await staffFixtures(page);
  await page.goto('/staff');
  await page.getByLabel('切换演示身份').selectOption(user);
  await expect(page.getByRole('button', { name: '合成林晓', exact: true })).toBeVisible();
  await openColumnSettings(page);
  const gender = page.getByRole('checkbox', { name: '性别', exact: true });
  const email = page.getByRole('checkbox', { name: '电子邮件', exact: true });
  await expect(gender).toBeChecked();
  await expect(email).toBeChecked();
  // 同一个任务里连点两项、立刻读状态：不能等到下一轮调度才反映，也不能用旧状态覆盖前一次点击。
  const states = await page.evaluate(() => {
    const input = (value: string) => document.querySelector<HTMLInputElement>(`input[value="${value}"]`)!;
    input('gender').click();
    const afterFirst = input('gender').checked;
    input('email').click();
    return { afterFirst, gender: input('gender').checked, email: input('email').checked };
  });
  expect(states).toEqual({ afterFirst: false, gender: false, email: false });
  await page.getByRole('dialog', { name: '设置显示字段' }).getByRole('button', { name: /^确\s*定$/ }).click();
  await expect(page.getByRole('columnheader', { name: '性别', exact: true })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: '电子邮件', exact: true })).toHaveCount(0);
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

async function openColumnSettings(page: Page) {
  // 原站：表头右侧齿轮 → “设置显示字段” → 居中双栏弹窗
  await page.getByRole('button', { name: '列设置', exact: true }).click();
  await page.getByRole('button', { name: '设置显示字段', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '设置显示字段' })).toBeVisible();
}

test('AC-FE-R1b-03c 设置显示字段：居中双栏、姓名锁定、拖拽排序与恢复默认', async ({ page }) => {
  await staffFixtures(page);
  await page.goto('/staff');
  await page.getByLabel('切换演示身份').selectOption(user);
  await expect(page.getByRole('button', { name: '合成林晓', exact: true })).toBeVisible();
  await openColumnSettings(page);
  const dialog = page.getByRole('dialog', { name: '设置显示字段' });
  await expect(page.locator('.staff-columns-modal .ant-modal')).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: '员工姓名', exact: true })).toBeDisabled();
  const selected = dialog.getByRole('list', { name: '已选字段' });
  await expect(dialog.getByText('已选字段 6/7', { exact: true })).toBeVisible();
  await expect(selected.getByRole('listitem')).toHaveText(['员工姓名', '员工ID', '性别', '人员状态', '入职日期', '电子邮件']);
  await expect(selected.getByRole('listitem').first()).toHaveAttribute('draggable', 'false');
  await selected.getByRole('listitem', { name: '入职日期' }).dragTo(selected.getByRole('listitem', { name: '员工ID' }));
  await expect(selected.getByRole('listitem')).toHaveText(['员工姓名', '入职日期', '员工ID', '性别', '人员状态', '电子邮件']);
  await dialog.getByRole('checkbox', { name: '性别', exact: true }).uncheck();
  await expect(dialog.getByText('已选字段 5/7', { exact: true })).toBeVisible();
  await dialog.getByRole('searchbox', { name: '搜索字段' }).fill('日期');
  await expect(dialog.getByRole('checkbox', { name: '员工ID', exact: true })).toHaveCount(0);
  await dialog.getByRole('searchbox', { name: '搜索字段' }).fill('');
  await dialog.getByRole('button', { name: /^确\s*定$/ }).click();
  await expect(page.getByRole('columnheader')).toHaveText(['员工姓名', '入职日期', '员工ID', '人员状态', '电子邮件', '']);
  await openColumnSettings(page);
  await dialog.getByRole('button', { name: '恢复默认', exact: true }).click();
  await expect(selected.getByRole('listitem')).toHaveText(['员工姓名', '员工ID', '性别', '人员状态', '入职日期', '电子邮件']);
  await dialog.getByRole('button', { name: /^取\s*消$/ }).click();
  await expect(page.getByRole('columnheader', { name: '性别', exact: true })).toHaveCount(0);
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
  const nav = page.getByRole('navigation', { name: '档案导航' });
  await expect(nav).toBeVisible();
  await expect(nav.getByRole('button', { name: '教育经历', exact: true })).toHaveCount(0);
  await nav.getByRole('button', { name: '培训经历', exact: true }).click();
  await expect(page.getByRole('region', { name: '培训经历' })).toContainText('暂无培训经历');
  expect(educationRequests).toEqual([]);
});

test('AC-FE-R1b-08 翻页后应用筛选回到第一页，取消筛选保持原查询', async ({ page }) => {
  await staffFixtures(page);
  const queries: string[] = [];
  await page.route('**/personnel/employees?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    queries.push(query.toString());
    return route.fulfill({
      json: {
        items: Array.from({ length: 15 }, (_, i) => ({
          id: `row-${query.get('page')}-${i}`,
          name: `合成员工${query.get('page')}-${i}`,
        })),
      },
    });
  });
  await page.goto('/staff');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.getByRole('button', { name: '合成员工2-0', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '高级筛选', exact: true }).click();
  await page.getByRole('dialog').getByLabel('员工姓名（精确）').fill('未应用');
  await page.getByRole('button', { name: /^取\s*消$/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(queries.at(-1)).toBe('page=2&pageSize=15');
  await page.getByRole('button', { name: '高级筛选', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('员工姓名（精确）')).toHaveValue('');
  await page.getByRole('dialog').getByLabel('员工姓名（精确）').fill('合成员工');
  await page.getByRole('button', { name: /^确\s*定$/ }).click();
  await expect(page.getByRole('button', { name: '合成员工1-0', exact: true })).toBeVisible();
  expect(new URLSearchParams(queries.at(-1)).get('page')).toBe('1');
  expect(new URLSearchParams(queries.at(-1)).get('employeeName')).toBe('合成员工');
  await expect(page.locator('.page-total')).toHaveCount(0);
});

test('AC-FE-R1b-09 查看档案后切换演示身份清除旧档案，使用新身份字段权限', async ({ page }) => {
  await staffFixtures(page);
  const restricted = '20000000-0000-4000-8000-000000000002';
  await page.route('**/__demo/personas', (route) =>
    route.fulfill({
      json: {
        tenantId: '10000000-0000-4000-8000-000000000001',
        current: route.request().headers().cookie?.includes(restricted) ? restricted : user,
        personas: [
          { userId: user, name: '合成演示用户', role: '演示身份', entry: '/staff' },
          { userId: restricted, name: '合成受限用户', role: '演示身份', entry: '/staff' },
        ],
      },
    }),
  );
  await page.route('**/permission/me/objects/TenantBase.EmployeeInformation', (route) =>
    route.fulfill({
      json: {
        objectCode: 'TenantBase.EmployeeInformation',
        dataOperations: { view: true },
        viewableFields: route.request().headers().cookie?.includes(restricted) ? ['name'] : fields,
        editableFields: [],
        buttons: [],
      },
    }),
  );
  await page.goto('/staff');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.getByRole('button', { name: '合成林晓', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('lin@example.com');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByLabel('切换演示身份').selectOption(restricted);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '合成林晓', exact: true })).toBeVisible();
  await expect(page.getByText('DEMO-001', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '合成林晓', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toContainText('lin@example.com');
});
