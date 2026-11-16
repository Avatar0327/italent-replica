import { test, expect, employee, seedDemoUser, snapshotFixture } from './fixtures.js';
import { RECORD_ROW } from '../../../tests/acceptance/support/f474-records-row.js';
import type { Page } from '@playwright/test';

/**
 * F-481 S4 真浏览器主流程（设计 §8.1、§8.4）：调动表单选“发起电子文件签署 = 是”并选模板后保存；
 * 任职记录列表勾选后「调动发起电子签署」逐条回执；电子签 > 设置 / 签署场景设置两页可打开并进入编辑。
 * 夹具形状：调动表单同 AC-FE-F504；列表行取后端核对过键集的 RECORD_ROW；模板 / 场景 / 回执按 apps/api esign。
 */
const contract = '34810000-0000-4000-8000-000000000011';
const T1 = '84810000-0000-4000-8000-000000000601';
const T2 = '84810000-0000-4000-8000-000000000602';
const today = '2026-10-12';
const options = {
  items: [
    { id: T1, name: '合成调动协议' },
    { id: T2, name: '合成保密协议' },
  ],
};
const button = (label: string) => new RegExp(`^${label.split('').join('\\s*')}$`);
const permission = (objectCode: string, extra: Record<string, unknown>) => ({
  objectCode,
  dataOperations: { read: true, create: true, update: true },
  viewableFields: ['name'],
  editableFields: [],
  buttons: [],
  ...extra,
});

async function transferFixtures(page: Page) {
  const writes: Record<string, unknown>[] = [];
  const fields = ['effectiveDate', 'transferTypeCode', 'reasonCode', 'adjustSalary', 'isChangeContract'];
  const linkage = [...fields, 'contractChange', 'electronicSignature', 'esignTemplateIds'];
  await page.route('**/permission/me/objects/TenantBase.EmploymentRecord', (route) =>
    route.fulfill({
      json: permission('TenantBase.EmploymentRecord', {
        viewableFields: ['name', 'place'],
        editableFields: ['place'],
        buttons: [{ buttonCode: 'Transfer.Hr', level: 'detail' }],
      }),
    }),
  );
  await page.route('**/employment/transfers/catalog**', (route) =>
    route.fulfill({
      json: {
        today,
        types: [{ code: 'transfer', name: '部门间调动', formId: 'hr' }],
        reasons: [],
        viewableFields: linkage,
        editableFields: linkage,
      },
    }),
  );
  await page.route('**/employment/employees?**', (route) =>
    route.fulfill({ json: { items: [{ id: employee, name: '合成员工', code: 'DEMO-001', revision: 3 }] } }),
  );
  await page.route('**/transfers/employees/*/draft', (route) => route.fulfill({ json: { draft: null } }));
  await page.route('**/transfers/employees/*/preview', (route) =>
    route.fulfill({
      json: {
        employeeRevision: 3,
        allowDirectTransfer: true,
        allowedActions: { application: true, directList: true, directRow: true },
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
  await page.route(`**/employment/transfers/employees/${employee}/contracts`, (route) =>
    route.fulfill({ json: { items: [{ id: contract, name: 'HT-481' }] } }),
  );
  // 原合同生效日与调动日相同：不触发 F-504 终止原合同确认框，保存直接写。
  await page.route(`**/api/tenant/contracts/employees/${employee}/contracts`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            ...{ id: contract, employeeId: employee, number: 'HT-481', typeId: null, companyId: null },
            ...{ termType: 'fixed', termMonths: 36, signingDate: today, effectiveDate: today, endDate: '2029-12-31' },
            ...{ actualTerminationDate: null, signingCount: 1, versionNo: 1, rootContractId: contract },
            ...{ previousContractId: null, status: 'valid', terminationReason: null, approvalStatus: 'effective' },
            ...{ revision: 3, createdAt: '2026-01-01T02:00:00.000Z' },
          },
        ],
      },
    }),
  );
  await page.route('**/esign/template-options/transfer-form', (route) => route.fulfill({ json: options }));
  await page.route(`**/employment/transfers/employees/${employee}`, (route) => {
    writes.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({
      status: 201,
      json: { id: '64810000-0000-4000-8000-000000000001', revision: 1, employeeRevision: 4, status: 'approved' },
    });
  });
  return writes;
}

test('AC-TRF-F481-FE-S1 调动：变更合同选“发起电子文件签署 = 是”，选模板后保存，报文带 esign.templateIds', async ({
  page,
}) => {
  const writes = await transferFixtures(page);
  await seedDemoUser(page);
  await page.goto('/transfer');
  await expect(page.locator('.hr-transfer-page').first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: button('调动') }).click();
  await page.locator('select[name="employeeId"]').selectOption(employee);
  await expect(page.locator('input[name="place"]')).toBeVisible();
  await page.getByRole('radiogroup', { name: '是否变更合同' }).getByRole('radio', { name: '是' }).check();
  await page.locator('select[name="contractTargetId"]').selectOption(contract);
  await expect(page.locator('#hr-transfer-contract')).not.toContainText('接口暂不支持');
  const esign = page.getByRole('radiogroup', { name: '发起电子文件签署' });
  await expect(esign.getByRole('radio', { name: '是' })).not.toBeChecked();
  await expect(esign.getByRole('radio', { name: '否' })).not.toBeChecked();
  await esign.getByRole('radio', { name: '是' }).check();
  const save = page.getByRole('button', { name: '保存', exact: true });
  await expect(save).toBeDisabled();
  await page.locator('select[name="esignTemplateIds"]').selectOption([T2]);
  await save.click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({
    mode: 'direct',
    linkage: { contract: { targetId: contract, fields: {} }, esign: { templateIds: [T2] } },
  });
});

const rows = [
  { ...RECORD_ROW, id: '34810000-0000-4000-8000-0000000004a1', employeeName: '合成员工甲' },
  { ...RECORD_ROW, id: '34810000-0000-4000-8000-0000000004a2', employeeName: '合成员工乙', kind: 'entry' },
];
async function recordFixtures(page: Page) {
  const posts: { body: unknown; key: string | undefined }[] = [];
  await page.route('**/permission/me/objects/TenantBase.EmploymentRecord', (route) =>
    route.fulfill({
      json: permission('TenantBase.EmploymentRecord', {
        buttons: [{ buttonCode: 'MulLaunchESignTranfer', level: 'list' }],
      }),
    }),
  );
  await page.route('**/employment/records?**', (route) => route.fulfill({ json: { items: rows, total: 2 } }));
  await page.route('**/esign/template-options/reissue', (route) => route.fulfill({ json: options }));
  await page.route('**/esign/transfer-tasks', (route) => {
    posts.push({ body: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] });
    return route.fulfill({
      json: {
        items: [
          { id: rows[0]!.id, ok: true, taskId: '84810000-0000-4000-8000-000000000701', status: 'signing' },
          { id: rows[1]!.id, ok: false, code: 'NOT_FOUND' },
        ].map((item) => (item.ok ? { ...item, failureReason: null } : item)),
      },
    });
  });
  return posts;
}

test('AC-TRF-F481-FE-S2 任职记录：不勾选先提示；勾选两行选模板发起，逐条显示中文结果', async ({ page }) => {
  const posts = await recordFixtures(page);
  await seedDemoUser(page);
  await page.goto('/employment-records');
  const reissue = page.locator('.page-heading').getByRole('button', { name: '调动发起电子签署' });
  await expect(page.locator('.ant-table-tbody .ant-table-row')).toHaveCount(2, { timeout: 15_000 });
  await reissue.click();
  await expect(page.getByText('请至少选择一条数据')).toBeVisible();
  await expect(page.locator('.ant-modal')).toHaveCount(0);
  for (const row of await page.locator('.ant-table-tbody .ant-table-row .ant-checkbox-input').all()) await row.check();
  await reissue.click();
  const modal = page.locator('.ant-modal');
  await expect(modal).toContainText('已选择 2 条任职记录');
  const confirm = modal.getByRole('button', { name: button('确定') });
  await expect(confirm).toBeDisabled();
  await modal.locator('select[name="esignTemplateIds"]').selectOption([T1]);
  await confirm.click();
  await expect(modal).toContainText('已发起签署');
  await expect(modal).toContainText('不可发起：不是可发起签署的调动，或不在您的操作范围内');
  await expect(modal).not.toContainText('NOT_FOUND');
  expect(posts).toEqual([
    { body: { items: rows.map((row) => ({ businessId: row.id })), templateIds: [T1] }, key: expect.any(String) },
  ]);
  await expect(confirm).toBeDisabled();
});

const fields = ['code', 'name', 'body', 'status', 'sortOrder', 'scene', 'validityDays', 'remindBeforeExpiry'];
async function settingsFixtures(page: Page) {
  // 菜单入口按应用的 entryObjects 放行（同 AC-FE-F455）：电子签设置对象归企业设置应用。
  await page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        apps: snapshotFixture.apps.map((app) =>
          app.app === 'settings' ? { ...app, entryObjects: ['TenantBase.ESignSettings'] } : app,
        ),
      },
    }),
  );
  await page.route('**/permission/me/objects/TenantBase.ESignSettings', (route) =>
    route.fulfill({
      json: permission('TenantBase.ESignSettings', {
        viewableFields: fields,
        editableFields: fields,
        buttons: [
          { buttonCode: 'create', level: 'list' },
          { buttonCode: 'update', level: 'detail' },
        ],
      }),
    }),
  );
  await page.route('**/esign/templates', (route) =>
    route.fulfill({
      json: {
        items: [
          { id: T1, code: 'SYN-TRF', name: '合成调动协议', body: '{员工姓名}调入{调入部门}。' },
          { id: T2, code: 'SYN-NDA', name: '合成保密协议', body: '合成正文' },
        ].map((item, index) => ({ ...item, status: index ? 'disabled' : 'enabled', sortOrder: index, revision: 1 })),
      },
    }),
  );
  await page.route('**/esign/scenes/transfer', (route) =>
    route.fulfill({ json: { scene: 'transfer', validityDays: 7, remindBeforeExpiry: true, revision: 2 } }),
  );
}

test('AC-TRF-F481-FE-S3 电子签 > 设置（签署模板）与签署场景设置：列表可见，可打开编辑', async ({ page }) => {
  await settingsFixtures(page);
  await seedDemoUser(page);
  await page.goto('/esign-templates');
  await expect(page.getByRole('heading', { name: '签署模板' })).toBeVisible({ timeout: 15_000 });
  const first = page.locator('.ant-table-row').filter({ hasText: '合成调动协议' });
  await expect(first).toContainText('SYN-TRF');
  await expect(page.locator('.ant-table-row').filter({ hasText: '合成保密协议' })).toContainText('停用');
  await first.getByRole('button', { name: button('编辑') }).click();
  const drawer = page.locator('.ant-drawer-content');
  await expect(drawer).toContainText('{调入部门}');
  await expect(drawer.locator('input[id$="code"]')).toHaveCount(0); // 编码建后不可改
  await page.goto('/esign-scenes');
  const scene = page.locator('.ant-table-row').filter({ hasText: '调动电子签署' });
  await expect(scene).toContainText('7 天', { timeout: 15_000 });
  await scene.getByRole('button', { name: button('编辑') }).click();
  await expect(page.locator('.ant-drawer-content')).toContainText('固定配置（复刻固定，不可配置）');
});
