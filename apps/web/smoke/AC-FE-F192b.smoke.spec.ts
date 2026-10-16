import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { capture, item, named, pickDate, save, type Write } from './contracts-fixtures.js';
import { entryId, nextId, setupEntries } from './entry-fixtures.js';

const row = (page: Page) => page.getByRole('row').filter({ hasText: '合成入职甲' });
const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });
const more = (page: Page) => page.locator('.ant-tabs-extra-content').getByRole('button', { name: /更多操作/ });
const cancelItem = (page: Page) => page.getByRole('menuitem', named('取消入职'));
async function openCancel(page: Page) {
  await row(page).getByRole('checkbox').check();
  await more(page).click();
  await cancelItem(page).click();
  return page.getByRole('dialog', { name: /^取消入职/ });
}
async function cancelledView(page: Page) {
  await tab(page, '已取消入职').click();
  await expect(row(page)).toContainText('取消');
  await expect(row(page)).toContainText('2026-10-15');
  return row(page).getByRole('cell').nth(6);
}

test('AC-FE-F192b-01 菜单顺序、滚动、零/单/多选与入口边界', async ({ page, baseURL }) => {
  const state = await setupEntries(page, baseURL!);
  await more(page).click();
  await expect(cancelItem(page)).toBeVisible({ timeout: 5000 });
  await expect(cancelItem(page)).toHaveAttribute('aria-disabled', 'true');
  const menu = page.getByRole('menu').filter({ has: cancelItem(page) });
  const labels = await menu.getByRole('menuitem').allTextContents();
  expect(labels).toContain('取消入职');
  const index = labels.indexOf('取消入职');
  expect(labels.slice(index - 1, index + 2)).toEqual(['改期入职', '取消入职', '发起电子签署']);
  expect(await menu.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await page.keyboard.press('Escape');
  await row(page).getByRole('checkbox').check();
  await more(page).click();
  await expect(cancelItem(page)).not.toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await row(page).getByRole('button', named('更多操作')).click();
  await expect(page.locator('.ant-dropdown:visible').getByRole('menuitem', named('取消入职'))).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.route('**/pending-entries?*', (route) =>
    route.fulfill({
      json: { items: [state.row, { ...state.row, id: nextId, name: '合成入职乙' }], page: 1, pageSize: 30 },
    }),
  );
  await page.reload();
  await page.getByRole('row').filter({ hasText: '合成入职甲' }).getByRole('checkbox').check();
  await page.getByRole('row').filter({ hasText: '合成入职乙' }).getByRole('checkbox').check();
  await more(page).click();
  await expect(cancelItem(page)).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await tab(page, '今日待入职').click();
  await expect(more(page)).toBeDisabled();
  expect(state.writes).toEqual([]);
});

for (const remark of ['合成备注：另有安排', ''])
  test(`AC-FE-F192b-02/03 弹窗默认、选项、直接保存及${remark ? '备注' : '空备注 --'}读回`, async ({
    page,
    baseURL,
  }) => {
    const state = await setupEntries(page, baseURL!);
    const dialog = await openCancel(page);
    await expect(dialog).toContainText('1. 【新增入职】取消待入职后，若需恢复入职，可使用【改期入职】功能');
    await expect(dialog).toContainText('2. 非【新增入职】取消待入职后，待入职记录将被删除。');
    await expect(dialog.locator('.ant-form-item-required')).toHaveCount(0);
    await expect(item(dialog, '取消入职原因')).toContainText('其他原因');
    await item(dialog, '取消入职原因').locator('.ant-select-selector').click();
    const options = page.locator('.ant-select-dropdown:visible .ant-select-item-option-content');
    await expect(options).toHaveText(['薪酬福利不满意', '发展空间受限', '有更好的工作机会', '个人原因', '其他原因']);
    await options.filter({ hasText: remark ? /^个人原因$/ : /^其他原因$/ }).click();
    if (remark) await item(dialog, '备注').getByRole('textbox').fill(remark);
    const before = state.reads.length;
    await dialog.getByRole('button', save).click();
    await expect(dialog).toHaveCount(0);
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toMatchObject({
      method: 'POST',
      path: `/api/tenant/employment/pending-entries/${entryId}/cancel`,
      revision: '4',
      body: { reason: remark ? 'personal' : 'other', ...(remark ? { remark } : {}) },
    });
    expect(state.writes[0]!.command).toBeTruthy();
    expect(state.reads.slice(before).some((path) => path.includes('pending-entries?'))).toBe(true);
    await expect(row(page)).toHaveCount(0);
    await expect(await cancelledView(page)).toHaveText(remark || '--');
    // 重载只能从服务端行取得说明，不能依赖刚才弹窗的提交缓存。
    await page.reload();
    await expect(await cancelledView(page)).toHaveText(remark || '--');
  });

test('AC-FE-F192b-05 取消后改期恢复（过去日期）返回全部待入职、延期', async ({ page, baseURL }) => {
  const state = await setupEntries(page, baseURL!);
  const cancel = await openCancel(page);
  await item(cancel, '备注').getByRole('textbox').fill('合成旧说明');
  await cancel.getByRole('button', save).click();
  await expect(cancel).toHaveCount(0);
  await cancelledView(page);
  await row(page).getByRole('checkbox').check();
  await page.getByRole('button', named('改期入职')).click();
  const restore = page.getByRole('dialog', { name: /^改期入职/ });
  await pickDate(restore, '入职日期', '2026-10-01');
  await restore.getByRole('button', save).click();
  await expect(restore).toHaveCount(0);
  await expect(row(page)).toHaveCount(0);
  await tab(page, '全部待入职').click();
  await expect(row(page)).toContainText('延期');
  await expect(row(page)).toContainText('2026-10-01');
  expect(state.row.id).toBe(nextId);
  expect(state.row.cancelRemark).toBeNull();
});

for (const code of ['REVISION_CONFLICT', 'CONFLICT'])
  test(`AC-FE-F192b-04 ${code} 重读核对，已取消不可再发新取消命令`, async ({ page, baseURL }) => {
    const state = await setupEntries(page, baseURL!);
    const attempts: Write[] = [];
    await page.route('**/pending-entries/*/cancel', (route) => {
      capture(attempts, route.request());
      if (attempts.length > 1) return route.fallback();
      Object.assign(state.row, {
        revision: 8,
        ...(code === 'CONFLICT' ? { entryStatus: 1, cancelRemark: '他人说明' } : {}),
      });
      return route.fulfill({ status: 409, json: { error: { code, message: '合成冲突' } } });
    });
    const dialog = await openCancel(page);
    await item(dialog, '备注').getByRole('textbox').fill('我的合成说明');
    await dialog.getByRole('button', save).click();
    await expect(dialog.getByRole('button', save)).toBeDisabled();
    await dialog.getByRole('button', named('重读最新版本')).click();
    await dialog.getByRole('button', named('已核对差异，继续编辑')).click();
    if (code === 'CONFLICT') {
      await expect(dialog.getByRole('button', save)).toBeDisabled();
      await expect(item(dialog, '备注')).toContainText('他人说明');
      expect(attempts).toHaveLength(1);
    } else {
      await expect(item(dialog, '备注').getByRole('textbox')).toHaveValue('我的合成说明');
      await expect(item(dialog, '取消入职原因')).toContainText('其他原因');
      await dialog.getByRole('button', save).click();
      await expect(dialog).toHaveCount(0);
      expect(attempts[1]).toMatchObject({ revision: '8', body: { reason: 'other', remark: '我的合成说明' } });
    }
  });

for (const failure of ['network', 'receipt', 'read'])
  test(`AC-FE-F192b-04 ${failure} 未知锁跨关闭/视图/动作，不换命令`, async ({ page, baseURL }) => {
    const state = await setupEntries(page, baseURL!);
    let attempts = 0;
    let failRead = true;
    await page.route('**/pending-entries/*/cancel', (route) => {
      attempts++;
      if (failure === 'network') return route.abort();
      if (failure === 'receipt')
        return route.fulfill({ json: { id: entryId, revision: 4, employeeId: state.row.employeeId } });
      return route.fallback();
    });
    if (failure === 'read')
      await page.route('**/pending-entries?*', (route) =>
        failRead && attempts
          ? route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE' } } })
          : route.fallback(),
      );
    let dialog = await openCancel(page);
    await dialog.getByRole('button', save).click();
    await expect(dialog.getByRole('button', named('回查原单'))).toBeVisible();
    await expect(dialog.getByRole('button', save)).toBeDisabled();
    await dialog.getByRole('button', named('取消')).click();
    failRead = false;
    await tab(page, '已取消入职').click();
    if (failure === 'read') {
      await row(page).getByRole('checkbox').check();
      await page.getByRole('button', named('改期入职')).click();
      dialog = page.getByRole('dialog', { name: /^改期入职/ });
    } else {
      await tab(page, '全部待入职').click();
      dialog = await openCancel(page);
      await dialog.getByRole('button', named('回查原单')).click();
      await expect(dialog).toContainText('原单当前值');
      await expect(item(dialog, '备注').getByRole('textbox')).toBeDisabled();
    }
    await expect(dialog.getByRole('button', save)).toBeDisabled();
    expect(attempts).toBe(1);
  });

for (const denied of ['update', 'field', 'button', 'rehire'])
  test(`AC-FE-F192b-06 ${denied} 取消权限与改期权限分别校验`, async ({ page, baseURL }) => {
    const state = await setupEntries(page, baseURL!);
    if (denied === 'rehire') state.row.kind = 'rehire';
    if (denied !== 'rehire')
      await page.route('**/permission/me/objects/*', (route) =>
        route.fulfill({
          json: {
            objectCode: 'TenantBase.EmploymentRecord',
            dataOperations: { update: denied !== 'update' },
            viewableFields: ['effectiveDate'],
            editableFields: denied === 'field' ? [] : ['effectiveDate'],
            buttons: denied === 'button' ? [] : [{ buttonCode: 'Employment.Edit', level: 'detail' }],
          },
        }),
      );
    await page.reload();
    await row(page).getByRole('checkbox').check();
    await more(page).click();
    if (denied === 'field') {
      await expect(cancelItem(page)).not.toHaveAttribute('aria-disabled', 'true');
      await expect(page.getByRole('menuitem', named('改期入职'))).toHaveAttribute('aria-disabled', 'true');
      await cancelItem(page).click();
      const dialog = page.getByRole('dialog', { name: /^取消入职/ });
      await expect(dialog.getByRole('button', save)).toBeEnabled();
      await dialog.getByRole('button', save).click();
      await expect(dialog).toHaveCount(0);
      expect(state.writes).toHaveLength(1);
      expect(state.writes[0]).toMatchObject({
        method: 'POST',
        path: `/api/tenant/employment/pending-entries/${entryId}/cancel`,
        revision: '4',
        body: { reason: 'other' },
      });
      await expect(row(page)).toHaveCount(0);
      await expect(await cancelledView(page)).toHaveText('--');
    } else {
      if (denied === 'rehire') await expect(cancelItem(page)).toHaveAttribute('aria-disabled', 'true');
      else await expect(cancelItem(page)).toHaveCount(0);
      expect(state.writes).toEqual([]);
    }
  });

test('AC-FE-F192b-04 回执成功至列表读回期间持续锁定，状态裁剪不丢取消说明', async ({ page, baseURL }) => {
  const state = await setupEntries(page, baseURL!);
  state.hidden = ['entryStatus', 'employeeStatus'];
  let release!: () => void;
  const reading = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/pending-entries?*', async (route) => {
    if (state.writes.length) await reading;
    return route.fallback();
  });
  const dialog = await openCancel(page);
  await item(dialog, '备注').getByRole('textbox').fill('合成服务端说明');
  await dialog.getByRole('button', save).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(dialog.getByRole('button', save)).toBeDisabled();
  await expect(dialog.getByRole('button', named('取消'))).toBeDisabled();
  await expect(item(dialog, '备注').getByRole('textbox')).toBeDisabled();
  release();
  await expect(dialog).toHaveCount(0);
  await tab(page, '已取消入职').click();
  await expect(row(page)).toContainText('合成服务端说明');
  expect(state.writes).toHaveLength(1);
});
