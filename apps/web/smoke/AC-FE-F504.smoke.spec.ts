import { test, expect, employee, seedDemoUser } from './fixtures.js';
import type { Page } from '@playwright/test';

/**
 * F-504 真浏览器主流程：HR「调动」变更合同且调动日晚于原合同生效日，保存先弹确认框；取消不写，确定才写一次。
 * 夹具形状同 AC-FE-R1c（权限、catalog、预览、写入回执），合同摘要按后端 contracts/detail.ts SUMMARY。
 */
const contract = '35040000-0000-4000-8000-000000000011';
const today = '2026-10-12';
const fields = ['effectiveDate', 'transferTypeCode', 'reasonCode', 'adjustSalary', 'isChangeContract'];
const button = (label: string) => new RegExp(`^${label.split('').join('\\s*')}$`);

async function fixtures(page: Page, originalEffectiveDate: string) {
  const writes: Record<string, unknown>[] = [];
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
  await page.route('**/employment/transfers/catalog**', (route) =>
    route.fulfill({
      json: {
        today,
        types: [{ code: 'transfer', name: '部门间调动', formId: 'hr' }],
        reasons: [],
        viewableFields: [...fields, 'contractChange'],
        editableFields: [...fields, 'contractChange'],
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
  await contracts(page, originalEffectiveDate);
  await page.route(`**/employment/transfers/employees/${employee}`, (route) => {
    writes.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({
      status: 201,
      json: { id: '65040000-0000-4000-8000-000000000001', revision: 1, employeeRevision: 4, status: 'approved' },
    });
  });
  return writes;
}

// 调动候选只回 id 与编号；原合同生效日取合同模块员工合同摘要（contracts/detail.ts SUMMARY 同形）。
async function contracts(page: Page, originalEffectiveDate: string) {
  await page.route(`**/employment/transfers/employees/${employee}/contracts`, (route) =>
    route.fulfill({ json: { items: [{ id: contract, name: 'HT-504' }] } }),
  );
  await page.route(`**/api/tenant/contracts/employees/${employee}/contracts`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: contract,
            employeeId: employee,
            number: 'HT-504',
            typeId: null,
            companyId: null,
            termType: 'fixed',
            termMonths: 36,
            signingDate: originalEffectiveDate,
            effectiveDate: originalEffectiveDate,
            endDate: '2029-12-31',
            actualTerminationDate: null,
            signingCount: 1,
            versionNo: 1,
            rootContractId: contract,
            previousContractId: null,
            status: 'valid',
            terminationReason: null,
            approvalStatus: 'effective',
            revision: 3,
            createdAt: '2026-01-01T02:00:00.000Z',
          },
        ],
      },
    }),
  );
}

async function changeContract(page: Page) {
  await seedDemoUser(page);
  await page.goto('/transfer');
  await expect(page.locator('.hr-transfer-page').first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: button('调动') }).click();
  await page.locator('select[name="employeeId"]').selectOption(employee);
  await expect(page.locator('input[name="place"]')).toBeVisible();
  const info = page.locator('#hr-transfer-info');
  await info.getByRole('radiogroup', { name: '是否变更合同' }).getByRole('radio', { name: '是' }).check();
  await page.locator('select[name="contractTargetId"]').selectOption(contract);
}

test('AC-FE-F504-S1 调动：调动日晚于原合同生效日，保存先确认；取消不写，确定写一次', async ({ page }) => {
  const writes = await fixtures(page, '2026-03-01');
  await changeContract(page);
  const save = page.getByRole('button', { name: '保存', exact: true });
  const dialog = page.locator('.ant-modal-confirm');
  await save.click();
  await expect(dialog.locator('.ant-modal-confirm-title')).toHaveText('请确认以下信息后，再继续操作');
  await expect(dialog.locator('.ant-modal-confirm-content')).toHaveText(
    '变更后合同的生效日期晚于原合同生效日期，继续保存将终止原合同。',
  );
  await dialog.getByRole('button', { name: button('取消') }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('select[name="contractTargetId"]')).toHaveValue(contract);
  expect(writes).toEqual([]);
  await save.click();
  await dialog.getByRole('button', { name: button('确定') }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({
    mode: 'direct',
    submit: false,
    effectiveDate: today,
    linkage: { contract: { targetId: contract, fields: {} } },
  });
  await expect(dialog).toBeHidden();
});

test('AC-FE-F504-S2 调动日与原合同生效日相同：不终止原合同，保存不弹框直接写', async ({ page }) => {
  const writes = await fixtures(page, today);
  await changeContract(page);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  await expect(page.locator('.ant-modal-confirm')).toHaveCount(0);
});
