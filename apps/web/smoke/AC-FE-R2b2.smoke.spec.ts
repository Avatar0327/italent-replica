import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { choose, item, named, pickDate, save } from './contracts-fixtures.js';
import { companyId, entryId, nextId, setupEntries, typeId } from './entry-fixtures.js';

// 首个行为门禁：旧实现没有 entries 菜单；不靠 import 不存在的文件制造红测。
// TODO(需取证 #363)：FormOverlay 的暂存底栏与标题工具区契约合入后，继续本片实现并跑绿。
async function entryPage(page: Page, baseURL: string) {
  const state = await setupEntries(page, baseURL);
  await expect(page.getByRole('menuitem', { name: '入职管理', exact: true })).toBeVisible({ timeout: 5000 });
  return state;
}
const tab = (page: Page, text: string) => page.getByRole('tab', { name: text, exact: true });
const row = (page: Page) => page.getByRole('row').filter({ hasText: '合成入职甲' });
async function onboard(page: Page) {
  await row(page)
    .getByRole('button', { name: /更多|▾/ })
    .click();
  await page.getByRole('menuitem', { name: '入职', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '入职', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function selectedAction(page: Page, label: string) {
  await row(page).getByRole('checkbox').check();
  if (await page.getByRole('button', { name: label, exact: true }).count())
    await page.getByRole('button', { name: label, exact: true }).click();
  else {
    await page.getByRole('button', { name: /更多操作/ }).click();
    await page.getByRole('menuitem', { name: label, exact: true }).click();
  }
  return page.getByRole('dialog', { name: label, exact: true });
}

test('AC-FE-R2b2-01 菜单、四视图请求和列头', async ({ page, baseURL }) => {
  const state = await entryPage(page, baseURL!);
  for (const [view, label, column] of [
    ['all', '全部待入职', '计划入职日期'],
    ['today', '今日待入职', '报到日期'],
    ['cancelled', '已取消入职', '取消说明'],
    ['hired', '已入职', '当前状态'],
  ]) {
    await tab(page, label!).click();
    await expect(page.getByRole('columnheader', { name: column, exact: true })).toBeVisible();
    await expect.poll(() => state.reads.some((url) => url.includes(`view=${view}`))).toBe(true);
  }
  expect(state.writes).toEqual([]);
});

test('AC-FE-R2b2-02 已取消不能入职，已入职只读', async ({ page, baseURL }) => {
  const state = await entryPage(page, baseURL!);
  state.row.entryStatus = 1;
  await tab(page, '已取消入职').click();
  await expect(row(page)).toContainText('取消');
  await expect(row(page).getByRole('button', named('入职'))).toHaveCount(0);
  await expect(row(page).getByRole('button', { name: /更多|▾/ })).toHaveCount(0);
  state.row.employeeStatus = 2;
  await tab(page, '已入职').click();
  await expect(row(page)).toContainText('试用');
  await expect(row(page).locator('button:enabled')).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

test('AC-FE-R2b2-03 AC-EN-08 日期自动计算、手改、终止日必填和办理入职', async ({ page, baseURL }) => {
  const state = await entryPage(page, baseURL!);
  const dialog = await onboard(page);
  for (const title of ['员工信息', '汇报关系', '合同协议', '入职定薪', '社保信息'])
    await expect(dialog.getByRole('heading', { name: title, exact: true })).toBeAttached();
  await expect(dialog.getByRole('button', named('暂存'))).toBeDisabled();
  await choose(dialog, '是否有试用期', '是');
  await choose(dialog, '试用期(月)', '1');
  await expect(item(dialog, '预计试用结束日期').getByRole('textbox')).toHaveValue('2026-11-14');
  await pickDate(dialog, '预计试用结束日期', '2026-11-13');
  await choose(dialog, '法人公司', '合成法人公司');
  await choose(dialog, '合同类型', '合成合同类型');
  await choose(dialog, '期限类型', '固定期限');
  await dialog.getByRole('button', save).click();
  await expect(item(dialog, '终止日期')).toContainText('必填');
  expect(state.writes).toEqual([]);
  await pickDate(dialog, '终止日期', '2027-10-14');
  await dialog.getByRole('button', save).click();
  await expect(dialog).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({
    path: `/api/tenant/employment/pending-entries/${entryId}/complete`,
    method: 'POST',
    revision: '4',
    body: {
      probation: true,
      contract: {
        companyId,
        typeId,
        termType: 'fixed',
        endDate: '2027-10-14',
        probationStartDate: '2026-10-15',
        probationEndDate: '2026-11-13',
      },
    },
  });
  expect(state.writes[0]!.command).toBeTruthy();
  expect(Object.keys(state.writes[0]!.body as object).sort()).toEqual(['contract', 'probation']);
  await expect(row(page)).toHaveCount(0);
  await tab(page, '已入职').click();
  await expect(row(page)).toContainText('试用');
});

test('AC-FE-R2b2-04 后端错误原文呈现', async ({ page, baseURL }) => {
  const state = await entryPage(page, baseURL!);
  state.error = '合成后端原文：请核对部门生效时点';
  const dialog = await onboard(page);
  await choose(dialog, '是否有试用期', '否');
  await dialog.getByRole('button', save).click();
  await expect(dialog.getByText(state.error, { exact: true })).toBeVisible();
  expect(state.writes[0]!.body).toEqual({ probation: false });
});

for (const [status, reason, text] of [
  ['generated', '', 'synthetic.entry@example.invalid'],
  ['failed', 'PREFIX_EMPTY', '前缀为空'],
  ['failed', 'PREFIX_ILLEGAL', '非法字符'],
  ['skipped', 'REHIRE_NOT_GENERATED', '重聘'],
  ['no_rule', '', '规则'],
])
  test(`AC-FE-R2b2-05 AC-EN-06 邮箱 ${status}/${reason}`, async ({ page, baseURL }) => {
    const state = await entryPage(page, baseURL!);
    if (status !== 'generated')
      state.email = {
        status: status!,
        ...(reason ? { reason } : {}),
        ...(status === 'failed' ? { ruleId: typeId, ruleName: '合成邮箱规则' } : {}),
      };
    const dialog = await onboard(page);
    await dialog.getByRole('button', { name: '生成邮箱', exact: true }).click();
    await expect(dialog).toContainText(text!);
    if (status === 'generated') await expect(dialog).toContainText('合成邮箱规则');
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toMatchObject({
      body: {},
      revision: '4',
      path: `/api/tenant/employment/pending-entries/${entryId}/generate-email`,
    });
  });

test('AC-FE-R2b2-06 AC-EN-03 改期校验与新 ID 重读', async ({ page, baseURL }) => {
  const state = await entryPage(page, baseURL!);
  const dialog = await selectedAction(page, '改期入职');
  await dialog.getByRole('button', save).click();
  await expect(item(dialog, '入职日期')).toContainText('必填');
  expect(state.writes).toEqual([]);
  await pickDate(dialog, '入职日期', '2026-10-25');
  const before = state.reads.length;
  await dialog.getByRole('button', save).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page)).toContainText('延期');
  await expect(row(page)).toContainText('2026-10-25');
  expect(state.row.id).toBe(nextId);
  expect(state.reads.slice(before).some((url) => url.includes('/pending-entries?'))).toBe(true);
  await expect(page.getByText('改期入职成功', { exact: true })).toBeVisible();
});

test('AC-FE-R2b2-07 取消后进入已取消，再改期恢复', async ({ page, baseURL }) => {
  const state = await entryPage(page, baseURL!);
  const cancel = await selectedAction(page, '取消入职');
  await choose(cancel, '取消入职原因', '个人原因');
  await cancel.getByRole('button', save).click();
  await expect(cancel).toHaveCount(0);
  await expect(row(page)).toHaveCount(0);
  expect(state.writes[0]!.body).toEqual({ reason: 'personal' });
  await tab(page, '已取消入职').click();
  await expect(row(page)).toContainText('取消');
  const postpone = await selectedAction(page, '改期入职');
  await pickDate(postpone, '入职日期', '2026-10-25');
  await postpone.getByRole('button', save).click();
  await expect(postpone).toHaveCount(0);
  await tab(page, '全部待入职').click();
  await expect(row(page)).toContainText('延期');
});

test('AC-FE-R2b2-08 删除气泡确认后四视图不可见', async ({ page, baseURL }) => {
  const state = await entryPage(page, baseURL!);
  await row(page)
    .getByRole('button', { name: /更多|▾/ })
    .click();
  await page.getByRole('menuitem', { name: '删除人员', exact: true }).click();
  await expect(page.getByText('删除的人员将不可恢复，是否继续？', { exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
  await page.getByRole('button', named('是')).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]).toMatchObject({
    method: 'DELETE',
    revision: '4',
    path: `/api/tenant/employment/pending-entries/${entryId}`,
  });
  for (const label of ['今日待入职', '已取消入职', '已入职', '全部待入职']) {
    await tab(page, label).click();
    await expect(row(page)).toHaveCount(0);
  }
});
