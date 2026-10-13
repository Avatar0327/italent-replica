import { test, expect, user, employee, tenant } from './fixtures.js';

const recordId = '50000000-0000-4000-8000-000000000001';

// 只使用合成数据；接口结构来自现有后端。页面路径沿用 FE-0 的自助与经理应用入口。
const record = {
  id: recordId,
  kind: 'hire',
  effectiveDate: '2026-10-01',
  stopDate: null,
  approvalStatus: 'effective',
  fields: { departmentId: '60000000-0000-4000-8000-000000000001' },
  fieldLabels: { departmentId: '合成研发部' },
};
const ownProfile = {
  employee: { id: employee, name: '合成员工', code: 'DEMO-001', revision: 1 },
  timezone: 'Asia/Shanghai',
  today: '2026-10-13',
  record,
};
test.beforeEach(async ({ page }) => {
  await page.route('**/api/tenant/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/tenant/self-service/profile': ownProfile,
      [`/api/tenant/self-service/employees/${employee}/records`]: { items: [record] },
      '/api/tenant/self-service/applications': {
        items: [
          {
            id: recordId,
            businessId: recordId,
            revision: 1,
            title: '合成本人调动申请',
            category: '人事变动',
            initiator: '合成员工',
            status: 'in_review',
            currentHandlers: ['合成审批人'],
            reason: '合成申请理由',
            createdAt: '2026-10-13T01:00:00.000Z',
          },
        ],
      },
      [`/api/tenant/self-service/applications/${recordId}`]: { status: 'in_review', record },
      '/api/tenant/employment/transfers/manager/team': {
        items: [{ id: employee, name: '合成团队成员', code: 'DEMO-002', display: { departmentId: '合成研发部' } }],
        counts: { active: 1, probation: 0, intern: 0, pending: 0, leaving: 0 },
      },
      '/api/tenant/employment/transfers/manager/todos': {
        items: [
          {
            taskId: recordId,
            instanceId: recordId,
            title: '合成经理待办',
            nodeName: '经理审批',
            approvalType: 'employment',
            nodeKey: 'manager',
            isExceptionAdmin: false,
            origin: 'normal',
            createdAt: '2026-10-13T01:00:00.000Z',
          },
        ],
      },
    };
    return Object.hasOwn(responses, path) ? route.fulfill({ json: responses[path] }) : route.fallback();
  });
});

const pages = [
  { name: '我的档案', path: '/self', content: '合成员工' },
  { name: '人事申请', path: '/self/applications', content: '合成研发部' },
  { name: '团队成员', path: '/manager/team', content: '合成团队成员' },
  { name: '待办', path: '/manager/todos', content: '合成经理待办' },
] as const;

for (const item of pages) {
  test(`AC-FE-R1d-1 页面冒烟：切换演示身份后打开${item.name}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(item.path);
    await page.getByLabel('切换演示身份').selectOption(user);
    await page.waitForURL('**/staff');
    await page.goto(item.path);
    await expect(page.locator('.shell-workspace')).toContainText(item.content);
    await expect(page.locator('.shell-workspace')).not.toContainText('正在加载');
    await expect(page.locator('.ant-breadcrumb')).toHaveCount(0);
    if (item.path !== '/self') await expect(page.locator('.shell-workspace .ant-table')).toBeVisible();
    if (item.path === '/manager/team')
      await expect(page.locator('.ant-table-tbody > tr[data-row-key]').first()).toHaveCSS('height', '40px');
    await page.screenshot({ path: testInfo.outputPath('page.png'), fullPage: true });
    expect(errors).toEqual([]);
  });
}

test.beforeEach(async ({ page, baseURL }) => {
  // 上面的四页用例会先选择身份；其余交互用例以已选择身份开始。
  await page.context().addCookies([{ name: 'italent_demo_tenant', value: tenant, url: baseURL! }]);
});

test('AC-FE-R1d-1 档案、申请、团队、待办详情均为右侧只读抽屉', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/self');
  await page.getByRole('button', { name: '查看详情', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('合成研发部');
  await expect(page.locator('.detail-drawer')).toHaveClass(/ant-drawer-right/);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('switch', { name: '注释' }).click();
  await expect(page.getByText('DEC-470', { exact: true })).toBeVisible();
  await page.goto('/self/requests');
  await page.getByRole('button', { name: '合成本人调动申请', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('合成研发部');
  await expect(page.getByRole('dialog')).not.toContainText('撤回');
  await page.goto('/manager/team');
  await page.getByRole('button', { name: '合成团队成员', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('DEMO-002');
  await expect(page.getByRole('dialog')).not.toContainText('调动');
  await page.goto('/manager/todos');
  await page.getByRole('button', { name: '合成经理待办', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('经理审批');
  await expect(page.getByRole('dialog')).toContainText('待处理');
  await expect(page.getByRole('link', { name: '前往审批中心' })).toHaveAttribute('href', '/approval');
  expect(errors).toEqual([]);
});

test('AC-FE-R1d-1 经理筛选与待办页签传递到服务器，隐藏字段不会变成详情列', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto('/manager/team');
  await expect(page.getByRole('columnheader', { name: '部门', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '高级筛选', exact: true }).click();
  await expect(page.locator('.filter-drawer .ant-drawer-content-wrapper')).toHaveCSS('width', '500px');
  await page.getByRole('dialog').locator('.ant-select-selector').click();
  await page.getByText('试用中', { exact: true }).last().click();
  await page.getByRole('button', { name: '确 定', exact: true }).click();
  await expect.poll(() => requests.some((url) => url.includes('category=probation'))).toBe(true);
  await page.getByRole('searchbox', { name: '姓名 / 工号 / 邮箱', exact: true }).fill('合成&');
  await page.getByRole('searchbox', { name: '姓名 / 工号 / 邮箱', exact: true }).press('Enter');
  await expect.poll(() => requests.some((url) => new URL(url).searchParams.get('search') === '合成&')).toBe(true);
  await page.goto('/manager/todos');
  await page.getByRole('tab', { name: '已处理', exact: true }).click();
  await expect.poll(() => requests.some((url) => url.includes('tab=processed') && url.includes('page=1'))).toBe(true);
  await page.getByRole('tab', { name: '已申请', exact: true }).click();
  await expect.poll(() => requests.some((url) => url.includes('tab=initiated'))).toBe(true);
});

test('AC-FE-R1d-1 无授权不显示本人调动；禁止读取时显示错误而非演示档案', async ({ page }) => {
  await page.goto('/self/applications');
  await expect(page.getByRole('button', { name: '本人调动申请', exact: true })).toHaveCount(0);
  await page.route('**/self-service/profile', (route) =>
    route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN' } } }),
  );
  await page.goto('/self');
  await expect(page.locator('.shell-workspace')).toContainText('暂无访问权限');
  await expect(page.locator('.shell-workspace')).not.toContainText('合成员工');
});

test('AC-FE-R1d-1 本人调动抽屉复用联动与提交，显式字段携带 revision 和命令 ID', async ({ page }, testInfo) => {
  await page.route('**/permission/me/objects/TenantBase.EmploymentRecord', (route) =>
    route.fulfill({
      json: {
        objectCode: 'TenantBase.EmploymentRecord',
        dataOperations: {},
        viewableFields: [],
        editableFields: [],
        buttons: ['Transfer.Self', 'Employment.Create', 'Employment.Submit'].map((buttonCode) => ({
          buttonCode,
          level: 'detail',
        })),
      },
    }),
  );
  const department = '60000000-0000-4000-8000-000000000002';
  const preview = {
    employeeRevision: 7,
    allowDirectTransfer: false,
    allowedActions: { application: true, directList: false, directRow: false },
    fields: { departmentId: department },
    customFields: {},
    before: { fields: record.fields, customFields: {} },
    beforeLabels: record.fieldLabels,
    valueLabels: { departmentId: '合成目标部门' },
    reasons: [],
    form: {
      id: 'demo-self',
      name: '本人调动',
      isStandard: true,
      customFields: [],
      excludedAutofillFields: [],
      fieldModes: { 'preset:departmentId': 'editable' },
    },
  };
  await page.route('**/self-service/transfer/preview', (route) => route.fulfill({ json: preview }));
  await page.route('**/self-service/transfer/references/departmentId?*', (route) =>
    route.fulfill({ json: { items: [{ id: department, name: '合成目标部门' }] } }),
  );
  let submission: { headers: Record<string, string>; body: Record<string, unknown> } | undefined;
  await page.route('**/self-service/transfer', (route) => {
    submission = { headers: route.request().headers(), body: route.request().postDataJSON() };
    return route.fulfill({
      status: 201,
      json: { id: recordId, status: 'in_review', revision: 1, employeeRevision: 7 },
    });
  });
  await page.goto('/self/applications');
  await page.getByRole('button', { name: '本人调动申请', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '本人调动申请', exact: true });
  await expect(drawer.locator('input[name="effectiveDate"]')).toHaveValue('2026-10-13');
  await expect(drawer.locator('select[name="departmentId"]')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('self-form.png') });
  await drawer.locator('select[name="departmentId"]').selectOption('');
  await expect(drawer.getByRole('button', { name: '提交', exact: true })).toBeDisabled();
  await drawer.locator('select[name="departmentId"]').selectOption(department);
  await expect(drawer.getByRole('button', { name: '提交', exact: true })).toBeEnabled();
  await drawer.getByRole('button', { name: '提交', exact: true }).click();
  await expect(page.getByText('申请已提交审批，请在“我的申请”核对。')).toBeVisible();
  expect(submission?.headers['if-match']).toBe('7');
  expect(submission?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  expect(submission?.body).toEqual({
    effectiveDate: '2026-10-13',
    fields: { departmentId: department },
    customFields: {},
  });
});

test('AC-FE-R1d-1 工作台按服务端计数打开成员抽屉，经理只在人事申请入口发起', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.route('**/transfers/manager', (route) =>
    route.fulfill({ json: { canApply: true, canViewReporting: false } }),
  );
  await page.goto('/manager');
  await expect(page.locator('.service-counts')).toContainText('在岗人员1');
  await expect(page.getByText('演示布局，尚未接入业务数据').first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('manager-dashboard.png') });
  await page.getByRole('button', { name: '在岗人员 1' }).click();
  await expect(page.getByRole('dialog')).toContainText('合成团队成员');
  await expect(page.getByRole('dialog')).not.toContainText('他人调动申请');
  await page.goto('/manager/applications');
  await page.getByRole('button', { name: '他人调动申请', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('form', { name: '他人调动申请' })).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('button', { name: '提交', exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('manager-form.png') });
  expect(errors).toEqual([]);
});
