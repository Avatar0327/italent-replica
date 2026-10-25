import type { Page, Request } from '@playwright/test';
import { employee, user, snapshotFixture } from './fixtures.js';
import { department, recordId, rows } from './intern-fixtures.js';

export { department, employee, recordId };
export const company = '61000000-0000-4000-8000-000000000001';
export const contractType = '61000000-0000-4000-8000-000000000002';
export const contractId = '61000000-0000-4000-8000-000000000003';
export const candidate = {
  employeeId: employee,
  name: '合成旧实习生',
  code: 'OLD-001',
  email: null,
  endKind: 'leave',
  lastWorkDate: '2026-09-30',
  departmentId: department,
  rehire: false,
};
// 对照 BE-R2d4c InternCreateReceipt；revision 是新建业务版本，不是候选员工的 revision。
export const receipt = (extra: Record<string, unknown> = {}) => ({
  id: recordId,
  businessId: recordId,
  employeeId: employee,
  revision: 1,
  kind: 'hire',
  view: 'interning',
  contract: { stage: 'formal', id: contractId, startDate: '2026-10-12', endDate: '2027-10-11', companyId: company },
  ...extra,
});
export const sent = (request: Request) => ({
  body: request.postDataJSON() as Record<string, unknown>,
  revision: request.headers()['if-match'],
  id: request.headers()['idempotency-key'],
});
export async function setupCreate(page: Page, options: { noCreate?: boolean; hidden?: string[] } = {}) {
  const state = { revision: 5, saved: false, reads: [] as string[], requests: [] as ReturnType<typeof sent>[] };
  await page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        apps: snapshotFixture.apps.map((app) =>
          app.app === 'transfer' ? { ...app, entryObjects: ['TenantBase.EmploymentRecord'] } : app,
        ),
      },
    }),
  );
  await page.route('**/permission/me/objects/*', (route) => {
    const objectCode = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!);
    const fields = [
      'backupMail',
      'mobilePhone',
      'gender',
      'birthday',
      'engName',
      'idType',
      'idNumber',
      'dailyWageStandard',
      'educationLevel',
      'school',
      'major',
      'isHighestEducation',
      'isMainMajor',
      'name',
      'code',
      'effectiveDate',
      'employType',
      'departmentId',
      'positionId',
      'directManagerId',
      'dottedManagerId',
      'kind',
      'companyId',
      'typeId',
      'endDate',
      'termType',
      'termMonths',
    ];
    return route.fulfill({
      json: {
        objectCode,
        dataOperations: { read: true, create: true, update: true },
        viewableFields: fields.filter((field) => !options.hidden?.includes(field)),
        editableFields: fields.filter((field) => !options.hidden?.includes(field)),
        buttons: [...(options.noCreate ? [] : ['Employee.Create']), 'Employment.Create', 'create', 'update'].flatMap(
          (buttonCode) => ['detail', 'list'].map((level) => ({ buttonCode, level })),
        ),
      },
    });
  });
  await page.route('**/employment/interns?*', (route) => {
    state.reads.push(new URL(route.request().url()).searchParams.get('view')!);
    return route.fulfill({ json: { items: state.saved ? [rows.interning] : [], page: 1, pageSize: 30 } });
  });
  await page.route('**/employment/rehire-matches', (route) => route.fulfill({ json: { matched: false } }));
  await page.route(`**/employment/employees/${employee}`, (route) =>
    route.fulfill({
      json: { id: employee, revision: state.revision, code: 'OLD-001', name: candidate.name },
    }),
  );
  await page.route(`**/employment/businesses/${recordId}`, (route) =>
    route.fulfill({
      json: { id: recordId, employeeId: employee, revision: 1, kind: 'hire' },
    }),
  );
  for (const [path, id, name] of [
    ['org/organizations', department, '合成实习部门'],
    ['contracts/master-data/companies', company, '合成合同公司'],
    ['contracts/master-data/types', contractType, '合成实习协议'],
  ])
    await page.route(`**/${path}?*`, (route) => route.fulfill({ json: { items: [{ id, name, enabled: true }] } }));
  await page.route(`**/org/organizations/${department}*`, (route) =>
    route.fulfill({
      json: { id: department, name: '合成实习部门' },
    }),
  );
  await page.route('**/employment/interns', (route) => {
    state.requests.push(sent(route.request()));
    state.saved = true;
    return route.fulfill({ status: 201, json: receipt() });
  });
  await page.goto('/interns');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.waitForURL('/staff');
  await page.goto('/interns');
  return state;
}
export const editor = (page: Page) => page.getByRole('dialog', { name: '新增实习生', exact: true });
export async function chooseCreate(page: Page, label: string, text: string) {
  await editor(page)
    .getByRole('combobox', { name: label, exact: true })
    .locator('xpath=ancestor::div[contains(@class,"ant-select-selector")]')
    .click();
  await page
    .locator('.ant-select-dropdown:visible .ant-select-item-option-content')
    .getByText(text, { exact: true })
    .click();
}
export const dateInput = (page: Page, label: string) =>
  editor(page)
    .locator('.ant-form-item')
    .filter({
      has: page.locator('.ant-form-item-label').getByText(label, { exact: true }),
    })
    .getByRole('textbox');
export async function dateCreate(page: Page, label: string, value: string) {
  const input = dateInput(page, label);
  await input.fill(value);
  await input.press('Enter');
  await editor(page).locator('.ant-modal-title').click();
}
export async function openCreate(page: Page) {
  await page.getByRole('button', { name: '新增实习生', exact: true }).click();
}
export async function fillCreate(page: Page, future = false, withEnd = true) {
  await editor(page).getByLabel('姓名', { exact: true }).fill('合成新实习生');
  await editor(page).getByLabel('电子邮件', { exact: true }).fill('intern@example.com');
  await editor(page).getByLabel('工号', { exact: true }).fill('IN-NEW-001');
  await dateCreate(page, '实习开始日期', future ? '2026-11-01' : '2026-10-12');
  await chooseCreate(page, '实习部门', '合成实习部门');
  await chooseCreate(page, '合同公司', '合成合同公司');
  if (!future) await chooseCreate(page, '合同类型', '合成实习协议');
  if (withEnd) await dateCreate(page, '合同协议终止日期', '2027-10-11');
}
export const saveCreate = (page: Page) => editor(page).getByRole('button', { name: /保\s*存$/ });
