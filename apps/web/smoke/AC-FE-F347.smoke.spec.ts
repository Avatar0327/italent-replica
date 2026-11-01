import type { Page } from '@playwright/test';
import { test, expect, employee } from './fixtures.js';
import { businessId, openDetail, setup, switchView } from './probation-fixtures.js';
import { actionButton } from './action-button.js';

// F-347 转正申请服务端暂存（DEC-709 / DEC-713）与草稿修正：恢复只靠服务端，本机存储清空、不可写都不影响
// 按钮名容许 antd loading 图标残留的前缀（同 action-button.ts）：409 后自动重读期间按钮会短暂 loading
const named = (name: string) => ({ name: new RegExp(`^(?:loading\\s*)?${name.split('').join('\\s*')}$`) });
// 按钮处理中带 loading 图标，可访问名前面会多出图标名：暂存按钮只锚定结尾（rf347_1 P3）
const stageButton = (form: ReturnType<typeof dialog>) => form.getByRole('button', { name: /暂\s*存$/ });
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
  const stage = stageButton(form);
  await expect(stage).toBeVisible();
  await stage.click();
  await expect.poll(() => server.writes.length).toBe(1);
  // 等第一次暂存的回执落定（提示出现、按钮恢复可用）再操作，不靠加长超时
  await expect(page.getByText('已暂存', { exact: true })).toBeVisible();
  await expect(stage).toBeEnabled();
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
  // 新建（没有草稿单）仍要启用项：提交锁定；暂存不校验必填，仍可用（见 09）
  server.business = undefined;
  await page.reload();
  // 提交后列表停在“转正审批中”（URL 带 view），刷新后切回即将到期再开
  await switchView(page, 'expiring');
  const fresh = await openApply(page);
  await expect(fresh).toContainText('没有启用的试用结果');
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
  await switchView(page, 'expiring');
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

const recovered = (form: ReturnType<typeof dialog>) => expect(form).toContainText('已带出原申请');
const draftOf = (probationResult: string, revision = 3) => ({
  revision,
  status: 'draft',
  mode: 'application' as const,
  effectiveDate: '2026-11-01',
  probationResult,
});

test('AC-FE-F347-08 撤回单结果已停用、只改日期：PATCH 只带日期，提交同一张单（rf347_1 P2-4）', async ({ page }) => {
  const { server } = await setup(page);
  server.results = [{ code: 'pass', name: '合成通过', enabled: false }];
  server.business = draftOf('pass');
  await page.reload();
  const form = await openApply(page);
  await recovered(form);
  await form.getByLabel('转正日期', { exact: true }).fill('2026-11-10');
  await form.getByRole('button', named('提交')).click();
  await expect(form).toHaveCount(0);
  expect(sentPaths(server)).toEqual([
    ['PATCH', businessPath, '3'],
    ['POST', submitPath, '4'],
  ]);
  expect(server.writes[0]!.body).toEqual({ effectiveDate: '2026-11-10' });
  expect(server.business).toMatchObject({ status: 'in_review', effectiveDate: '2026-11-10', probationResult: 'pass' });
});

test('AC-FE-F347-09 启用字典为空：空表单可暂存、不建单；提交仍锁定（rf347_1 P2-5）', async ({ page }) => {
  const { server } = await setup(page);
  server.results = [{ code: 'pass', name: '合成通过', enabled: false }];
  await page.reload();
  const form = await openApply(page);
  await expect(form).toContainText('没有启用的试用结果');
  await expect(form.getByRole('button', named('提交'))).toBeDisabled();
  await form.getByLabel('转正日期', { exact: true }).fill('2026-11-20');
  await stageButton(form).click();
  await expect(page.getByText('已暂存', { exact: true })).toBeVisible();
  expect(sentPaths(server)).toEqual([['PUT', draftPath, '0']]);
  expect(server.writes[0]!.body).toEqual({ effectiveDate: '2026-11-20', probationResult: null });
  expect(server.business).toBeUndefined();
});

test('AC-FE-F347-10 暂存 409：重读最新暂存、保留输入，核对后显式重提，revision 递增（rf347_1 P2-6）', async ({
  page,
}) => {
  const { server } = await setup(page);
  const form = await openApply(page);
  // 另一会话在本页打开后先暂存了一份
  server.temporary = { effectiveDate: '2026-11-15', probationResult: 'pass' };
  server.temporaryRevision = 1;
  await form.getByLabel('转正日期', { exact: true }).fill('2026-11-20');
  await stageButton(form).click();
  await expect(form).toContainText('版本冲突');
  // 409 后内核已自动重读，重读按钮的可访问名可能残留 loading 前缀（action-button.ts）；再点一次重读同一视图
  await actionButton(form, '重读最新版本').click();
  await actionButton(form, '已核对差异，继续编辑').click();
  await expect(form.getByLabel('转正日期', { exact: true })).toHaveValue('2026-11-20');
  await expect(selected(form)).toHaveText('合成通过');
  await stageButton(form).click();
  await expect.poll(() => server.temporaryRevision).toBe(2);
  await expect(stageButton(form)).toBeEnabled();
  await stageButton(form).click();
  await expect.poll(() => server.temporaryRevision).toBe(3);
  expect(sentPaths(server)).toEqual([
    ['PUT', draftPath, '0'],
    ['PUT', draftPath, '1'],
    ['PUT', draftPath, '2'],
  ]);
  expect(server.writes[1]!.body).toEqual({ effectiveDate: '2026-11-20', probationResult: 'pass' });
  expect(server.temporary).toEqual({ effectiveDate: '2026-11-20', probationResult: 'pass' });
});

test('AC-FE-F347-11 打开后别人建了申请草稿单：暂存 409 不写，重读进入该申请单（rf347_1 P2-3）', async ({ page }) => {
  const { server } = await setup(page);
  const form = await openApply(page);
  await form.getByLabel('转正日期', { exact: true }).fill('2026-11-20');
  server.business = draftOf('pass', 1);
  server.employeeRevision = 5;
  // 冲突提示会被随后的自动重读、进入申请单很快替换，按 PUT 回执断言 409，不靠瞬时文案
  const staged = page.waitForResponse((r) => r.url().endsWith(draftPath) && r.request().method() === 'PUT');
  await stageButton(form).click();
  expect((await staged).status()).toBe(409);
  expect(server.temporary).toBeUndefined();
  // 409 后内核自动重读暂存视图：视图带出申请单即进入那张单
  await recovered(form);
  await expect(form.getByLabel('转正日期', { exact: true })).toHaveValue('2026-11-01');
  await expect(selected(form)).toHaveText('合成通过');
  await form.getByRole('button', named('提交')).click();
  await expect(form).toHaveCount(0);
  expect(sentPaths(server)).toEqual([
    ['PUT', draftPath, '0'],
    ['POST', submitPath, '1'],
  ]);
  expect(server.temporary).toBeUndefined();
});

test('AC-FE-F347-12 草稿单 409：重读投影最新全部字段，只改的日期保留、别人改的结果跟随（rf347_1 P2-1）', async ({
  page,
}) => {
  const { server } = await setup(page);
  server.results.push({ code: 'extend', name: '合成延期', enabled: true });
  server.business = draftOf('pass');
  await page.reload();
  const form = await openApply(page);
  await recovered(form);
  // 另一会话把结果改成 extend
  server.business = { ...server.business, revision: 4, probationResult: 'extend', probationResultName: '合成延期' };
  await form.getByLabel('转正日期', { exact: true }).fill('2026-11-10');
  await form.getByRole('button', named('提交')).click();
  await expect(form).toContainText('版本冲突');
  await actionButton(form, '已核对差异，继续编辑').click();
  await expect(form.getByLabel('转正日期', { exact: true })).toHaveValue('2026-11-10');
  await expect(selected(form)).toHaveText('合成延期');
  await form.getByRole('button', named('提交')).click();
  await expect(form).toHaveCount(0);
  expect(sentPaths(server)).toEqual([
    ['PATCH', businessPath, '3'],
    ['PATCH', businessPath, '4'],
    ['POST', submitPath, '5'],
  ]);
  expect(server.writes[1]!.body).toEqual({ effectiveDate: '2026-11-10', probationResult: 'extend' });
  expect(server.business).toMatchObject({
    status: 'in_review',
    effectiveDate: '2026-11-10',
    probationResult: 'extend',
  });
});

test('AC-FE-F347-13 字典改名后：已存结果仍显示保存时名称（等字典选项渲染后断言，rf347_1 P2-7）', async ({ page }) => {
  const { server } = await setup(page);
  server.results = [
    { code: 'pass', name: '改名后的名称', enabled: true },
    { code: 'other', name: '另一启用项', enabled: true },
  ];
  server.business = { ...draftOf('pass'), probationResultName: '保存时名称' };
  await page.reload();
  const form = await openApply(page);
  await recovered(form);
  await form
    .getByRole('combobox', { name: '试用结果', exact: true })
    .locator('xpath=ancestor::div[contains(@class,"ant-select-selector")]')
    .click();
  // 无关启用项出现即字典已加载并渲染，与已存结果的名称无关
  await expect(page.locator('.ant-select-dropdown:visible').getByText('另一启用项', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(selected(form)).toHaveText('保存时名称');
});
