import { test, expect, user, employee } from './fixtures.js';
import type { Page } from '@playwright/test';

const instance = '40000000-0000-4000-8000-000000000001';
const task = '50000000-0000-4000-8000-000000000001';
test.beforeEach(async ({ page }) => {
  await page.route('**/permission/me/objects/TenantBase.EmploymentRecord', (route) =>
    route.fulfill({
      json: {
        objectCode: 'TenantBase.EmploymentRecord',
        dataOperations: { read: true },
        viewableFields: ['name'],
        editableFields: [],
        buttons: [{ buttonCode: 'Transfer.Hr', level: 'detail' }],
      },
    }),
  );
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
  await transferFixtures(page);
});

test('AC-FE-R1c-03 调动列表、表单、我的申请与注释', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await switchIdentity(page, '/transfer');
  await expect(page.getByRole('heading', { name: '调动管理', exact: true })).toBeVisible();
  await expect(page.getByText('演示数据', { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('transfer-list.png'), fullPage: true });
  await page.getByRole('button', { name: '林晓（合成）', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('企业服务事业部');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '他人调动申请', exact: true }).click();
  await page.locator('select[name="employeeId"]').selectOption(employee);
  await expect(page.locator('input[name="place"]')).toBeVisible();
  await expect(page.getByRole('button', { name: /提\s*交/, exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('transfer-form.png'), fullPage: true });
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('tab', { name: '我的申请', exact: true }).click();
  await page.getByRole('button', { name: '合成员工的调动申请', exact: true }).click();
  await expect(page.getByText('合成工作地', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('AC-FE-R1c-04 审批中心三个页签、详情与操作弹窗', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await switchIdentity(page, '/approval');
  await expect(page.getByRole('heading', { name: '审批中心', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('approval-list.png'), fullPage: true });
  await page.getByRole('button', { name: '合成员工的调动申请', exact: true }).click();
  await expect(page.getByText('原工作地', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('approval-detail.png'), fullPage: true });
  for (const action of ['同意', '驳回', '转交', '撤销']) {
    await page.getByRole('button', { name: new RegExp(action.split('').join('\\s*')), exact: true }).click();
    await expect(page.getByRole('dialog').last()).toBeVisible();
    await page.getByRole('button', { name: /取\s*消/, exact: true }).click();
  }
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('tab', { name: '已办', exact: true }).click();
  await expect(page.getByText('演示数据', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '合成员工林晓的调动申请', exact: true }).click();
  await expect(page.getByText('审批已通过，业务是否生效以业务申请单为准。')).toBeVisible();
  await expect(page.getByRole('button', { name: /同\s*意/, exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('tab', { name: '我发起', exact: true }).click();
  await expect(page.getByRole('button', { name: '合成员工的调动申请', exact: true })).toBeVisible();
  await page.getByRole('switch', { name: '注释' }).click();
  await expect(page.getByText('DEC-057', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

for (const [label, action] of [
  ['同意', 'approve'],
  ['驳回', 'reject'],
  ['转交', 'transfer'],
  ['撤销', 'withdraw'],
]) {
  test(`AC-FE-R1c-06 ${label} 使用真实命令协议并重新读取列表`, async ({ page }) => {
    const requests: { path: string; body: unknown; revision?: string; command?: string }[] = [];
    await page.route(`**/api/tenant/approval/**/${action}`, (route) => {
      requests.push({
        path: new URL(route.request().url()).pathname,
        body: route.request().postDataJSON(),
        revision: route.request().headers()['if-match'],
        command: route.request().headers()['idempotency-key'],
      });
      return route.fulfill({ json: { instanceId: instance, status: 'approved' } });
    });
    await switchIdentity(page, '/approval');
    await page.getByRole('button', { name: '合成员工的调动申请', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(label!.split('').join('\\s*')), exact: true }).click();
    if (action === 'transfer') await page.getByLabel('转交给（账号编号）').fill(user);
    await page.getByRole('button', { name: /保\s*存/, exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.revision).toBe('4');
    expect(requests[0]?.command).toMatch(/^[\da-f-]{36}$/);
    expect(requests[0]?.path).toBe(
      `/api/tenant/approval/${action === 'withdraw' ? `instances/${instance}` : `tasks/${task}`}/${action}`,
    );
    expect(requests[0]?.body).toEqual(
      action === 'withdraw' ? {} : { comment: null, ...(action === 'transfer' ? { toUserId: user } : {}) },
    );
  });
}

test('AC-FE-R1c-07 结果未知后禁止盲重提，关闭后必须主动回查', async ({ page }) => {
  let writes = 0;
  await page.route('**/api/tenant/approval/tasks/*/approve', (route) => {
    writes++;
    return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE' } } });
  });
  await switchIdentity(page, '/approval');
  await page.getByRole('button', { name: '合成员工的调动申请', exact: true }).click();
  await page.getByRole('button', { name: /同\s*意/, exact: true }).click();
  await page.getByRole('button', { name: /保\s*存/, exact: true }).click();
  await expect(page.getByText('请关闭操作框并重新读取详情，核对本次操作结果后再决定是否重提。').first()).toBeVisible();
  await page.getByRole('button', { name: /保\s*存/, exact: true }).click();
  expect(writes).toBe(1);
  await page.getByRole('button', { name: /取\s*消/, exact: true }).click();
  await expect(page.getByRole('button', { name: /同\s*意/, exact: true })).toBeDisabled();
  await page.getByRole('dialog').getByRole('button', { name: '重新读取', exact: true }).click();
  await expect(page.getByRole('button', { name: /同\s*意/, exact: true })).toBeEnabled();
});

test('AC-FE-R1c-08 撤权隐藏发起按钮，审批字段与记录按返回值裁剪', async ({ page }) => {
  await page.route('**/permission/me/objects/TenantBase.EmploymentRecord', (route) =>
    route.fulfill({
      json: {
        objectCode: 'TenantBase.EmploymentRecord',
        dataOperations: { read: true },
        viewableFields: [],
        editableFields: [],
        buttons: [],
      },
    }),
  );
  await switchIdentity(page, '/transfer');
  await expect(page.getByRole('heading', { name: '调动管理', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '他人调动申请', exact: true })).toHaveCount(0);
  await page.route(`**/approval/instances/${instance}`, (route) =>
    route.fulfill({
      json: {
        id: instance,
        title: '裁剪后的申请',
        revision: 1,
        status: 'running',
        approvalType: 'transfer',
        actions: ['transfer'],
        recordsHidden: true,
        form: { values: {} },
        tasks: [],
        logs: [],
      },
    }),
  );
  await page.goto('/approval');
  await page.getByRole('button', { name: '合成员工的调动申请', exact: true }).click();
  await expect(page.getByRole('button', { name: /同\s*意/, exact: true })).toHaveCount(0);
  await expect(page.getByText('合成工作地', { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: '审批记录', exact: true }).click();
  await expect(page.getByText('根据流程设置，当前查看人不可查看审批记录。')).toBeVisible();
});

async function transferFixtures(page: Page) {
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
}

async function switchIdentity(page: Page, path: string) {
  await page.goto(path);
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.waitForURL('**/staff');
  await page.goto(path);
  await expect(page.locator('.shell-workspace h1').first()).toBeVisible({ timeout: 15_000 });
}

test('AC-FE-R1c-10 参考包视图切换、主题密度与右侧详情抽屉', async ({ page }) => {
  await switchIdentity(page, '/transfer');
  await expect(page.locator('.ant-breadcrumb')).toBeHidden();
  const view = page.getByRole('button', { name: '调动中员工', exact: true });
  await expect(view).toBeVisible();
  await view.click();
  await page.getByRole('menuitem', { name: '全部调动记录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '全部调动记录', exact: true })).toBeVisible();
  const launch = page.getByRole('button', { name: '他人调动申请', exact: true });
  await expect(launch).toHaveCSS('background-color', 'rgb(20, 110, 255)');
  await expect(launch).toHaveCSS('height', '32px');
  await expect(page.locator('.ant-table-thead > tr')).toHaveCSS('height', '40px');
  await expect(page.locator('.ant-pagination-options')).toContainText('15');
  await page.getByRole('button', { name: '林晓（合成）', exact: true }).click();
  await expect(page.locator('.ant-drawer-right')).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  const pending = page.waitForRequest((request) => request.url().includes('/approval/todos?'));
  await page.goto('/approval');
  expect(new URL((await pending).url()).searchParams.get('pageSize')).toBe('15');
  await expect(page.locator('.ant-breadcrumb')).toBeHidden();
  await expect(page.getByRole('tablist')).toHaveAttribute('aria-orientation', 'vertical');
  await page.getByRole('tab', { name: '已处理', exact: true }).click();
  await expect(page.getByRole('heading', { name: '已处理', exact: true })).toBeVisible();
});
