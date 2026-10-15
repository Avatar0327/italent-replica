import type { Page } from '@playwright/test';
import { test, expect, employee, tenant, selfServiceButtons } from './fixtures.js';

const business = '50000000-0000-4000-8000-000000000002';
const department = '60000000-0000-4000-8000-000000000002';
const preview = {
  employeeRevision: 7,
  allowDirectTransfer: false,
  allowedActions: { application: true, directList: false, directRow: false },
  fields: { departmentId: department },
  customFields: {},
  before: null,
  beforeLabels: {},
  valueLabels: { departmentId: '合成目标部门' },
  reasons: [],
  form: {
    id: 'demo-form',
    name: '调动',
    isStandard: true,
    excludedAutofillFields: [],
    customFields: [],
    fieldModes: { 'preset:departmentId': 'editable' },
  },
};
const draft = {
  id: business,
  employeeId: employee,
  revision: 4,
  employeeRevision: 7,
  status: 'draft',
  effectiveDate: '2026-11-02',
  fields: { departmentId: department, isKeyPerson: false },
  customFields: { synthetic_note: '合成草稿备注' },
};
async function openForm(page: Page, manager: boolean) {
  await page.getByRole('button', { name: manager ? '他人调动申请' : '本人调动申请', exact: true }).click();
  return page.getByRole('dialog');
}
async function setup(page: Page, manager: boolean) {
  await page.route('**/api/tenant/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/permission/me/objects/TenantBase.EmploymentRecord'))
      return route.fulfill({
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
      });
    if (path.endsWith('/self-service/profile'))
      return route.fulfill({
        json: {
          selfServiceButtons,
          employee: { id: employee, name: '合成申请人', code: 'DEMO-001', revision: 7 },
          timezone: 'Asia/Shanghai',
          today: '2026-10-13',
          record: null,
        },
      });
    if (path.endsWith('/transfers/manager'))
      return route.fulfill({ json: { canApply: true, canViewReporting: false } });
    if (path.endsWith('/transfers/catalog'))
      return route.fulfill({
        json: {
          today: '2026-10-13',
          types: [{ code: 'across_department', name: '跨部门调动', formId: 'demo-form' }],
          reasons: [],
        },
      });
    if (path.endsWith('/manager/employees'))
      return route.fulfill({
        json: {
          items: [{ id: employee, name: '合成申请人', code: 'DEMO-001', revision: 7 }],
        },
      });
    if (path.endsWith('/preview')) return route.fulfill({ json: preview });
    if (path.includes('/references/departmentId'))
      return route.fulfill({ json: { items: [{ id: department, name: '合成目标部门' }] } });
    return route.fallback();
  });
  await page.goto(manager ? '/manager/applications' : '/self/applications');
  const drawer = await openForm(page, manager);
  if (manager) await drawer.locator('select[name="employeeId"]').selectOption(employee);
  await expect(drawer.getByRole('button', { name: '提交', exact: true })).toBeEnabled();
  return drawer;
}
test.beforeEach(async ({ page, baseURL }) => {
  await page.context().addCookies([{ name: 'italent_demo_tenant', value: tenant, url: baseURL! }]);
});

for (const entry of [
  { manager: false, action: '提交', path: '**/self-service/transfer' },
  { manager: true, action: '提交', path: `**/transfers/employees/${employee}` },
  { manager: true, action: '暂存', path: `**/transfers/employees/${employee}` },
]) {
  test(`AC-FE-R1d-2 ${entry.manager ? '经理' : '本人'}${entry.action}未确认关闭重开仍只读锁定`, async ({ page }) => {
    let command = '';
    let writes = 0;
    await page.route(entry.path, (route) => {
      writes++;
      command = route.request().headers()['idempotency-key']!;
      return route.abort('failed');
    });
    const drawer = await setup(page, entry.manager);
    await drawer.getByRole('button', { name: entry.action, exact: true }).click();
    await expect.poll(() => writes).toBe(1);
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await openForm(page, entry.manager);
    await expect(drawer).toContainText('处理中 / 结果待确认');
    await expect(drawer).toContainText(command);
    await expect(drawer).toContainText(employee);
    await expect(drawer).toContainText('2026-10-13');
    await expect(drawer).toContainText('如确认未提交成功，请刷新后重新发起');
    await expect(drawer.getByRole('button', { name: '提交', exact: true })).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: '回查结果', exact: true })).toHaveCount(0);
    expect(writes).toBe(1);
  });
}

test('AC-FE-R1d-2 经理暂存关闭重开读取完整原单，刷新草稿后按原 ID 与 revision 提交', async ({ page }) => {
  let reads = 0;
  let revision = 4;
  let created = 0;
  let submitted: Record<string, string> | undefined;
  await page.route(`**/transfers/employees/${employee}`, (route) => {
    created++;
    return route.fulfill({ status: 201, json: { id: business, revision: 1, employeeRevision: 7, status: 'draft' } });
  });
  await page.route(`**/employment/businesses/${business}`, (route) => {
    reads++;
    return route.fulfill({ json: { ...draft, revision } });
  });
  await page.route(`**/employment/businesses/${business}/submit`, (route) => {
    submitted = route.request().headers();
    expect(route.request().postDataJSON()).toEqual({});
    return route.fulfill({ json: { ...draft, revision: 6, status: 'in_review' } });
  });
  const drawer = await setup(page, true);
  await drawer.getByRole('button', { name: '暂存', exact: true }).click();
  await expect(drawer).toContainText('提交暂存申请');
  const before = reads;
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('.service-nav a[href="/manager/todos"]').click();
  await page.locator('.service-nav a[href="/manager/applications"]').click();
  await openForm(page, true);
  await expect.poll(() => reads).toBeGreaterThan(before);
  await expect(drawer).toContainText('合成草稿备注');
  await expect(drawer).toContainText('2026-11-02');
  await expect(drawer.getByTestId('draft-withEstablishment')).toHaveText('未读取');
  await expect(drawer.getByTestId('draft-transferTypeCode')).toHaveText('未读取');
  revision = 5;
  await drawer.getByRole('button', { name: '重新读取已暂存申请', exact: true }).click();
  await expect(drawer.getByTestId('draft-revision')).toHaveText('5');
  await drawer.getByRole('button', { name: '提交暂存申请', exact: true }).click();
  await expect.poll(() => submitted?.['if-match']).toBe('5');
  expect(submitted?.['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  expect(created).toBe(1);
});

test('AC-FE-R1d-2 原草稿提交未确认，回查仍为草稿不能解除命令锁定', async ({ page }) => {
  let reads = 0;
  let writes = 0;
  await page.route(`**/transfers/employees/${employee}`, (route) => route.fulfill({ json: draft }));
  await page.route(`**/employment/businesses/${business}`, (route) => {
    reads++;
    return route.fulfill({ json: draft });
  });
  await page.route(`**/employment/businesses/${business}/submit`, (route) => {
    writes++;
    return route.abort('failed');
  });
  const drawer = await setup(page, true);
  await drawer.getByRole('button', { name: '暂存', exact: true }).click();
  await drawer.getByRole('button', { name: '提交暂存申请', exact: true }).click();
  await expect.poll(() => writes).toBe(1);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await openForm(page, true);
  await expect(drawer).toContainText('处理中 / 结果待确认');
  const before = reads;
  await drawer.getByRole('button', { name: '回查结果', exact: true }).click();
  await expect.poll(() => reads).toBeGreaterThan(before);
  await expect(drawer).toContainText('处理中 / 结果待确认');
  await expect(drawer.getByRole('button', { name: '提交暂存申请', exact: true })).toHaveCount(0);
  expect(writes).toBe(1);
});

test('AC-FE-R1d-2 经理草稿读取失败禁止续办，恢复读取后才能提交', async ({ page }) => {
  let unavailable = true;
  await page.route(`**/transfers/employees/${employee}`, (route) => route.fulfill({ json: draft }));
  await page.route(`**/employment/businesses/${business}`, (route) =>
    unavailable
      ? route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN', message: '无权读取草稿' } } })
      : route.fulfill({ json: draft }),
  );
  const drawer = await setup(page, true);
  await drawer.getByRole('button', { name: '暂存', exact: true }).click();
  await expect(drawer).toContainText('暂无访问权限');
  await expect(drawer.getByRole('button', { name: '提交暂存申请', exact: true })).toHaveCount(0);
  unavailable = false;
  await drawer.getByRole('button', { name: '重新读取已暂存申请', exact: true }).click();
  await expect(drawer.getByRole('button', { name: '提交暂存申请', exact: true })).toBeEnabled();
});

test('AC-FE-R1d-2 本人申请确认成功后可以显式新建，未确认保护不阻断下一笔', async ({ page }) => {
  const commands: string[] = [];
  await page.route('**/self-service/transfer', (route) => {
    commands.push(route.request().headers()['idempotency-key']!);
    return route.fulfill({ status: 201, json: { ...draft, status: 'in_review' } });
  });
  const drawer = await setup(page, false);
  await drawer.getByRole('button', { name: '提交', exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await openForm(page, false);
  await drawer.getByRole('button', { name: '新建调动申请', exact: true }).click();
  await drawer.getByRole('button', { name: '提交', exact: true }).click();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[0]).not.toBe(commands[1]);
});

test('AC-FE-R1d-2 查看我的申请后返回不清除原命令，只有整页刷新才重新发起', async ({ page }) => {
  let writes = 0;
  await page.route('**/self-service/transfer', (route) => {
    writes++;
    return route.abort('failed');
  });
  const drawer = await setup(page, false);
  await drawer.getByRole('button', { name: '提交', exact: true }).click();
  await expect.poll(() => writes).toBe(1);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('.service-nav a[href="/self/requests"]').click();
  await page.locator('.service-nav a[href="/self/applications"]').click();
  await openForm(page, false);
  await expect(drawer).toContainText('处理中 / 结果待确认');
  await expect(drawer.getByRole('button', { name: '提交', exact: true })).toHaveCount(0);
  expect(writes).toBe(1);
  await page.reload();
  await openForm(page, false);
  await expect(drawer.getByRole('button', { name: '提交', exact: true })).toBeEnabled();
});

for (const manager of [false, true]) {
  test(`AC-FE-R1d-3 ${manager ? '经理' : '员工'}明确拒绝保留输入，可改正重提且未知结果仍锁定`, async ({ page }) => {
    const drawer = await setup(page, manager);
    const target = '60000000-0000-4000-8000-000000000003';
    const custom = '70000000-0000-4000-8000-000000000001';
    await page.route('**/preview', (route) =>
      route.fulfill({
        json: {
          ...preview,
          customFields: { [custom]: '' },
          form: {
            ...preview.form,
            customFields: [{ id: custom, name: '合成备注', valueType: 'string' }],
            fieldModes: { ...preview.form.fieldModes, [`custom:${custom}`]: 'editable' },
          },
        },
      }),
    );
    await page.route('**/references/departmentId**', (route) =>
      route.fulfill({ json: { items: [{ id: target, name: '合成另一部门' }] } }),
    );
    const commands: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    const refusal = '合成业务拒绝，请修改后重提';
    await page.route(manager ? `**/transfers/employees/${employee}` : '**/self-service/transfer', (route) => {
      commands.push(route.request().headers()['idempotency-key']!);
      bodies.push(route.request().postDataJSON());
      if (commands.length === 1)
        return route.fulfill({
          status: manager ? 422 : 409,
          json: { error: { code: 'VALIDATION_FAILED', message: refusal } },
        });
      return route.abort('failed');
    });
    await drawer.locator('input[name="effectiveDate"]').fill('2026-11-02');
    await drawer.locator(`input[name="${custom}"]`).fill('合成原输入');
    await drawer.locator('select[name="departmentId"]').selectOption(target);
    await drawer.getByRole('button', { name: '提交', exact: true }).click();
    await expect(drawer).toContainText(refusal);
    await expect(drawer.locator('input[name="effectiveDate"]')).toHaveValue('2026-11-02');
    await expect(drawer.locator('select[name="departmentId"]')).toHaveValue(target);
    await expect(drawer.locator(`input[name="${custom}"]`)).toHaveValue('合成原输入');
    if (manager) await expect(drawer.locator('select[name="employeeId"]')).toHaveValue(employee);
    await drawer.locator(`input[name="${custom}"]`).fill('合成改正输入');
    await drawer.getByRole('button', { name: '提交', exact: true }).click();
    await expect.poll(() => commands.length).toBe(2);
    expect(commands[1]).not.toBe(commands[0]);
    expect(bodies[1]).toMatchObject({
      effectiveDate: '2026-11-02',
      fields: { departmentId: target },
      customFields: { [custom]: '合成改正输入' },
    });
    await expect(drawer).toContainText('处理中 / 结果待确认');
    await expect(drawer.getByRole('button', { name: '提交', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await openForm(page, manager);
    await expect(drawer).toContainText(commands[1]!);
    await expect(drawer.getByRole('button', { name: '提交', exact: true })).toHaveCount(0);
    expect(commands).toHaveLength(2);
  });
}
