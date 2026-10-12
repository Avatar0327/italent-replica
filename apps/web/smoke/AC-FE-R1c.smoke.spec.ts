import { test, expect, user, employee } from './fixtures.js';

const instance = '40000000-0000-4000-8000-000000000001';
const task = '50000000-0000-4000-8000-000000000001';
test.beforeEach(async ({ page }) => {
  await page.route('**/api/tenant/approval/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/todos'))
      return route.fulfill({
        json: {
          items: [
            {
              taskId: task,
              instanceId: instance,
              title: '合成员工的调动申请',
              nodeName: '部门负责人审批',
              approvalType: 'transfer',
              createdAt: '2026-10-12T01:00:00Z',
            },
          ],
        },
      });
    if (path.endsWith('/instances'))
      return route.fulfill({
        json: {
          items: [
            {
              id: instance,
              title: '合成员工的调动申请',
              status: 'running',
              approvalType: 'transfer',
              revision: 4,
            },
          ],
        },
      });
    return route.fulfill({
      json: {
        id: instance,
        title: '合成员工的调动申请',
        revision: 4,
        status: 'running',
        approvalType: 'transfer',
        actions: ['approve', 'reject', 'transfer', 'withdraw'],
        recordsHidden: false,
        form: { values: { effectiveDate: '2026-11-01', place: '合成工作地' }, originals: { place: '原工作地' } },
        tasks: [{ id: task, nodeName: '部门负责人审批', status: 'pending', assigneeUserId: user }],
        logs: [],
      },
    });
  });
  await page.route('**/employment/transfers/catalog**', (route) =>
    route.fulfill({
      json: {
        today: '2026-10-12',
        types: [{ code: 'transfer', name: '部门间调动', formId: 'hr' }],
        reasons: [],
        viewableFields: ['effectiveDate', 'transferTypeCode', 'reasonCode'],
        editableFields: ['effectiveDate', 'transferTypeCode', 'reasonCode'],
      },
    }),
  );
  await page.route('**/employment/employees?**', (route) =>
    route.fulfill({ json: { items: [{ id: employee, name: '合成员工', code: 'DEMO-001', revision: 3 }] } }),
  );
  await page.route('**/transfers/employees/*/preview', (route) =>
    route.fulfill({
      json: {
        employeeRevision: 3,
        allowDirectTransfer: false,
        allowedActions: { application: true },
        form: {
          id: 'hr',
          name: '调动申请',
          isStandard: true,
          excludedAutofillFields: [],
          fieldModes: { 'preset:place': 'editable' },
          customFields: [],
        },
        fields: { place: '合成工作地' },
        customFields: {},
        before: { fields: { place: '原工作地' }, customFields: {} },
      },
    }),
  );
});

test('AC-FE-R1c-03 调动列表、表单、我的申请与注释', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/transfer');
  await page.getByLabel('切换演示身份').selectOption(user);
  await expect(page.getByRole('heading', { name: '调动管理', exact: true })).toBeVisible();
  await expect(page.getByText('演示数据', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '他人调动申请', exact: true }).click();
  await page.locator('select[name="employeeId"]').selectOption(employee);
  await expect(page.locator('input[name="place"]')).toBeVisible();
  await expect(page.getByRole('button', { name: '提交', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('tab', { name: '我的申请', exact: true }).click();
  await page.getByRole('button', { name: '合成员工的调动申请', exact: true }).click();
  await expect(page.getByText('合成工作地', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('AC-FE-R1c-04 审批中心三个页签、详情与操作弹窗', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/approval');
  await page.getByLabel('切换演示身份').selectOption(user);
  await expect(page.getByRole('heading', { name: '审批中心', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '合成员工的调动申请', exact: true }).click();
  await expect(page.getByText('原工作地', { exact: true })).toBeVisible();
  for (const action of ['同意', '驳回', '转交', '撤销']) {
    await page.getByRole('button', { name: action, exact: true }).click();
    await expect(page.getByRole('dialog').last()).toBeVisible();
    await page.getByRole('button', { name: '取消', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('tab', { name: '已办', exact: true }).click();
  await expect(page.getByText('演示数据', { exact: true }).first()).toBeVisible();
  await page.getByRole('tab', { name: '我发起', exact: true }).click();
  await expect(page.getByRole('button', { name: '合成员工的调动申请', exact: true })).toBeVisible();
  await page.getByRole('switch', { name: '注释' }).click();
  await expect(page.getByText('DEC-057', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
