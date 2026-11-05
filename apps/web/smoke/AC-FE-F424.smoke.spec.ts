import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { item, pickDate, save } from './contracts-fixtures.js';
import { entryId, entryFields, objectGrant, setupEntries } from './entry-fixtures.js';

/**
 * F-424：办理入职弹窗里，入职日期（任职对象 effectiveDate）受字段查看权管。
 * 没有查看权：入职日期显示 --，不预填由它推出的日期，请求里不带 asOf 日期，提交也不带试用开始日期；
 * 有查看权：照常显示并预填（正例）。夹具故意仍回带日期，证明前端不依赖服务端裁剪。
 */
const objectCode = 'TenantBase.EmploymentRecord';
async function choose(page: Page, label: string, option: string) {
  const dialog = page.getByRole('dialog', { name: /^入职(?:\s|$)/ });
  await item(dialog, label).locator('.ant-select-selector').click();
  await page.locator('.ant-select-dropdown:visible').getByTitle(option, { exact: true }).click();
}
/** 试用期日期只随合同一起提交（completeBody：无合同区取值就不带 contract），所以补一份最小固定期限合同。 */
async function fillContract(page: Page, dialog: Locator) {
  await choose(page, '法人公司', '合成法人公司');
  await choose(page, '合同类型', '合成合同类型');
  await choose(page, '期限类型', '固定期限');
  await pickDate(dialog, '终止日期', '2027-10-14');
}
async function open(page: Page, baseURL: string, withoutDate: boolean) {
  const state = await setupEntries(page, baseURL);
  if (withoutDate) {
    const grant = objectGrant(objectCode);
    const rest = (fields: string[]) => fields.filter((field) => field !== 'effectiveDate');
    await page.route(`**/permission/me/objects/${objectCode}`, (route) =>
      route.fulfill({
        json: { ...grant, viewableFields: rest(grant.viewableFields), editableFields: rest(entryFields) },
      }),
    );
  }
  await page.reload();
  const row = page.getByRole('row').filter({ hasText: '合成入职甲' });
  await expect(row).toBeVisible();
  // 列表页自己的部门名称按行日期取，不算弹窗：列表就绪后才开始记录
  const asOf: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('asOf=2026-10-15')) asOf.push(request.url());
  });
  await row.getByRole('button', { name: /更多|▾/ }).click();
  await page.getByRole('menuitem', { name: '入职', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /^入职(?:\s|$)/ });
  await expect(dialog).toBeVisible();
  return { state, dialog, asOf };
}

test('AC-FE-F424-01 没有入职日期查看权：不显示、不预填推导日期、请求不带日期', async ({ page, baseURL }) => {
  const { state, dialog, asOf } = await open(page, baseURL!, true);
  await expect(item(dialog, '入职日期')).toContainText('--');
  await expect(dialog).not.toContainText('2026-10-15');
  await choose(page, '是否有试用期', '是');
  await choose(page, '试用期(月)', '1');
  await expect(item(dialog, '预计试用结束日期').getByRole('textbox')).toHaveValue('');
  await pickDate(dialog, '预计试用结束日期', '2026-11-13');
  await fillContract(page, dialog);
  await dialog.getByRole('button', save).click();
  await expect(dialog).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({
    path: `/api/tenant/employment/pending-entries/${entryId}/complete`,
    body: { probation: true, contract: { termType: 'fixed', probationEndDate: '2026-11-13' } },
  });
  expect(JSON.stringify(state.writes[0]!.body)).not.toContain('probationStartDate');
  expect(JSON.stringify(state.writes[0])).not.toContain('2026-10-15');
  expect(asOf).toEqual([]);
});

test('AC-FE-F424-02 有入职日期查看权：显示入职日期并预填试用结束日，提交带试用开始日', async ({ page, baseURL }) => {
  const { state, dialog } = await open(page, baseURL!, false);
  await expect(item(dialog, '入职日期')).toContainText('2026-10-15');
  await choose(page, '是否有试用期', '是');
  await choose(page, '试用期(月)', '1');
  await expect(item(dialog, '预计试用结束日期').getByRole('textbox')).toHaveValue('2026-11-14');
  await pickDate(dialog, '预计试用结束日期', '2026-11-13');
  await fillContract(page, dialog);
  await dialog.getByRole('button', save).click();
  await expect(dialog).toHaveCount(0);
  expect(state.writes[0]).toMatchObject({
    body: { probation: true, contract: { probationStartDate: '2026-10-15', probationEndDate: '2026-11-13' } },
  });
});
