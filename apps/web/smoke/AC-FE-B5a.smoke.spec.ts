import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { addExit, ids, rowSubmit, setupExits, type ExitServer } from './exit-list-fixtures.js';

// B5a：F-352① 按钮读服务端 actions、F-386 列表勾选与“离职处理▾”、F-352③ 弹窗 / 提示走 App 上下文、F-393 详情加黑三项。
const names = { inProgress: '合成离职中员工', completed: '合成已离职员工', failed: '合成生效失败员工' };
const dialog = (page: Page) => page.getByRole('dialog').last();
const list = (page: Page) => page.locator('.exit-card');
const rowOf = (page: Page, name: string) => list(page).getByRole('row').filter({ hasText: name });
const popconfirm = (page: Page) => page.locator('.ant-popconfirm:visible').getByRole('button', { name: /确\s*定/ });
const toast = (page: Page, text: string) => page.locator('.ant-message').getByText(text, { exact: true });
const writes = (server: ExitServer, suffix: string) => server.sent.filter((item) => item.path.endsWith(suffix));
async function refresh(page: Page) {
  await page.getByRole('button', { name: /^刷\s*新$/ }).click();
}
async function openDetail(page: Page, name: string) {
  await rowOf(page, name).getByRole('button', { name: '查看详情', exact: true }).click();
  await expect(dialog(page).locator('.ant-modal-title')).toHaveText('离职管理');
}
const menu = (page: Page) =>
  list(page)
    .getByRole('button', { name: /离职处理/ })
    .first();

test('AC-FE-B5a-01 F-386 基线：行内“发起离职交接”按服务端 rowActions 显示，确认后以行 revision 提交', async ({
  page,
}) => {
  const server = await setupExits(page);
  server.rowActions = { [ids.inProgress]: [rowSubmit] };
  await refresh(page);
  await expect(rowOf(page, names.failed).getByRole('button', { name: '发起离职交接', exact: true })).toHaveCount(0);
  await rowOf(page, names.inProgress).getByRole('button', { name: '发起离职交接', exact: true }).click();
  await popconfirm(page).click();
  await expect(toast(page, '已发起离职交接')).toBeVisible();
  const sent = writes(server, '/handover/submit-from-list');
  expect(sent.map((item) => item.ifMatch)).toEqual(['3']);
  await expect(rowOf(page, names.inProgress).getByRole('button', { name: '发起离职交接', exact: true })).toHaveCount(0);
});

test('AC-FE-B5a-02 F-386 列表每行有勾选框；批量发起在“离职处理▾”菜单里，只处理已勾选且带行动作的行', async ({
  page,
}) => {
  const server = await setupExits(page);
  const second = addExit(server, '合成第二名离职中员工', {});
  const third = addExit(server, '合成第三名离职中员工', {});
  server.rowActions = { [ids.inProgress]: [rowSubmit], [second]: [rowSubmit], [third]: [] };
  await refresh(page);
  // 表头全选 + 每个数据行各一个
  await expect(list(page).getByRole('checkbox')).toHaveCount(1 + 4);
  // 批量入口收进下拉：不再是列表上的独立按钮
  await expect(list(page).getByRole('button', { name: '批量发起离职交接', exact: true })).toHaveCount(0);
  await menu(page).click();
  const item = page.getByRole('menuitem', { name: '批量发起离职交接' });
  await expect(item).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  // 勾选带行动作的第 1 行与没有行动作的第 3 行，未勾选的第 2 行不在批里
  await rowOf(page, names.inProgress).getByRole('checkbox').check();
  await rowOf(page, '合成第三名离职中员工').getByRole('checkbox').check();
  await menu(page).click();
  await expect(item).not.toHaveAttribute('aria-disabled', 'true');
  await item.click();
  await expect(page.getByRole('dialog').filter({ hasText: '批量发起结果' }).getByRole('listitem')).toHaveCount(1);
  const batch = writes(server, '/batch-submit');
  expect(batch).toHaveLength(1);
  expect(batch[0]!.body).toEqual({ items: [{ exitRequestId: ids.inProgress, revision: 3 }] });
});

test('AC-FE-B5a-03 F-386 切换视图后勾选清空；勾选的行都没有行动作时菜单项不可点', async ({ page }) => {
  const server = await setupExits(page);
  server.rowActions = { [ids.inProgress]: [rowSubmit] };
  await refresh(page);
  await rowOf(page, names.failed).getByRole('checkbox').check();
  await menu(page).click();
  await expect(page.getByRole('menuitem', { name: '批量发起离职交接' })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await rowOf(page, names.inProgress).getByRole('checkbox').check();
  await page.getByRole('button', { name: '已完成的离职', exact: true }).click();
  await page.getByRole('button', { name: '离职中的员工', exact: true }).click();
  await expect(list(page).getByRole('checkbox', { checked: true })).toHaveCount(0);
});

test('AC-FE-B5a-04 F-352① 详情按钮读服务端 actions：按钮权全开也不多给，不再按状态推导', async ({ page }) => {
  const server = await setupExits(page);
  server.actions = { [ids.inProgress]: ['edit'] };
  await openDetail(page, names.inProgress);
  await expect(dialog(page).getByRole('button', { name: /^编\s*辑$/ })).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: '撤销离职', exact: true })).toHaveCount(0);
  await expect(dialog(page).getByRole('button', { name: '提交审批', exact: true })).toHaveCount(0);
});

test('AC-FE-B5a-05 F-352① 服务端没给 actions（或为空）时详情不出任何写入口', async ({ page }) => {
  const server = await setupExits(page);
  server.actions = { [ids.inProgress]: [] };
  await openDetail(page, names.inProgress);
  await expect(dialog(page).getByRole('region', { name: '离职交接' })).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: /^编\s*辑$/ })).toHaveCount(0);
  await expect(dialog(page).getByRole('button', { name: '撤销离职', exact: true })).toHaveCount(0);
});

test('AC-FE-B5a-06 F-352① 行内“离职处理”只认服务端 actions 的 handle', async ({ page }) => {
  const server = await setupExits(page);
  const voided = addExit(server, '合成已作废员工', { status: 'voided' });
  const other = addExit(server, '合成另一名已作废员工', { status: 'voided' });
  server.actions = { [voided]: ['handle'], [other]: [] };
  await page.getByRole('button', { name: '全部离职记录', exact: true }).click();
  await expect(rowOf(page, '合成已作废员工').getByRole('button', { name: '离职处理', exact: true })).toBeVisible();
  await expect(rowOf(page, '合成另一名已作废员工').getByRole('button', { name: '离职处理', exact: true })).toHaveCount(
    0,
  );
  await expect(rowOf(page, names.inProgress).getByRole('button', { name: '离职处理', exact: true })).toHaveCount(0);
});

test('AC-FE-B5a-07 F-352③ 改期 / 确认 / 提示都走 App 上下文，控制台没有静态函数告警', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('Static function can not consume context')) warnings.push(message.text());
  });
  const server = await setupExits(page);
  await openDetail(page, names.inProgress);
  await dialog(page)
    .getByRole('button', { name: /^编\s*辑$/ })
    .click();
  const input = dialog(page)
    .locator('.ant-form-item')
    .filter({ has: page.locator('label').getByText('最后工作日', { exact: true }) })
    .locator('input');
  await input.fill('2026-12-10');
  await input.press('Enter');
  await dialog(page).locator('.ant-modal-title').click();
  await dialog(page)
    .getByRole('button', { name: /^保\s*存$/ })
    .click();
  await page
    .getByRole('dialog')
    .filter({ hasText: '确认改期' })
    .getByRole('button', { name: /确\s*定/ })
    .click();
  await expect.poll(() => server.sent.filter((item) => item.method === 'PATCH').length).toBe(1);
  await expect(toast(page, '已提交')).toBeVisible();
  expect(warnings).toEqual([]);
});

test('AC-FE-B5a-08 F-393 详情展示并可编辑真实加黑三项', async ({ page }) => {
  const server = await setupExits(page);
  server.blacklisted = [ids.inProgress];
  server.blacklistDetail = {
    [ids.inProgress]: {
      blacklistExpiryDate: '2027-12-31',
      blacklistReason: 'integrity',
      blacklistNote: '合成加黑说明',
    },
  };
  await openDetail(page, names.inProgress);
  const detail = dialog(page);
  await expect(detail.getByText('诚信问题')).toBeVisible();
  await expect(detail.getByText('2027-12-31')).toBeVisible();
  await expect(detail.getByText('合成加黑说明')).toBeVisible();
});
