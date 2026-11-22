import type { Page } from '@playwright/test';
import { entryId, initialEntry, nextId, objectGrant, setupEntries } from './entry-fixtures.js';
import { expect, test } from './fixtures.js';

const RECORDS = 'TenantBase.ESignRecord';
const EMPLOYMENT = 'TenantBase.EmploymentRecord';
const signName = '发起电子文件签署';
const historyName = '电子签署';
const template = { id: '71000000-0000-4000-8000-000000000007', name: 'ZZ_F505_合成签署文件' };
const taskId = '71000000-0000-4000-8000-000000000008';
const dialogOf = (page: Page) => page.getByRole('dialog', { name: '发起电子签署' });
const confirmOf = (page: Page) => dialogOf(page).getByRole('button', { name: /^确\s*定$/ });
const pickerOf = (page: Page) => dialogOf(page).locator('select[name="esignTemplateIds"]');
const context = (id = entryId, revision = 9, items = [template]) => ({
  sourceId: id,
  revision,
  canInitiate: true,
  items,
});
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
  expect(reads).toBeGreaterThan(0);
  expect(state.writes).toEqual([]);
});

test('AC-ESIGN-F505-FE-02 没有详情编辑按钮时隐藏签署发起入口', async ({ page, baseURL }) => {
  await setupEntries(page, baseURL!);
  await page.route(`**/permission/me/objects/${EMPLOYMENT}`, (route) => {
    const grant = objectGrant(EMPLOYMENT);
    return route.fulfill({
      json: { ...grant, buttons: grant.buttons.filter((b) => b.buttonCode !== 'Employment.Edit') },
    });
  });
  await page.reload();
  await expect(row(page).getByRole('button', { name: /^编\s*辑$/ })).toBeDisabled();
  const sign = await menu(page);
  await expect(page.getByRole('menuitem', { name: '删除人员' })).toBeVisible();
  await expect(sign, '无详情编辑按钮时菜单中没有签署发起').toHaveCount(0, { timeout: 3000 });
  await expect(row(page).getByRole('button', { name: historyName })).toHaveCount(0);
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
  await drawer.getByRole('button', { name: '关闭' }).click();
  state.row.employeeStatus = 3;
  await selectTab(page, '已入职');
  await expect(drawer).toBeHidden();
  await history.click();
  await expect(drawer.getByText('暂无可见签署记录')).toBeVisible();
  await expect(row(page).getByRole('button', { name: '更多操作' })).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

test('AC-ESIGN-F505-FE-03 入职模板空、断网、拒权、必选和超限分开处理，失败任务有原因', async ({ page, baseURL }) => {
  await setupEntries(page, baseURL!);
  let mode: 'empty' | 'network' | 'denied' | 'options' = 'empty';
  const items = [
    template,
    ...Array.from({ length: 20 }, (_, index) => ({
      id: `71000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
      name: `ZZ_F505_模板${index + 1}`,
    })),
  ];
  await page.route('**/pending-entries/*/esign-context', (route) => {
    if (mode === 'network') return route.abort();
    if (mode === 'denied')
      return route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN', message: '无权' } } });
    return route.fulfill({ json: context(entryId, 9, mode === 'empty' ? [] : items) });
  });
  await page.route('**/pending-entries/*/esign-tasks', (route) => {
    expect(route.request().postDataJSON()).toEqual({ templateIds: [template.id] });
    return route.fulfill({ status: 201, json: { sourceId: entryId, taskId } });
  });
  await page.route(`**/esign/mine/${taskId}`, (route) =>
    route.fulfill({ json: { id: taskId, revision: 1, status: 'failed', failureReason: 'EMPLOYEE_NO_ACCOUNT' } }),
  );
  const dialog = dialogOf(page);
  const open = async () => (await menu(page)).click();
  const close = async () => dialog.getByRole('button', { name: /^取\s*消$/ }).click();
  await open();
  await expect(dialog.getByText(/暂无适用于本场景的启用模板/)).toBeVisible();
  await expect(confirmOf(page)).toBeDisabled();
  await close();

  mode = 'denied';
  await open();
  await expect(dialog.getByText('您无权读取此发起上下文。')).toBeVisible();
  await expect(pickerOf(page)).toHaveCount(0);
  await close();

  mode = 'network';
  await open();
  await expect(dialog.getByText(/模板.*失败/)).toBeVisible();
  await expect(dialog.getByText(/暂无适用于本场景的启用模板/)).toHaveCount(0);
  mode = 'options';
  await dialog.getByRole('button', { name: /^重\s*试$/ }).click();
  await expect(pickerOf(page).locator('option')).toHaveCount(21);
  await expect(confirmOf(page)).toBeDisabled();
  await dialog.getByRole('checkbox', { name: '全选' }).check();
  await expect(dialog.getByText(/20.*(份|个)/)).toBeVisible();
  await expect(confirmOf(page)).toBeDisabled();
  await pickerOf(page).selectOption(template.id);
  await confirmOf(page).click();
  await expect(dialog.getByRole('alert')).toContainText(/发起失败.*账号/);
  await expect(dialog.getByText('已提交，正在读取任务状态…')).toHaveCount(0);
});

test('AC-ESIGN-F505-FE-04 丢响应按原键回查，回执后的读取失败和重开都不会发第二次', async ({ page, baseURL }) => {
  const state = await setupEntries(page, baseURL!);
  state.hidden = ['revision', 'entryStatus', 'employeeStatus'];
  const posts: { key: string | undefined; revision: string | undefined }[] = [];
  const checked: string[] = [];
  let mineReadable = false;
  await page.route('**/pending-entries/*/esign-context', (route) => route.fulfill({ json: context() }));
  await page.route('**/pending-entries/*/esign-tasks', (route) => {
    const headers = route.request().headers();
    posts.push({ key: headers['idempotency-key'], revision: headers['if-match'] });
    return route.abort();
  });
  await page.route('**/commands/*/result', (route) => {
    checked.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: { sourceId: entryId, taskId } });
  });
  await page.route(`**/esign/mine/${taskId}`, (route) =>
    mineReadable
      ? route.fulfill({ json: { id: taskId, revision: 1, status: 'signing', currentNode: 'employee' } })
      : route.abort(),
  );
  await (await menu(page)).click();
  await pickerOf(page).selectOption(template.id);
  await confirmOf(page).click();
  const dialog = dialogOf(page);
  await expect(dialog.getByText(/结果待确认/)).toBeVisible();
  expect(posts).toEqual([{ key: expect.any(String), revision: '9' }]);
  await dialog.getByRole('button', { name: '查询提交结果' }).click();
  await expect(dialog.getByText('已提交，状态读取失败')).toBeVisible();
  expect(checked).toEqual([`/api/tenant/commands/${posts[0]!.key}/result`]);
  await dialog
    .getByRole('button', { name: /^关\s*闭$/ })
    .last()
    .click();
  await (await menu(page)).click();
  await expect(dialog.getByText('已提交，状态读取失败')).toBeVisible();
  await expect(confirmOf(page)).toHaveCount(0);
  mineReadable = true;
  await dialog.getByRole('button', { name: '重读任务状态' }).click();
  await expect(dialog.getByText('签署中（待本人签署）')).toBeVisible();
  expect(posts).toHaveLength(1);
});

test('AC-ESIGN-F505-FE-04 409 只重读原来源，改期替换后新记录不继承旧模板选择', async ({ page, baseURL }) => {
  const state = await setupEntries(page, baseURL!);
  const posts: string[] = [];
  let replaced = false;
  await page.route('**/pending-entries/*/esign-context', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
    if (replaced && id === entryId)
      return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: '来源已更换' } } });
    return route.fulfill({ json: context(id) });
  });
  await page.route('**/pending-entries/*/esign-tasks', (route) => {
    posts.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT', message: '来源已变化' } } });
  });
  await (await menu(page)).click();
  await pickerOf(page).selectOption(template.id);
  await confirmOf(page).click();
  const dialog = dialogOf(page);
  const refresh = dialog.getByRole('button', { name: '刷新签署上下文' });
  await expect(refresh).toBeVisible();
  await expect(confirmOf(page)).toBeDisabled();

  replaced = true;
  state.row.id = nextId;
  await refresh.click();
  await expect(dialog.getByText('签署来源不存在或已不可访问。')).toBeVisible();
  await dialog
    .getByRole('button', { name: /^关\s*闭$/ })
    .last()
    .click();
  await selectTab(page, '今日待入职');
  await expect(row(page)).toHaveAttribute('data-row-key', nextId);
  await (await menu(page)).click();
  await expect(pickerOf(page)).toHaveValues([]);
  await expect(confirmOf(page)).toBeDisabled();
  expect(posts).toEqual([`/api/tenant/employment/pending-entries/${entryId}/esign-tasks`]);
});

test('AC-ESIGN-F505-FE-04 切视图后迟到的旧来源模板不会写进新弹窗', async ({ page, baseURL }) => {
  const state = await setupEntries(page, baseURL!);
  let releaseOld!: () => void;
  const old = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  let markDelivered!: () => void;
  const delivered = new Promise<void>((resolve) => {
    markDelivered = resolve;
  });
  const oldTemplate = { ...template, name: 'ZZ_F505_旧来源模板' };
  await page.route('**/pending-entries/*/esign-context', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
    if (id === entryId) {
      await old;
      await route.fulfill({ json: context(entryId, 9, [oldTemplate]) });
      markDelivered();
    } else {
      await route.fulfill({ json: context(nextId, 1) });
    }
  });
  const started = page.waitForRequest((req) => req.url().endsWith(`/${entryId}/esign-context`));
  try {
    await (await menu(page)).click();
    await started;
    await dialogOf(page)
      .getByRole('button', { name: /^取\s*消$/ })
      .click();
    state.row.id = nextId;
    await selectTab(page, '今日待入职');
    await (await menu(page)).click();
    await expect(pickerOf(page).locator('option')).toHaveText(template.name);
    releaseOld();
    await delivered;
    await expect(pickerOf(page).locator('option')).toHaveText(template.name);
    await expect(confirmOf(page)).toBeDisabled();
    expect(state.writes).toEqual([]);
  } finally {
    releaseOld();
  }
});

test('AC-ESIGN-F505-FE-05 历史保留入职场景，状态与文件字段不可见时不显示状态和下载', async ({ page, baseURL }) => {
  await setupEntries(page, baseURL!);
  await page.route(`**/permission/me/objects/${RECORDS}`, (route) =>
    route.fulfill({
      json: {
        ...objectGrant(RECORDS),
        viewableFields: ['scene'],
        buttons: [{ buttonCode: 'ESignRecord.Download', level: 'list' }],
      },
    }),
  );
  await page.route('**/pending-entries/*/esign-records?*', (route) =>
    route.fulfill({
      json: {
        items: [
          { id: taskId, revision: 3, scene: 'entry', status: 'completed', files: [{ seq: 1, name: template.name }] },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      },
    }),
  );
  await row(page).getByRole('button', { name: historyName }).click();
  const section = page.getByRole('region', { name: historyName });
  await expect(section.getByText('入职电子签署')).toBeVisible();
  await expect(section.getByText('签署完成')).toHaveCount(0);
  await expect(section.getByText(template.name)).toHaveCount(0);
  await expect(section.getByRole('button', { name: '下载文件' })).toHaveCount(0);
});
