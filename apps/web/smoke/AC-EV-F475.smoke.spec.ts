import type { Page } from '@playwright/test';
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
  await form.getByRole('button', { name: /保\s*存/, exact: true }).click();
  await expect(form).toContainText('版本冲突');
  await form.getByRole('button', { name: '重读最新版本', exact: true }).click();
  await form.getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
  await form.getByRole('button', { name: '上一步' }).click();
  await form.getByRole('button', { name: '上一步' }).click();
  await form.getByLabel('名称', { exact: true }).fill(ev.name);
  await form.getByRole('button', { name: '下一步' }).click();
  await form.getByRole('button', { name: '下一步' }).click();
  await form.getByRole('button', { name: /保\s*存/, exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(attempts).toBe(2);
});
