// 规则、字典和租户配置走真实 Hono、授权器和隔离库；权限快照、组织选项沿用合成浏览器夹具。
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { otherSettingsMenu } from './account-stop-fixtures.js';
import { choose, item } from './contracts-fixtures.js';
import { settingsPermission } from './exit-fixtures.js';
import { expect, seedDemoUser, snapshotFixture, test } from './fixtures.js';

const path = '/retirement-settings';
const root = '/api/tenant/employment/retirement-rules';
const setting = '/api/tenant/settings/retirement.auto_flexible_range';
const staleOrg = { id: '60000000-0000-4000-8000-0000000000ff', name: '合成已失效部门' };
type Manifest = { url: string; organization: { id: string; name: string } };
let server: ChildProcess;
let live: Manifest;

test.beforeAll(async () => {
  server = spawn(process.execPath, [fileURLToPath(new URL('./retirement-settings-live-server.mjs', import.meta.url))], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: '--conditions=@italent/source' },
  });
  live = await new Promise<Manifest>((resolve, reject) => {
    let log = '';
    let errors = '';
    server.stdout!.on('data', (part) => {
      log += String(part);
      const ready = log.split('\n').find((line) => line.startsWith('RT_SETTINGS_READY '));
      if (ready) resolve(JSON.parse(ready.slice('RT_SETTINGS_READY '.length)) as Manifest);
    });
    server.stderr!.on('data', (part) => {
      errors += String(part);
    });
    server.once('error', reject);
    server.once('exit', (code) => reject(new Error(`退休设置后端退出 ${code}\n${log}\n${errors}`)));
  });
});
test.afterAll(async () => {
  if (server?.exitCode !== null) return;
  const done = new Promise<void>((resolve) => server.once('exit', () => resolve()));
  server.kill('SIGTERM');
  await done;
});
test.afterEach(async ({ page, context }) => {
  await page.unrouteAll({ behavior: 'wait' });
  await context.unrouteAll({ behavior: 'wait' });
});

async function open(page: Page, tab = '预计退休日期') {
  await seedDemoUser(page);
  await page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        adminMenus: [...snapshotFixture.adminMenus, otherSettingsMenu],
        apps: snapshotFixture.apps.map((app) =>
          app.app === 'transfer' ? { ...app, entryObjects: ['TenantBase.EmploymentRecord'] } : app,
        ),
      },
    }),
  );
  await page.route('**/permission/me/objects/TenantBase.EmploymentSettings', (route) =>
    route.fulfill({ json: settingsPermission }),
  );
  await page.route('**/api/tenant/org/organizations?*', (route) =>
    route.fulfill({
      json: { items: [live.organization, staleOrg], total: 2, page: 1, pageSize: 200, hasDataPermission: true },
    }),
  );
  await page.route(
    (url) =>
      url.pathname.startsWith(root) ||
      url.pathname.startsWith('/api/tenant/employment/retirement-identity-types') ||
      url.pathname.startsWith('/api/tenant/employment/employment-forms') ||
      url.pathname.startsWith('/api/tenant/employment/employment-types/options') ||
      url.pathname === setting,
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const response = await page.request.fetch(`${live.url}${url.pathname}${url.search}`, {
        method: request.method(),
        headers: request.headers(),
        data: request.postDataBuffer() ?? undefined,
      });
      await route.fulfill({ response });
    },
  );
  await page.goto(path);
  await expect(page.getByRole('tab', { name: '预计退休日期' })).toBeVisible({ timeout: 5000 });
  if (tab !== '预计退休日期') await page.getByRole('tab', { name: tab }).click();
}

const namedRule = (page: Page, name: string) =>
  page.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) });
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

async function newRule(page: Page, name: string, organization: string) {
  await button(page, '添加规则').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('规则名称').fill(name);
  await dialog.getByLabel('优先级').fill('1');
  await choose(dialog, '适用组织', organization);
  await choose(dialog, '雇佣关系', '内部员工');
  return dialog;
}

async function rowAction(page: Page, rowName: string, label: string) {
  await namedRule(page, rowName).getByRole('button', { name: label, exact: true }).click();
  await page.getByRole('button', { name: /^确\s*定$/ }).click();
}

test('B66 新建、编辑、复制、启停和删除自建固定年龄规则', async ({ page, request }) => {
  await open(page);
  const dialog = await newRule(page, '合成固定年龄规则', live.organization.name);
  await choose(dialog, '性别', '女');
  await dialog.getByLabel('退休年龄（岁）').fill('55');
  await expect(dialog.getByText('高级公式')).toHaveCount(0);
  await dialog.getByRole('button', { name: /^保\s*存$/ }).click();
  await expect(namedRule(page, '合成固定年龄规则')).toContainText('55');
  await namedRule(page, '合成固定年龄规则').getByRole('button', { name: '编辑', exact: true }).click();
  await dialog.getByLabel('退休年龄（岁）').fill('56');
  await dialog.getByRole('button', { name: /^保\s*存$/ }).click();
  await expect(namedRule(page, '合成固定年龄规则')).toContainText('56');
  const response = await request.get(`${live.url}${root}?purpose=expected_date`);
  expect(response.ok()).toBe(true);
  expect((await response.json()).items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: '合成固定年龄规则',
        retirementAgeYears: 56,
        orgIds: [live.organization.id],
        revision: 2,
        conditions: [
          { fieldCode: 'gender', operator: 'in', values: ['female'] },
          { fieldCode: 'employType', operator: 'in', values: ['internal'] },
        ],
      }),
    ]),
  );
  const copiedName = '合成固定年龄规则（复制）';
  await rowAction(page, '合成固定年龄规则', '复制');
  await expect(namedRule(page, copiedName).getByRole('cell', { name: '停用', exact: true })).toBeVisible();
  await rowAction(page, copiedName, '启用');
  await expect(namedRule(page, copiedName).getByRole('cell', { name: '启用', exact: true })).toBeVisible();
  await rowAction(page, copiedName, '停用');
  await expect(namedRule(page, copiedName).getByRole('cell', { name: '停用', exact: true })).toBeVisible();
  await rowAction(page, copiedName, '删除');
  await expect(namedRule(page, copiedName)).toHaveCount(0);
  await expect(namedRule(page, '合成固定年龄规则')).toBeVisible();
});

test('B66 预置法定规则不可编辑和删除，可启停与复制', async ({ page }) => {
  await open(page);
  const name = '法定退休年龄（预计退休日期）';
  const row = namedRule(page, name);
  await expect(row).toBeVisible();
  await expect(row.getByRole('button', { name: /编辑|删除/ })).toHaveCount(0);
  await rowAction(page, name, '启用');
  await expect(row.getByRole('cell', { name: '启用', exact: true })).toBeVisible();
  await rowAction(page, name, '停用');
  await expect(row.getByRole('cell', { name: '停用', exact: true })).toBeVisible();
  await rowAction(page, name, '复制');
  await expect(namedRule(page, `${name}（复制）`).getByRole('button', { name: '编辑', exact: true })).toBeVisible();
});

test('B67 按内置法定上下限保存规则并保存自动计算开关', async ({ page, request }) => {
  await open(page, '弹性退休范围');
  const dialog = await newRule(page, '合成弹性范围', live.organization.name);
  await expect(dialog.getByText('计算最早提前退休日期(个人身份)', { exact: true })).toBeVisible();
  await expect(dialog.getByText('计算最晚延迟退休日期()', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: /^保\s*存$/ }).click();
  await expect(namedRule(page, '合成弹性范围')).toBeVisible();
  const section = page.getByRole('region', { name: '自动计算弹性退休范围' });
  const toggle = section.getByRole('switch', { name: '自动计算弹性退休范围' });
  await toggle.click();
  await section.getByRole('button', { name: /^保\s*存$/ }).click();
  await expect
    .poll(async () => {
      const response = await request.get(`${live.url}${setting}`);
      return (await response.json()).value;
    })
    .toBe(true);
  await page.reload();
  await expect(toggle).toBeChecked();
  const response = await request.get(`${live.url}${root}?purpose=flexible_range`);
  expect((await response.json()).items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: '合成弹性范围',
        earliestFunction: 'statutory_earliest',
        latestFunction: 'statutory_latest',
        orgIds: [live.organization.id],
      }),
    ]),
  );
});

const clearConditionCases = [
  { tab: '预计退休日期', purpose: 'expected_date', rule: { retirementAgeYears: 55 }, optional: ['性别'] },
  {
    tab: '弹性退休范围',
    purpose: 'flexible_range',
    rule: { earliestFunction: 'statutory_earliest', latestFunction: 'statutory_latest' },
    optional: ['性别', '国籍'],
  },
] as const;

for (const { tab, purpose, rule, optional } of clearConditionCases) {
  test(`${tab}：清空可选人员条件后可保存，雇佣关系仍必填`, async ({ page, request }) => {
    const name = `合成清空条件规则-${tab}`;
    const employment = { fieldCode: 'employType', operator: 'in', values: ['internal'] };
    const conditions = [
      { fieldCode: 'gender', operator: 'in', values: ['female'] },
      ...(purpose === 'flexible_range' ? [{ fieldCode: 'nationality', operator: 'in', values: ['CN'] }] : []),
      employment,
    ];
    const created = await request.post(`${live.url}${root}`, {
      headers: { 'if-match': '0', 'idempotency-key': crypto.randomUUID() },
      data: { ...rule, name, purpose, priority: 1, orgIds: [live.organization.id], conditions },
    });
    expect(created.status()).toBe(201);
    const { id, revision } = (await created.json()) as { id: string; revision: number };
    const read = async () => {
      const response = await request.get(`${live.url}${root}?purpose=${purpose}`);
      expect(response.ok()).toBe(true);
      const { items } = (await response.json()) as { items: { id: string }[] };
      return items.find((row) => row.id === id);
    };
    await open(page, tab);
    const updates: string[] = [];
    page.on('request', (sent) => {
      if (sent.method() === 'PUT' && new URL(sent.url()).pathname === `${root}/${id}`) updates.push(sent.url());
    });
    await namedRule(page, name).getByRole('button', { name: '编辑', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const save = dialog.getByRole('button', { name: /^保\s*存$/ });
    const removeValue = (label: string) => item(dialog, label).locator('.ant-select-selection-item-remove').click();
    await removeValue('雇佣关系');
    await save.click();
    await expect(item(dialog, '雇佣关系').getByText('请填写此项', { exact: true })).toBeVisible();
    expect(updates).toHaveLength(0);
    expect(await read()).toMatchObject({ revision, conditions });

    await choose(dialog, '雇佣关系', '内部员工');
    for (const label of optional) await removeValue(label);
    await save.click();
    await expect
      .poll(read, { message: '实际后端应保存规则并移除已清空的可选条件' })
      .toMatchObject({ revision: revision + 1, conditions: [employment] });
    await expect(dialog).toHaveCount(0);
    expect(updates).toHaveLength(1);
  });
}

test('服务端拒绝无效适用组织，保留规则名称和退休年龄并展示原因', async ({ page }) => {
  await open(page);
  const dialog = await newRule(page, '合成保留输入', staleOrg.name);
  await dialog.getByLabel('退休年龄（岁）').fill('60');
  await dialog.getByRole('button', { name: /^保\s*存$/ }).click();
  await expect(dialog.getByText('适用组织包含不存在的组织')).toBeVisible();
  await expect(dialog.getByLabel('规则名称')).toHaveValue('合成保留输入');
  await expect(dialog.getByLabel('退休年龄（岁）')).toHaveValue('60');
  await expect(dialog.getByRole('button', { name: /^保\s*存$/ })).toBeEnabled();
  await expect(namedRule(page, '合成保留输入')).toHaveCount(0);
});

test('版本冲突重读最新规则，保留自己改过的值并按新版本重提', async ({ page, request }) => {
  const name = '合成并发规则';
  const body = {
    name,
    purpose: 'expected_date',
    ruleType: 'fixed_age',
    priority: 1,
    orgIds: [live.organization.id],
    retirementAgeYears: 55,
    conditions: [{ fieldCode: 'employType', operator: 'in', values: ['internal'] }],
  };
  const initial = await request.post(`${live.url}${root}`, {
    headers: { 'if-match': '0', 'idempotency-key': crypto.randomUUID() },
    data: body,
  });
  expect(initial.status()).toBe(201);
  const rule = (await initial.json()) as { id: string; revision: number };
  await open(page);
  await namedRule(page, name).getByRole('button', { name: '编辑', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('退休年龄（岁）').fill('56');
  const concurrent = await request.put(`${live.url}${root}/${rule.id}`, {
    headers: { 'if-match': String(rule.revision), 'idempotency-key': crypto.randomUUID() },
    data: { ...body, priority: 4 },
  });
  expect(concurrent.status()).toBe(200);
  await dialog.getByRole('button', { name: /^保\s*存$/ }).click();
  await expect(dialog.getByText(/版本冲突：输入已保留/)).toBeVisible();
  await dialog.getByRole('button', { name: '重读最新版本' }).click();
  await dialog.getByRole('button', { name: '已核对差异，继续编辑' }).click();
  await expect(dialog.getByLabel('优先级')).toHaveValue('4');
  await expect(dialog.getByLabel('退休年龄（岁）')).toHaveValue('56');
  await dialog.getByRole('button', { name: /^保\s*存$/ }).click();
  await expect(dialog).toHaveCount(0);
  const result = await request.get(`${live.url}${root}?purpose=expected_date`);
  expect((await result.json()).items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: rule.id, revision: 3, priority: 4, retirementAgeYears: 56 }),
    ]),
  );
});

test('写入已提交但回执丢失，跨页签重开新建仍锁定，原规则只出现一次', async ({ page, request }) => {
  await open(page);
  let writes = 0;
  await page.route(
    (url) => url.pathname === root && !url.search,
    async (route) => {
      const sent = route.request();
      if (sent.method() !== 'POST') return route.fallback();
      writes += 1;
      const response = await request.post(`${live.url}${root}`, {
        headers: sent.headers(),
        data: sent.postDataBuffer()!,
      });
      expect(response.status()).toBe(201);
      await route.abort('connectionreset');
    },
  );
  const name = '合成回执丢失';
  const dialog = await newRule(page, name, live.organization.name);
  await dialog.getByLabel('退休年龄（岁）').fill('60');
  await dialog.getByRole('button', { name: /^保\s*存$/ }).click();
  await expect(dialog.getByText(/结果待确认/)).toBeVisible();
  await dialog.getByRole('button', { name: /^取\s*消$/ }).click();
  await page.getByRole('tab', { name: '弹性退休范围' }).click();
  await page.getByRole('tab', { name: '预计退休日期' }).click();
  await button(page, '添加规则').click();
  await expect(dialog.getByText(/结果待确认/)).toBeVisible();
  await expect(dialog.getByLabel('规则名称')).toHaveValue(name);
  await expect(dialog.getByRole('button', { name: /^保\s*存$/ })).toBeDisabled();
  const result = await request.get(`${live.url}${root}?purpose=expected_date`);
  expect((await result.json()).items.filter((item: { name: string }) => item.name === name)).toHaveLength(1);
  expect(writes).toBe(1);
});
