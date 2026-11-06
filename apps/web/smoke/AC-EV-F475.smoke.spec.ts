import type { Page } from '@playwright/test';
import { EVALUATION_OBJECTS } from '../../../packages/domain/src/evaluation/catalog.js';
import { test, expect } from './fixtures.js';
import { ev, id, setupR3b } from './r3b-fixtures.js';

const formRow = {
  id,
  revision: 1,
  name: '合成评价表',
  ownerOrgId: id,
  enabled: true,
  createdBy: id,
  scoreMode: 'by_indicator',
  fullScore: 100,
  passScore: 60,
  totalRule: 'average',
  votePassRatio: null,
  indicatorReference: false,
  weightWarning: null,
  items: [{ kind: 'general', generalItemId: id, name: '合成通用项', weight: 100 }],
};
const edit = { name: /编\s*辑/, exact: true };
const cancel = { name: /取\s*消/, exact: true };
const confirm = { name: /确\s*定/, exact: true };
const menu = (page: Page, name: string) =>
  page.locator('.evaluation-layout > .ant-menu').getByRole('menuitem', { name, exact: true });
async function forms(page: Page) {
  await setupR3b(page, '/evaluation');
  await page.route('**/evaluation/evaluation-forms?*', (route) =>
    route.fulfill({ json: { items: [formRow], total: 1 } }),
  );
  await page.route(`**/evaluation/evaluation-forms/${id}`, (route) => route.fulfill({ json: formRow }));
  await menu(page, '评价表').click();
  await page.getByRole('button', edit).click();
  return page.locator('.evaluation-full-page');
}

test('AC-EV-F475 评价表冲突重读保留草稿，改回原值按最新版本提交', async ({ page }) => {
  const form = await forms(page);
  const writes: { revision: string; body: unknown }[] = [];
  let latest = formRow;
  await page.route(`**/evaluation/evaluation-forms/${id}`, async (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: latest });
    writes.push({ revision: request.headers()['if-match']!, body: request.postDataJSON() });
    if (writes.length === 1) {
      latest = { ...formRow, name: '合成服务器新值', revision: 2 };
      return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT' } } });
    }
    return route.fulfill({ json: { ...latest, ...request.postDataJSON(), revision: 3 } });
  });
  await form.getByLabel('评价表名称', { exact: true }).fill('合成草稿');
  await form.getByRole('button', confirm).click();
  await expect(form).toContainText('版本冲突');
  await form.getByRole('button', { name: '重读最新版本', exact: true }).click();
  await form.getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
  await expect(form.getByLabel('评价表名称', { exact: true })).toHaveValue('合成草稿');
  await form.getByLabel('评价表名称', { exact: true }).fill(formRow.name);
  await form.getByRole('button', confirm).click();
  await expect(form).toHaveCount(0);
  expect(writes).toEqual([
    { revision: '1', body: { name: '合成草稿' } },
    { revision: '2', body: { name: formRow.name } },
  ]);
});

test('AC-EV-F475 回执丢失后跨菜单、后退前进及重开仍锁定同一评价表', async ({ page }) => {
  const form = await forms(page);
  const commands: string[] = [];
  await page.route(`**/evaluation/evaluation-forms/${id}`, (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: formRow });
    commands.push(route.request().headers()['idempotency-key']!);
    return route.abort();
  });
  await form.getByLabel('评价表名称', { exact: true }).fill('合成待确认');
  await form.getByRole('button', confirm).click();
  await expect(form).toContainText('结果待确认');
  await form.getByRole('button', cancel).click();
  await menu(page, '评定记录').click();
  await page.goBack();
  await page.goForward();
  await menu(page, '评价表').click();
  await page.getByRole('button', edit).click();
  await expect(form).toContainText('结果待确认');
  await expect(form.getByLabel('评价表名称', { exact: true })).toBeDisabled();
  await expect(form.getByRole('button', confirm)).toBeDisabled();
  expect(commands).toHaveLength(1);
});

test('AC-EV-F475 评定独立列表与评审组详情只读取真实接口结构', async ({ page }) => {
  await setupR3b(page, '/evaluation');
  await menu(page, '评定记录').click();
  await expect(page.getByRole('columnheader', { name: '入职日期', exact: true })).toBeVisible();
  const group = {
    id,
    revision: 1,
    name: '合成评审组',
    ownerOrgId: id,
    enabled: true,
    members: [{ employeeId: id, isLeader: true, name: '合成组长', code: 'SYNTHETIC' }],
  };
  await page.route('**/evaluation/review-groups?*', (route) => route.fulfill({ json: { items: [group], total: 1 } }));
  await page.route(`**/evaluation/review-groups/${id}`, (route) => route.fulfill({ json: group }));
  await menu(page, '评审组').click();
  await page.getByRole('button', { name: group.name }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByRole('columnheader').filter({ hasText: '任职类别' })).toBeVisible();
  await expect(drawer).toContainText('合成组长');
  await expect(drawer.locator('.ant-tag')).toHaveText('组长');
});

test('AC-EV-F475 活动冲突后改回原值仍用重读版本，成功后返回详情', async ({ page }) => {
  await setupR3b(page, '/evaluation');
  let attempts = 0;
  await page.route(`**/evaluation/activities/${id}`, (route) => {
    const request = route.request();
    if (request.method() === 'GET')
      return route.fulfill({ json: attempts ? { ...ev, revision: 3, name: '合成并发值' } : ev });
    attempts++;
    if (attempts === 1) return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT' } } });
    expect(request.headers()['if-match']).toBe('3');
    expect(request.postDataJSON()).toMatchObject({ name: ev.name });
    return route.fulfill({ json: { ...ev, ...request.postDataJSON(), revision: 4 } });
  });
  await page.getByRole('button', edit).click();
  const form = page.locator('.evaluation-full-page');
  await form.getByLabel('名称', { exact: true }).fill('合成草稿');
  await form.getByRole('button', { name: '下一步' }).click();
  await form.getByRole('button', { name: '下一步' }).click();
  await form.getByRole('button', { name: /^保\s*存$/, exact: true }).click();
  await expect(form).toContainText('版本冲突');
  await form.getByRole('button', { name: '重读最新版本', exact: true }).click();
  await form.getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
  await form.getByRole('button', { name: '上一步' }).click();
  await form.getByRole('button', { name: '上一步' }).click();
  await form.getByLabel('名称', { exact: true }).fill(ev.name);
  await form.getByRole('button', { name: '下一步' }).click();
  await form.getByRole('button', { name: '下一步' }).click();
  await form.getByRole('button', { name: /^保\s*存$/, exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(attempts).toBe(2);
});

test('AC-EV-F475 评价表保存期间离开后迟到回执不改变当前页面，返回读取最新列表', async ({ page }) => {
  const form = await forms(page);
  let complete!: () => void;
  const delayed = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const latest = { ...formRow, name: '合成延迟更新', revision: 2 };
  await page.route(`**/evaluation/evaluation-forms/${id}`, async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: latest });
    await delayed;
    return route.fulfill({ json: latest });
  });
  await form.getByLabel('评价表名称', { exact: true }).fill(latest.name);
  const request = page.waitForRequest((request) => request.method() === 'PATCH');
  await form.getByRole('button', confirm).click();
  await request;
  await menu(page, '评定记录').click();
  const response = page.waitForResponse((response) => response.request().method() === 'PATCH');
  complete();
  await response;
  await expect(page).toHaveURL(/view=records/);
  await page.route('**/evaluation/evaluation-forms?*', (route) =>
    route.fulfill({ json: { items: [latest], total: 1 } }),
  );
  await menu(page, '评价表').click();
  await expect(page.getByRole('cell', { name: latest.name, exact: true })).toBeVisible();
});

test('AC-EV-F475 名称入口在编辑关闭后仍进入详情，不继承编辑状态', async ({ page }) => {
  await setupR3b(page, '/evaluation');
  await page.getByRole('button', edit).click();
  const editor = page.locator('.evaluation-full-page');
  await editor.getByRole('button', cancel).click();
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: ev.name, exact: true }).click();
  await expect(page.getByRole('dialog', { name: ev.name, exact: true })).toBeVisible();
  await expect(editor).toHaveCount(0);
});

for (const kind of ['activities', 'groups'] as const) {
  test(`AC-EV-F475 P2-1 ${kind} 名称裁剪且只读仍可打开安全详情`, async ({ page }) => {
    await setupR3b(page, '/evaluation', true);
    await expect(page.getByRole('button', { name: ev.name, exact: true })).toBeVisible();
    await page.route('**/permission/me/objects/TEvaluation.*', (route) => {
      const object = Object.values(EVALUATION_OBJECTS).find((item) => route.request().url().endsWith(item.code));
      if (!object) return route.fallback();
      return route.fulfill({
        json: {
          objectCode: object.code,
          dataOperations: { read: true },
          viewableFields: object.fields.filter((field) => field.code !== 'name').map((field) => field.code),
          editableFields: [],
          buttons: [],
        },
      });
    });
    const resource = kind === 'activities' ? 'activities' : 'review-groups';
    const source = kind === 'activities' ? ev : { id, revision: 1, name: '合成受限评审组', enabled: true, members: [] };
    const { name, ...cropped } = source;
    await page.route(`**/evaluation/${resource}?*`, (route) => route.fulfill({ json: { items: [cropped], total: 1 } }));
    await page.route(`**/evaluation/${resource}/${id}`, (route) => route.fulfill({ json: cropped }));
    await page.goto(`/evaluation?view=${kind}`);
    const row = page.locator(`tr[data-row-key="${id}"]`);
    await expect(row).toBeVisible();
    await expect(page.getByRole('columnheader', { name: '名称', exact: true })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(name);
    const view = row.getByRole('button', { name: /^查\s*看$/, exact: true });
    await expect(view).toBeVisible();
    await view.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.ant-drawer-title')).toHaveText('—');
    await expect(dialog.getByRole('button', edit).and(dialog.locator('button:enabled'))).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(name);
  });
}

test('AC-EV-F475 P2-3 过程活动选择清空后停止读取，重新选择恢复读取', async ({ page }) => {
  await setupR3b(page, '/evaluation');
  const reads: (string | null)[] = [];
  await page.route('**/evaluation/staff-evaluations?*', (route) => {
    const activity = new URL(route.request().url()).searchParams.get('activityId');
    reads.push(activity);
    return activity === id
      ? route.fulfill({ json: { items: [{ id, revision: 1, employeeId: id, activityId: id }], total: 1 } })
      : route.fulfill({ status: 400, json: { error: { code: 'INVALID_INPUT' } } });
  });
  await menu(page, '评定过程').click();
  const selector = page.getByRole('combobox', { name: '活动设置', exact: true });
  const row = page.locator(`tr[data-row-key="${id}"]`);
  const control = page.locator('.ant-select').filter({ has: selector });
  const selectActivity = async () => {
    await control.locator('.ant-select-selector').click();
    await page.getByTitle(ev.name, { exact: true }).click();
    await expect(row).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`activity=${id}`));
  };
  await selectActivity();
  expect(reads).toEqual([id]);
  await control.hover();
  await control.locator('.ant-select-clear').click();
  await expect(page).not.toHaveURL(/[?&]activity=/);
  await expect(row).toHaveCount(0);
  expect(reads).toEqual([id]);
  await selectActivity();
  expect(reads).toEqual([id, id]);
});
