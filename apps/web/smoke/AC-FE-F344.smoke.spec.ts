import type { Page } from '@playwright/test';
import { test, expect, employee } from './fixtures.js';
import { openDetail, setup } from './probation-fixtures.js';

/**
 * F-344：转正三入口（直接转正 / 转正申请 / 批量转正）的转正日期受任职对象 editableFields 管。
 * 没有 effectiveDate 编辑权：日期控件只读，请求体与暂存都不带日期（走服务端默认）；有编辑权：可改并随请求发送。
 * 服务端对应的 403 见 tests/acceptance/AC-PB-F344-effective-date-field.test.ts。
 */
const named = (name: string) => ({ name: new RegExp(`^${name.split('').join('\\s*')}$`) });
const dialog = (page: Page, title: string) => page.getByRole('dialog', { name: title, exact: true });
const dateOf = (form: ReturnType<typeof dialog>) => form.getByLabel('转正日期', { exact: true });
async function pickResult(page: Page, form: ReturnType<typeof dialog>) {
  await form
    .getByRole('combobox', { name: '试用结果', exact: true })
    .locator('xpath=ancestor::div[contains(@class,"ant-select-selector")]')
    .click();
  await page.locator('.ant-select-dropdown:visible').getByText('合成通过', { exact: true }).click();
}
async function openBatch(page: Page) {
  await expect(page.locator('.probation-table tr.ant-table-row')).toHaveCount(1);
  await page.getByRole('checkbox', { name: 'Select all' }).check();
  await page.getByRole('button', { name: '批量转正', exact: true }).click();
  const form = dialog(page, '批量转正（已选 1 人）');
  await pickResult(page, form);
  return form;
}
const withoutDate = ['departmentId'];

test('AC-FE-F344-01 直接转正：没有转正日期编辑权，日期只读且请求体不带日期', async ({ page }) => {
  const { server } = await setup(page, { editableFields: withoutDate });
  await openDetail(page);
  await page.getByRole('button', named('转正')).click();
  const form = dialog(page, '转正');
  await expect(dateOf(form)).toBeDisabled();
  await pickResult(page, form);
  await form.getByRole('button', named('保存')).click();
  await expect(form).toHaveCount(0);
  expect(server.writes).toHaveLength(1);
  expect(server.writes[0]!.body).toEqual({
    mode: 'direct',
    probationResult: 'pass',
    items: [{ employeeId: employee, revision: 4 }],
  });
});

test('AC-FE-F344-02 直接转正：有转正日期编辑权，可改日期并随请求发送', async ({ page }) => {
  const { server } = await setup(page);
  await openDetail(page);
  await page.getByRole('button', named('转正')).click();
  const form = dialog(page, '转正');
  await expect(dateOf(form)).toBeEnabled();
  await dateOf(form).fill('2026-11-05');
  await pickResult(page, form);
  await form.getByRole('button', named('保存')).click();
  await expect(form).toHaveCount(0);
  expect(server.writes[0]!.body).toMatchObject({ mode: 'direct', effectiveDate: '2026-11-05' });
});

test('AC-FE-F344-03 转正申请：没有转正日期编辑权，日期只读，建草稿的请求体不带日期', async ({ page }) => {
  const { server } = await setup(page, { editableFields: withoutDate });
  await openDetail(page);
  await page.getByRole('button', named('转正申请')).click();
  const form = dialog(page, '转正申请');
  await expect(dateOf(form)).toBeDisabled();
  await pickResult(page, form);
  await form.getByRole('button', named('提交')).click();
  await expect(form).toHaveCount(0);
  expect(server.writes[0]!.path).toBe(`/api/tenant/employment/employees/${employee}/businesses`);
  expect(server.writes[0]!.body).toEqual({ kind: 'regularization', mode: 'application', probationResult: 'pass' });
});

test('AC-FE-F344-04 转正申请：没有转正日期编辑权，暂存只存试用结果，不带日期', async ({ page }) => {
  const { server } = await setup(page, { editableFields: withoutDate });
  await openDetail(page);
  await page.getByRole('button', named('转正申请')).click();
  const form = dialog(page, '转正申请');
  await pickResult(page, form);
  await form.getByRole('button', { name: /暂\s*存$/ }).click();
  await expect(page.getByText('已暂存', { exact: true })).toBeVisible();
  expect(server.writes).toHaveLength(1);
  expect(server.writes[0]).toMatchObject({ method: 'PUT', body: { effectiveDate: null, probationResult: 'pass' } });
});

test('AC-FE-F344-05 转正申请：有转正日期编辑权，可改日期并随建草稿请求发送', async ({ page }) => {
  const { server } = await setup(page);
  await openDetail(page);
  await page.getByRole('button', named('转正申请')).click();
  const form = dialog(page, '转正申请');
  await expect(dateOf(form)).toBeEnabled();
  await dateOf(form).fill('2026-11-05');
  await pickResult(page, form);
  await form.getByRole('button', named('提交')).click();
  await expect(form).toHaveCount(0);
  expect(server.writes[0]!.body).toMatchObject({ kind: 'regularization', effectiveDate: '2026-11-05' });
});

test('AC-FE-F344-06 批量转正：没有转正日期编辑权，统一日期只读且请求体不带日期', async ({ page }) => {
  const { server } = await setup(page, { editableFields: withoutDate });
  const form = await openBatch(page);
  await expect(dateOf(form)).toBeDisabled();
  await form.getByRole('button', { name: /保\s*存$/ }).click();
  await expect(page.getByText('1 人转正成功')).toBeVisible();
  expect(server.writes).toHaveLength(1);
  expect(server.writes[0]!.body).toEqual({
    mode: 'direct',
    probationResult: 'pass',
    items: [{ employeeId: employee, revision: 4 }],
  });
});

test('AC-FE-F344-07 批量转正：有转正日期编辑权，可填统一日期并随请求发送', async ({ page }) => {
  const { server } = await setup(page);
  const form = await openBatch(page);
  await expect(dateOf(form)).toBeEnabled();
  await dateOf(form).fill('2026-11-05');
  await form.getByRole('button', { name: /保\s*存$/ }).click();
  await expect(page.getByText('1 人转正成功')).toBeVisible();
  expect(server.writes[0]!.body).toMatchObject({ mode: 'direct', effectiveDate: '2026-11-05' });
});
