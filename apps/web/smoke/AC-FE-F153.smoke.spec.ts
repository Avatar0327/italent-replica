import { test, expect, user, employee } from './fixtures.js';
import type { Page } from '@playwright/test';

// F-153（DEC-511，W-870）：他人调动申请暂存按人一份——重选同一人自动带出、横幅可“点击清除”；我的申请不再列暂存单。
test.use({ viewport: { width: 1440, height: 900 } });

const draftId = '60000000-0000-4000-8000-000000000001';
const receipt = { id: draftId, revision: 1, employeeRevision: 4, status: 'draft' };
// GET /api/tenant/employment/businesses/:id 的真实形状（read-model.ts）；fields 为完整预置字段快照。
const business = {
  ...receipt,
  employeeId: employee,
  kind: 'transfer',
  changeType: 'position_adjustment',
  mode: 'application',
  formId: 'hr',
  effectiveDate: '2026-10-20',
  fields: { place: '暂存工作地', departmentId: null },
  customFields: {},
  employeeStatus: 'employed',
  entryStatus: null,
  record: null,
  activation: null,
};
// GET /transfers/:id/linkage：options 只含可见联动项（visibleOptions）。
const linkage = {
  businessId: draftId,
  revision: 1,
  options: { adjustSalary: true },
  executedAt: null,
  contract: null,
  salaryReminder: null,
};
const linkageFields = ['effectiveDate', 'transferTypeCode', 'reasonCode', 'adjustSalary', 'withEstablishment'];
const button = (label: string) => new RegExp(`^${label.split('').join('\\s*')}$`);

test.beforeEach(async ({ page }) => {
  await page.route('**/permission/me/objects/TenantBase.EmploymentRecord', (route) =>
    route.fulfill({
      json: {
        objectCode: 'TenantBase.EmploymentRecord',
        dataOperations: { read: true, create: true },
        viewableFields: ['name', 'place'],
        editableFields: ['place'],
        buttons: [{ buttonCode: 'Transfer.Hr', level: 'detail' }],
      },
    }),
  );
  await page.route('**/api/tenant/approval/**', (route) => route.fulfill({ json: { items: [] } }));
  await page.route('**/employment/transfers/catalog**', (route) =>
    route.fulfill({
      json: {
        today: '2026-10-12',
        types: [{ code: 'transfer', name: '部门间调动', formId: 'hr' }],
        reasons: [],
        viewableFields: linkageFields,
        editableFields: linkageFields,
      },
    }),
  );
  await page.route('**/employment/employees?**', (route) =>
    route.fulfill({ json: { items: [{ id: employee, name: '合成员工', code: 'DEMO-001', revision: 3 }] } }),
  );
  await page.route('**/transfers/employees/*/preview', (route) =>
    route.fulfill({
      json: {
        employeeRevision: 4,
        allowDirectTransfer: true,
        allowedActions: { application: true, directList: true },
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

interface Backend {
  reads: number;
  creates: Record<string, unknown>[];
}
async function backend(page: Page, read: (route: Parameters<Parameters<Page['route']>[1]>[0]) => Promise<void>) {
  const state: Backend = { reads: 0, creates: [] };
  await page.route('**/employment/businesses/' + draftId, (route) => {
    state.reads++;
    return read(route);
  });
  await page.route('**/transfers/' + draftId + '/linkage', (route) => route.fulfill({ json: linkage }));
  await page.route('**/transfers/employees/' + employee, (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    state.creates.push(body);
    return route.fulfill({ json: body.submit ? { ...receipt, revision: 2, status: 'in_review' } : receipt });
  });
  return state;
}
async function openTransfer(page: Page) {
  await page.goto('/transfer');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.waitForURL('**/staff');
  await page.goto('/transfer');
  await expect(page.locator('.hr-transfer-page').first()).toBeVisible({ timeout: 15_000 });
}
async function pick(page: Page, entry = '他人调动申请') {
  await page.getByRole('button', { name: button(entry) }).click();
  await page.locator('select[name="employeeId"]').selectOption(employee);
  await expect(page.locator('input[name="place"]')).toBeVisible();
}
async function back(page: Page) {
  await page.getByRole('button', { name: '返回调动管理', exact: true }).click();
}
async function stash(page: Page) {
  await openTransfer(page);
  await pick(page);
  await page.getByRole('button', { name: '暂存', exact: true }).click();
  // 只等“暂存成功”出现，原站文案单独断言（AC-FE-F153-07 末尾），使各用例按行为判红绿。
  const notice = page.getByText(/暂存成功/).first();
  await expect(notice).toBeVisible();
  const text = await notice.textContent();
  await back(page);
  return text;
}
// 横幅为“提示文字 + 点击清除”同一段落，按状态区域定位。
const banner = (page: Page) => page.getByRole('status').filter({ hasText: '已带出上次暂存信息' });
const salary = (page: Page, value: 'true' | 'false') => page.locator(`input[name="adjustSalary"][value="${value}"]`);

test('AC-FE-F153-07 暂存后重选同一人自动带出，提交按带出内容发送并不再带出', async ({ page }) => {
  const state = await backend(page, (route) => route.fulfill({ json: business }));
  const notice = await stash(page);
  expect(state.creates[0]).toMatchObject({ submit: false, mode: 'application' });
  await pick(page);
  await expect(page.locator('input[name="place"]')).toHaveValue('暂存工作地');
  await expect(banner(page)).toBeVisible();
  await expect(page.getByRole('button', { name: '点击清除', exact: true })).toBeVisible();
  await expect(page.locator('input[name="effectiveDate"]')).toHaveValue('2026-10-20');
  await expect(salary(page, 'true')).toBeChecked();
  await page.getByRole('button', { name: '提交', exact: true }).click();
  await expect.poll(() => state.creates.length).toBe(2);
  expect(state.creates[1]).toMatchObject({
    submit: true,
    effectiveDate: '2026-10-20',
    transferTypeCode: 'transfer',
    fields: { place: '暂存工作地' },
    linkage: { adjustSalary: true },
  });
  await back(page);
  await pick(page);
  await expect(banner(page)).toHaveCount(0);
  await expect(page.locator('input[name="place"]')).toHaveValue('合成工作地');
  expect(state.reads).toBe(1);
  expect(notice).toBe('信息暂存成功，下次选择此人可自动带出');
});

test('AC-FE-F153-08 点击清除回到空白表单并保留所选人员；再选此人不再带出', async ({ page }) => {
  const state = await backend(page, (route) => route.fulfill({ json: business }));
  await stash(page);
  await pick(page);
  await expect(page.locator('input[name="place"]')).toHaveValue('暂存工作地');
  await page.getByRole('button', { name: '点击清除', exact: true }).click();
  await expect(banner(page)).toHaveCount(0);
  await expect(page.locator('select[name="employeeId"]')).toHaveValue(employee);
  await expect(page.locator('input[name="place"]')).toHaveValue('合成工作地');
  await expect(page.locator('input[name="effectiveDate"]')).toHaveValue('2026-10-12');
  await expect(salary(page, 'false')).toBeChecked();
  await back(page);
  await pick(page);
  await expect(banner(page)).toHaveCount(0);
  expect(state.reads).toBe(1);
});

test('AC-FE-F153-09 我的申请不再列出本会话暂存单', async ({ page }) => {
  await backend(page, (route) => route.fulfill({ json: business }));
  await stash(page);
  await page.goto('/approval');
  await page.getByRole('button', { name: '应用导航' }).click();
  await page.getByRole('dialog', { name: '全部菜单' }).getByRole('link', { name: '审批中心', exact: true }).click();
  await page.getByRole('menuitem', { name: '我的申请', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的申请', exact: true })).toBeVisible();
  await expect(page.getByText('本会话暂存单', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /查看暂存申请/ })).toHaveCount(0);
});

test('AC-FE-F153-10 暂存已不是草稿（他处已提交）时不带出，也不再回查', async ({ page }) => {
  const state = await backend(page, (route) => route.fulfill({ json: { ...business, status: 'in_review' } }));
  await stash(page);
  await pick(page);
  await expect.poll(() => state.reads).toBe(1);
  await expect(banner(page)).toHaveCount(0);
  await expect(page.locator('input[name="place"]')).toHaveValue('合成工作地');
  await back(page);
  await pick(page);
  await expect(page.locator('input[name="place"]')).toHaveValue('合成工作地');
  expect(state.reads).toBe(1);
});

test('AC-FE-F153-11 读取暂存失败（403）提示未带出，表单为空白且仍可暂存', async ({ page }) => {
  const state = await backend(page, (route) =>
    route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN', message: '无权查看' } } }),
  );
  await stash(page);
  await pick(page);
  await expect(page.getByText('上次暂存信息读取失败，未带出，可直接填写', { exact: true })).toBeVisible();
  await expect(banner(page)).toHaveCount(0);
  await expect(page.locator('input[name="place"]')).toHaveValue('合成工作地');
  await expect(page.locator('input[name="effectiveDate"]')).toHaveValue('2026-10-12');
  await expect(page.getByRole('button', { name: '暂存', exact: true })).toBeEnabled();
  expect(state.reads).toBe(1);
});

test('AC-FE-F153-12 “调动”入口（直接调动）没有暂存，选同一人不带出暂存', async ({ page }) => {
  const state = await backend(page, (route) => route.fulfill({ json: business }));
  await stash(page);
  await pick(page, '调动');
  await expect(banner(page)).toHaveCount(0);
  await expect(page.locator('input[name="place"]')).toHaveValue('合成工作地');
  expect(state.reads).toBe(0);
});
