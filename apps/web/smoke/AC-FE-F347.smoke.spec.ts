import type { Page } from '@playwright/test';
import { test, expect, employee } from './fixtures.js';
import { businessId, openDetail, setup, switchView } from './probation-fixtures.js';

// F-347 转正申请服务端暂存（DEC-709 / DEC-713）与草稿修正：恢复只靠服务端，本机存储清空、不可写都不影响
const named = (name: string) => ({ name: new RegExp(`^${name.split('').join('\\s*')}$`) });
const dialog = (page: Page, title: string) => page.getByRole('dialog', { name: title, exact: true });
const draftPath = `/api/tenant/employment/employees/${employee}/regularization-draft`;
const create = `/api/tenant/employment/employees/${employee}/businesses`;
const businessPath = `/api/tenant/employment/businesses/${businessId}`;
const submitPath = `${businessPath}/submit`;
const withdrawPath = `${businessPath}/withdraw`;
const sentPaths = (server: { writes: { method: string; path: string; ifMatch?: string }[] }) =>
  server.writes.map(({ method, path, ifMatch }) => [method, path, ifMatch]);

async function pick(page: Page, form: ReturnType<typeof dialog>, label: string) {
  await form
    .getByRole('combobox', { name: '试用结果', exact: true })
    .locator('xpath=ancestor::div[contains(@class,"ant-select-selector")]')
    .click();
  await page.locator('.ant-select-dropdown:visible').getByText(label, { exact: true }).click();
}
async function openApply(page: Page) {
  await openDetail(page);
  await page.getByRole('button', named('转正申请')).click();
  return dialog(page, '转正申请');
}
const selected = (form: ReturnType<typeof dialog>) =>
  form.locator('.ant-form-item').filter({ hasText: '试用结果' }).locator('.ant-select-selection-item');
/** 换设备：本机存储一律清空后再打开页面。 */
const freshDevice = (page: Page) => page.addInitScript(() => localStorage.clear());

test('AC-FE-F347-01 暂存不校验必填、再暂存覆盖；不建单、不提交', async ({ page }) => {
  const { server } = await setup(page);
  const form = await openApply(page);
  const stage = form.getByRole('button', named('暂存'));
  await expect(stage).toBeVisible();
  await stage.click();
  await expect.poll(() => server.writes.length).toBe(1);
  await form.getByLabel('转正日期', { exact: true }).fill('2026-11-20');
  await stage.click();
  await expect.poll(() => server.writes.length).toBe(2);
  expect(sentPaths(server)).toEqual([
    ['PUT', draftPath, '0'],
    ['PUT', draftPath, '1'],
  ]);
  expect(server.writes.map((write) => write.body)).toEqual([
    { effectiveDate: '2026-11-01', probationResult: null },
    { effectiveDate: '2026-11-20', probationResult: null },
  ]);
  expect(server.business).toBeUndefined();
});

test('AC-FE-F347-02 换设备打开：带出服务端暂存并提示，提交后走两步建单', async ({ page }) => {
  await freshDevice(page);
  const { server } = await setup(page);
  server.temporary = { effectiveDate: '2026-11-15', probationResult: 'pass' };
  server.temporaryRevision = 3;
  const form = await openApply(page);
  await expect(form).toContainText('已带出上次暂存信息');
  await expect(form.getByText('点击清除', { exact: true })).toBeVisible();
  await expect(form.getByLabel('转正日期', { exact: true })).toHaveValue('2026-11-15');
  await expect(selected(form)).toHaveText('合成通过');
  await form.getByRole('button', named('提交')).click();
  await expect(form).toHaveCount(0);
  expect(sentPaths(server)).toEqual([
    ['POST', create, '4'],
    ['POST', submitPath, '1'],
  ]);
  expect(server.writes[0]!.body).toMatchObject({ effectiveDate: '2026-11-15', probationResult: 'pass' });
  expect(server.temporary).toBeUndefined();
});

test('AC-FE-F347-03 点击清除：表单回系统默认值，不发任何写请求；关闭重开仍带出暂存（DEC-713）', async ({ page }) => {
  const { server } = await setup(page);
  server.temporary = { effectiveDate: '2026-11-15', probationResult: 'pass' };
  server.temporaryRevision = 1;
  const form = await openApply(page);
  await expect(form.getByLabel('转正日期', { exact: true })).toHaveValue('2026-11-15');
  await form.getByText('点击清除', { exact: true }).click();
  await expect(form.getByLabel('转正日期', { exact: true })).toHaveValue('2026-11-01');
  await expect(selected(form)).toHaveCount(0);
  await form.getByRole('button', named('取消')).click();
  await expect(form).toHaveCount(0);
  await page.getByRole('button', named('转正申请')).click();
  await expect(form).toContainText('已带出上次暂存信息');
  await expect(form.getByLabel('转正日期', { exact: true })).toHaveValue('2026-11-15');
  expect(server.writes).toEqual([]);
});

test('AC-FE-F347-04 本机存储不可写、第二步失败后刷新：按服务端草稿同单提交，不建第二张（R2 P2 回归）', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('synthetic quota', 'QuotaExceededError');
    };
  });
  const { server } = await setup(page);
  server.rejectSubmits = 1;
  const form = await openApply(page);
  await pick(page, form, '合成通过');
  await form.getByRole('button', named('提交')).click();
  await expect(form).toContainText('没有可用的转正流程');
  await page.reload();
  const again = await openApply(page);
  await expect(again).toContainText('已带出原申请');
  await again.getByRole('button', { name: /提\s*交$/ }).click();
  await expect(again).toHaveCount(0);
  expect(sentPaths(server)).toEqual([
    ['POST', create, '4'],
    ['POST', submitPath, '1'],
    ['POST', submitPath, '1'],
  ]);
});

test('AC-FE-F347-05 撤回后换设备：改转正日期与试用结果，先 PATCH 再同单重提（c）', async ({ page }) => {
  const { server } = await setup(page);
  server.results.push({ code: 'extend', name: '合成延期', enabled: true });
  server.business = {
    revision: 3,
    status: 'draft',
    mode: 'application',
    effectiveDate: '2026-11-01',
    probationResult: 'pass',
  };
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await switchView(page, 'expiring');
  const form = await openApply(page);
  await expect(form).toContainText('已带出原申请');
  const dateInput = form.getByLabel('转正日期', { exact: true });
  await expect(dateInput).toHaveValue('2026-11-01');
  await expect(selected(form)).toHaveText('合成通过');
  await expect(dateInput).toBeEnabled();
  await dateInput.fill('2026-11-10');
  await pick(page, form, '合成延期');
  await form.getByRole('button', named('提交')).click();
  await expect(form).toHaveCount(0);
  expect(sentPaths(server)).toEqual([
    ['PATCH', businessPath, '3'],
    ['POST', submitPath, '4'],
  ]);
  expect(server.writes[0]!.body).toEqual({ effectiveDate: '2026-11-10', probationResult: 'extend' });
  expect(server.business).toMatchObject({ status: 'in_review', probationResult: 'extend' });
});

test('AC-FE-F347-06 启用字典为空：撤回单带已存结果（含停用项名称）仍可提交；新建仍锁定（e）', async ({ page }) => {
  const { server } = await setup(page);
  server.results = [{ code: 'pass', name: '合成通过', enabled: false }];
  server.business = {
    revision: 3,
    status: 'draft',
    mode: 'application',
    effectiveDate: '2026-11-01',
    probationResult: 'pass',
  };
  await page.reload();
  const form = await openApply(page);
  await expect(selected(form)).toHaveText('合成通过');
  const submit = form.getByRole('button', named('提交'));
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(form).toHaveCount(0);
  expect(sentPaths(server)).toEqual([['POST', submitPath, '3']]);
  // 新建（没有草稿单）仍要启用项：提交与暂存都锁定
  server.business = undefined;
  await page.reload();
  const fresh = await openApply(page);
  await expect(fresh).toContainText('没有可用的试用结果');
  await expect(fresh.getByRole('button', named('提交'))).toBeDisabled();
});

test('AC-FE-F347-07 撤回后清空本机存储再刷新：仍找回原申请同单重提（DEC-103）', async ({ page }) => {
  const { server } = await setup(page);
  const form = await openApply(page);
  await pick(page, form, '合成通过');
  await form.getByRole('button', named('提交')).click();
  await expect(form).toHaveCount(0);
  await openDetail(page);
  await page.getByRole('button', named('撤回')).click();
  await page.locator('.ant-popconfirm').getByRole('button', named('确定')).click();
  await expect(page.getByText('已撤回')).toBeVisible();
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const again = await openApply(page);
  await expect(again).toContainText('已带出原申请');
  await again.getByRole('button', { name: /提\s*交$/ }).click();
  await expect(again).toHaveCount(0);
  expect(sentPaths(server)).toEqual([
    ['POST', create, '4'],
    ['POST', submitPath, '1'],
    ['POST', withdrawPath, '2'],
    ['POST', submitPath, '3'],
  ]);
});
