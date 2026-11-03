import type { Page } from '@playwright/test';
import { otherSettingsMenu } from './account-stop-fixtures.js';
import { actionButton } from './action-button.js';
import { capture, save, type Write } from './contracts-fixtures.js';
import { terminationDefault, terminationRejected } from './exit-termination-fixtures.js';
import { expect, snapshotFixture, test, user } from './fixtures.js';

const PATH = '/api/tenant/settings/exit.termination_flow_types';
const TITLE = '离职/退休生效时终止在途流程';
const form = (page: Page) => page.getByRole('region', { name: TITLE, exact: true });
const box = (page: Page, name: string) => form(page).getByRole('checkbox', { name, exact: true });
const saveButton = (page: Page) => form(page).getByRole('button', save);
async function setup(page: Page) {
  const server = { setting: structuredClone(terminationDefault), writes: [] as Write[], mode: 'save' };
  await page.route('**/permission/me/snapshot', (route) => {
    const body = structuredClone(snapshotFixture);
    body.adminMenus = [...body.adminMenus, otherSettingsMenu];
    return route.fulfill({ json: body });
  });
  await page.route(`**${PATH}`, (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: server.setting });
    capture(server.writes, route.request());
    const write = server.writes.at(-1)!;
    if (server.mode === 'reject') return route.fulfill({ status: 400, json: terminationRejected });
    if (server.mode === 'unknown') return route.abort('connectionreset');
    if (write.revision !== String(server.setting.revision))
      return route.fulfill({
        status: 409,
        json: { error: { code: 'REVISION_CONFLICT', message: '配置已被他人修改' } },
      });
    server.setting = {
      ...server.setting,
      value: (write.body as { value: Record<string, boolean> }).value,
      revision: server.setting.revision + 1,
      source: 'tenant',
    };
    return route.fulfill({ json: server.setting });
  });
  await page.setViewportSize({ width: 1512, height: 900 });
  await page.goto('/exit-settings');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.waitForURL('**/staff');
  await page.goto('/exit-settings/termination-flows');
  await expect(page.getByRole('tab', { name: TITLE, selected: true })).toBeVisible();
  return server;
}

test('AC-FE-F419-01 28 类四组、固定项、三类调动独立保存；409 核对重读后改回原值', async ({ page }) => {
  const server = await setup(page);
  await expect(form(page).getByRole('checkbox')).toHaveCount(28);
  await expect(form(page).getByRole('heading', { level: 2 })).toHaveText([
    '任职流程',
    '合同流程',
    '考核流程',
    '个人信息流程',
  ]);
  await expect(box(page, '新增兼职')).toBeChecked();
  await expect(box(page, '新增兼职')).toBeDisabled();
  await expect(box(page, '新建合同协议')).not.toBeChecked();
  await box(page, '机构间调动').uncheck();
  await box(page, '批量调动').uncheck();
  await saveButton(page).click();
  await expect.poll(() => server.setting.revision).toBe(1);
  await expect(box(page, '调动')).toBeChecked();
  await expect(box(page, '批量调动')).not.toBeChecked();
  // 后台别人更新了两个值；本人只改调动。重读后未改的新建合同回填，改回原值仍可提交。
  server.setting = {
    ...server.setting,
    revision: 2,
    value: { ...server.setting.value, transfer: false, contract_create: true },
  };
  await box(page, '调动').uncheck();
  await saveButton(page).click();
  await expect(form(page).getByText('版本冲突：输入已保留')).toBeVisible();
  await actionButton(form(page), '重读最新版本').click();
  await actionButton(form(page), '已核对差异，继续编辑').click();
  await expect(box(page, '新建合同协议')).toBeChecked();
  await box(page, '调动').check();
  await saveButton(page).click();
  await expect.poll(() => server.setting.revision).toBe(3);
  expect(server.writes.map((write) => write.revision)).toEqual(['0', '1', '2']);
  expect(server.setting.value).toMatchObject({
    transfer: true,
    inter_org_transfer: false,
    batch_transfer: false,
    contract_create: true,
  });
});

test('AC-FE-F419-02 明确拒绝保留输入；结果未知换页签、后退前进仍锁定', async ({ page }) => {
  const server = await setup(page);
  server.mode = 'reject';
  await box(page, '调动').uncheck();
  await saveButton(page).click();
  await expect(form(page).getByText('配置值不合法')).toBeVisible();
  await expect(box(page, '调动')).not.toBeChecked();
  await expect(saveButton(page)).toBeEnabled();
  server.mode = 'unknown';
  await saveButton(page).click();
  const locked = async () => {
    await expect(form(page).getByText('处理中 / 结果待确认')).toBeVisible();
    await expect(saveButton(page)).toBeDisabled();
    await expect(box(page, '调动')).toBeDisabled();
    await expect(box(page, '调动')).not.toBeChecked();
  };
  await locked();
  await page.getByRole('tab', { name: '离职类型', exact: true }).click();
  await page.getByRole('tab', { name: TITLE }).click();
  await locked();
  await page.goBack();
  await expect(page).toHaveURL(/\/types$/);
  await page.goForward();
  await locked();
  expect(server.writes).toHaveLength(2);
  expect(new Set(server.writes.map((write) => write.command)).size).toBe(2);
});
