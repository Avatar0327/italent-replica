import type { Page } from '@playwright/test';
import { entryId, initialEntry, objectGrant, setupEntries } from './entry-fixtures.js';
import { expect, test } from './fixtures.js';

const RECORDS = 'TenantBase.ESignRecord';
const EMPLOYMENT = 'TenantBase.EmploymentRecord';
const signName = '发起电子文件签署';
const historyName = '电子签署';
const row = (page: Page) => page.getByRole('row').filter({ hasText: initialEntry.name });
const selectTab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true }).click();
async function menu(page: Page) {
  await row(page).getByRole('button', { name: '更多操作' }).click();
  return page.getByRole('menuitem', { name: signName, exact: true });
}

test('AC-ESIGN-F505-FE-02 列表裁剪状态和版本时仍按当前来源上下文决定能否提交', async ({ page, baseURL }) => {
  const state = await setupEntries(page, baseURL!);
  state.hidden = ['kind', 'employeeStatus', 'entryStatus', 'revision', 'employeeId'];
  let reads = 0;
  await page.route('**/pending-entries/*/esign-context', (route) => {
    reads++;
    expect(route.request().url()).toContain(entryId);
    return route.fulfill({
      json: { sourceId: entryId, revision: 9, canInitiate: false, reason: 'ENTRY_CANCELLED', items: [] },
    });
  });
  await selectTab(page, '今日待入职');
  const sign = await menu(page);
  await expect(sign, '今日待入职行的签署入口可用').toBeEnabled({ timeout: 3000 });
  await sign.click();
  const dialog = page.getByRole('dialog', { name: '发起电子签署' });
  await expect(dialog.getByText('当前来源不满足发起条件。')).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^确\s*定$/ })).toBeDisabled();
  expect(reads).toBe(1);
  expect(state.writes).toEqual([]);
});

test('AC-ESIGN-F505-FE-02 没有详情编辑按钮时隐藏签署发起入口', async ({ page, baseURL }) => {
  await setupEntries(page, baseURL!);
  await page.route('**/permission/me/objects/*', (route) => {
    const objectCode = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!);
    const grant = objectGrant(objectCode);
    return route.fulfill({
      json: { ...grant, buttons: grant.buttons.filter((b) => b.buttonCode !== 'Employment.Edit') },
    });
  });
  await page.reload();
  await expect(row(page).getByRole('button', { name: /^编\s*辑$/ })).toBeDisabled();
  const sign = await menu(page);
  await expect(page.getByRole('menuitem', { name: '删除人员' })).toBeVisible();
  await expect(sign, '无详情编辑按钮时菜单中没有签署发起').toHaveCount(0, { timeout: 3000 });
});

test('AC-ESIGN-F505-FE-02/03 已取消和已入职可独立查看历史，空结果按可见记录提示', async ({ page, baseURL }) => {
  const state = await setupEntries(page, baseURL!);
  await page.route('**/permission/me/objects/*', (route) => {
    const objectCode = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!);
    expect([RECORDS, EMPLOYMENT]).toContain(objectCode);
    const grant = objectGrant(objectCode);
    return route.fulfill({ json: { ...grant, dataOperations: { create: false, update: false, delete: false } } });
  });
  await page.route('**/pending-entries/*/esign-records?*', (route) => {
    expect(route.request().url()).toContain(entryId);
    return route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 20 } });
  });
  state.row.entryStatus = 1;
  await selectTab(page, '已取消入职');
  const history = row(page).getByRole('button', { name: historyName, exact: true });
  await expect(history, '取消行保留只读签署历史入口').toBeVisible({ timeout: 3000 });
  await history.click();
  const drawer = page.getByRole('dialog', { name: historyName });
  await expect(drawer.getByText('暂无可见签署记录')).toBeVisible();
  state.row.employeeStatus = 3;
  await selectTab(page, '已入职');
  await expect(drawer).toBeHidden();
  await history.click();
  await expect(drawer.getByText('暂无可见签署记录')).toBeVisible();
  await expect(row(page).getByRole('button', { name: '更多操作' })).toHaveCount(0);
  expect(state.writes).toEqual([]);
});
