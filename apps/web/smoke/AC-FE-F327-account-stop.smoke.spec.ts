// F-327（DEC-685④）：离职退休设置的“账号停用时间”页签。接口为合成桩，形态按 exit-account-store.ts
// （AC-FE-F327-account-stop 用真实接口核对夹具）。
import type { Page } from '@playwright/test';
import { actionButton } from './action-button.js';
import { accountStopDefault, accountStopRejected, otherSettingsMenu } from './account-stop-fixtures.js';
import { capture, item, named, save, type Write } from './contracts-fixtures.js';
import { settingsPermission } from './exit-fixtures.js';
import { expect, snapshotFixture, test, user } from './fixtures.js';

const path = '/api/tenant/employment/exit-account/settings';
type Settings = typeof accountStopDefault;
type Reply = { status: number; json: unknown } | 'abort';

/** 有状态的单例桩：GET 回显当前配置；PUT 按 If-Match 核对版本，整份替换，回执为整份配置。 */
async function setup(page: Page, { admin = true } = {}) {
  const server = {
    settings: { ...accountStopDefault } as Settings,
    writes: [] as Write[],
    override: undefined as ((write: Write) => Reply | undefined) | undefined,
  };
  await page.route('**/permission/me/snapshot', (route) => {
    const body = structuredClone(snapshotFixture);
    if (admin) body.adminMenus = [...body.adminMenus, otherSettingsMenu];
    return route.fulfill({ json: body });
  });
  await page.route('**/permission/me/objects/*', (route) => {
    const code = decodeURIComponent(route.request().url().split('/').at(-1)!);
    if (code !== settingsPermission.objectCode) return route.fallback();
    return admin
      ? route.fulfill({ json: settingsPermission })
      : route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN', message: '无权访问该对象' } } });
  });
  await page.route(`**${path}`, (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: server.settings });
    capture(server.writes, request);
    const write = server.writes.at(-1)!;
    const reply = server.override?.(write) ?? apply(server, write);
    return reply === 'abort' ? route.abort('connectionreset') : route.fulfill(reply);
  });
  await page.setViewportSize({ width: 1512, height: 754 });
  await page.goto('/exit-settings');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.waitForURL('**/staff');
  return server;
}
function apply(server: { settings: Settings }, write: Write): Reply {
  if (write.revision !== String(server.settings.revision))
    return { status: 409, json: { error: { code: 'REVISION_CONFLICT', message: '版本冲突' } } };
  server.settings = { ...(write.body as Settings), revision: server.settings.revision + 1 };
  return { status: 200, json: server.settings };
}

const open = async (page: Page) => {
  await page.goto('/exit-settings/account-stop');
  await expect(page.getByRole('tab', { name: '账号停用时间', selected: true })).toBeVisible();
};
const form = (page: Page) => page.getByRole('region', { name: '账号停用时间' });
const toggle = (page: Page, label: string) => form(page).getByRole('switch', { name: label });
const time = (page: Page) => item(form(page), '停用时间').getByRole('textbox');
const saveButton = (page: Page) => form(page).getByRole('button', save);

test('AC-FE-F327-01 回显默认值；开启提前停用后依据与时间必填；保存整份配置，关闭时依据与时间提交 null', async ({
  page,
}) => {
  const server = await setup(page);
  await open(page);
  await expect(toggle(page, '提前停用账号')).not.toBeChecked();
  await expect(toggle(page, '审批中也停用')).not.toBeChecked();
  // 关着提前停用时不显示依据与时间。
  await expect(item(form(page), '停用依据')).toHaveCount(0);
  await expect(item(form(page), '停用时间')).toHaveCount(0);
  await saveButton(page).click();
  await expect(page.getByText('没有需要保存的改动')).toBeVisible();

  await toggle(page, '提前停用账号').click();
  await saveButton(page).click();
  await expect(item(form(page), '停用依据').locator('.ant-form-item-explain-error')).toHaveText('必填');
  await expect(item(form(page), '停用时间').locator('.ant-form-item-explain-error')).toHaveText('必填');
  await time(page).fill('7:00');
  // 旧提示有离场动画，按文字等新提示出现。
  await expect(item(form(page), '停用时间').getByText('请输入 00:00～23:59 的时间，格式 HH:mm')).toBeVisible();
  expect(server.writes).toEqual([]);

  await item(form(page), '停用依据').getByText('最后工作日', { exact: true }).click();
  await time(page).fill('18:30');
  await toggle(page, '审批中也停用').click();
  await saveButton(page).click();
  await expect(page.getByText('账号停用时间已保存')).toBeVisible();
  await expect.poll(() => server.settings.revision).toBe(1);
  // 保存后按新版本回显。
  await expect(time(page)).toHaveValue('18:30');

  await toggle(page, '提前停用账号').click();
  await expect(item(form(page), '停用时间')).toHaveCount(0);
  await saveButton(page).click();
  await expect.poll(() => server.settings.revision).toBe(2);
  await expect(toggle(page, '审批中也停用')).toBeChecked();
  expect(server.writes.map(({ method, path: at, revision, body }) => [method, at, revision, body])).toEqual([
    ['PUT', path, '0', { earlyEnabled: true, basis: 'last_work_date', time: '18:30', inReview: true }],
    ['PUT', path, '1', { earlyEnabled: false, basis: null, time: null, inReview: true }],
  ]);
  expect(new Set(server.writes.map((write) => write.command)).size).toBe(server.writes.length);
});

test('AC-FE-F327-02 版本冲突：重读核对差异后按最新版本重提，未改项取最新', async ({ page }) => {
  const server = await setup(page);
  await open(page);
  // 打开后他人开启了提前停用。
  server.settings = { earlyEnabled: true, basis: 'actual_leave_date', time: '20:00', inReview: false, revision: 1 };
  await toggle(page, '审批中也停用').click();
  await saveButton(page).click();
  await expect(form(page).getByText('版本冲突：输入已保留')).toBeVisible();
  await expect(saveButton(page)).toBeDisabled();
  await actionButton(form(page), '重读最新版本').click();
  await expect(form(page).locator('.ant-table')).toContainText('提前停用账号');
  await form(page).getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
  await expect(toggle(page, '审批中也停用')).toBeChecked();
  await expect(toggle(page, '提前停用账号')).toBeChecked();
  await expect(time(page)).toHaveValue('20:00');
  await saveButton(page).click();
  await expect(page.getByText('账号停用时间已保存')).toBeVisible();
  expect(server.writes.map(({ revision, body }) => [revision, body])).toEqual([
    ['0', { earlyEnabled: false, basis: null, time: null, inReview: true }],
    ['1', { earlyEnabled: true, basis: 'actual_leave_date', time: '20:00', inReview: true }],
  ]);
  expect(server.settings.revision).toBe(2);
});

test('AC-FE-F327-03 明确拒绝保留输入；结果未知只读锁定，换页签再回来仍锁定、不另起命令', async ({ page }) => {
  const server = await setup(page);
  server.override = () => ({ status: 400, json: accountStopRejected });
  await open(page);
  await toggle(page, '提前停用账号').click();
  await item(form(page), '停用依据').getByText('实际离岗日', { exact: true }).click();
  await time(page).fill('09:15');
  await saveButton(page).click();
  await expect(form(page).getByText('账号停用配置不合法')).toBeVisible();
  await expect(time(page)).toHaveValue('09:15');
  await expect(saveButton(page)).toBeEnabled();

  server.override = () => 'abort';
  await saveButton(page).click();
  const locked = async () => {
    await expect(form(page).getByText('处理中 / 结果待确认')).toBeVisible();
    await expect(saveButton(page)).toBeDisabled();
    await expect(time(page)).toBeDisabled();
    await expect(time(page)).toHaveValue('09:15');
  };
  await locked();
  await page.getByRole('tab', { name: '离职类型' }).click();
  await expect(page).toHaveURL(/\/exit-settings\/types$/);
  await page.getByRole('tab', { name: '账号停用时间' }).click();
  await locked();
  // 拒绝后重提是新命令；结果未知只发一次。
  expect(server.writes.map(({ revision }) => revision)).toEqual(['0', '0']);
  expect(new Set(server.writes.map((write) => write.command)).size).toBe(2);
});

test('AC-FE-F327-04 非管理员：读取被拒显示无权限；有对象权限但无其他设置菜单时只读、不显示保存', async ({ page }) => {
  const server = await setup(page, { admin: false });
  await page.route(`**${path}`, (route) =>
    route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN', message: '无权访问' } } }),
  );
  await open(page);
  await expect(page.getByText('暂无访问权限', { exact: true })).toBeVisible();

  // 能读到配置、对象明细有修改权，但快照里没有“管理单元设置”可编辑菜单：fail-closed 只读。
  await page.unroute(`**${path}`);
  server.settings = { earlyEnabled: true, basis: 'last_work_date', time: '19:00', inReview: true, revision: 4 };
  await page.route(`**${path}`, (route) => route.fulfill({ json: server.settings }));
  await page.route('**/permission/me/objects/*', (route) => route.fulfill({ json: settingsPermission }));
  await open(page);
  await expect(time(page)).toHaveValue('19:00');
  await expect(time(page)).toBeDisabled();
  await expect(toggle(page, '提前停用账号')).toBeDisabled();
  await expect(form(page).getByRole('button', named('保存'))).toHaveCount(0);
  expect(server.writes).toEqual([]);
});
