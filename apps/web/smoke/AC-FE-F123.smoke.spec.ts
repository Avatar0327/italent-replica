import { test, expect } from './fixtures.js';
import { activity, ev, id, setupR3b } from './r3b-fixtures.js';

const save = { name: /保\s*存/, exact: true };
for (const kind of ['survey360', 'evaluation'] as const) {
  test(`AC-FE-F123 ${kind} 编辑冲突保留输入、显式重读核对后重提`, async ({ page }) => {
    const original = kind === 'survey360' ? activity : ev;
    await setupR3b(page, `/${kind}`);
    const requests: { revision: string; body: unknown }[] = [];
    await page.route(`**/${kind}/activities/${id}`, (route) => {
      const request = route.request();
      if (request.method() === 'GET')
        return route.fulfill({
          json: requests.length ? { ...original, name: '他人名称', revision: original.revision + 1 } : original,
        });
      requests.push({ revision: request.headers()['if-match']!, body: request.postDataJSON() });
      return requests.length === 1
        ? route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT' } } })
        : route.fulfill({ json: { ...original, revision: original.revision + 2 } });
    });
    await page.getByRole('button', { name: original.name, exact: true }).click();
    await page.getByRole('button', { name: /编\s*辑/, exact: true }).click();
    const form = page.getByRole('dialog', { name: '编辑', exact: true });
    await form.getByRole('textbox', { name: '名称', exact: true }).fill('我的未保存名称');
    if (kind === 'evaluation') {
      await form.getByRole('button', { name: '下一步', exact: true }).click();
      await form.getByRole('button', { name: '下一步', exact: true }).click();
    }
    await form.getByRole('button', save).click();
    await expect(form.getByRole('button', { name: '重读最新版本', exact: true })).toBeVisible();
    await form.getByRole('button', { name: '重读最新版本', exact: true }).click();
    await expect(form).toContainText('他人名称');
    await expect(form).toContainText('我的未保存名称');
    expect(requests).toHaveLength(1);
    await expect(form.getByRole('button', save)).toBeDisabled();
    await form.getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
    await form.getByRole('button', save).click();
    await expect(form).toHaveCount(0);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ revision: String(original.revision + 1), body: { name: '我的未保存名称' } });
  });
}

test('AC-FE-F123 既有活动结果未知，关闭详情重开仍只读且不生成第二个命令', async ({ page }) => {
  await setupR3b(page, '/survey360');
  let writes = 0;
  await page.route(`**/survey360/activities/${id}`, (route) => {
    if (route.request().method() === 'GET') return route.fallback();
    writes++;
    return route.abort('failed');
  });
  const open = async () => {
    await page.getByRole('button', { name: activity.name, exact: true }).click();
    await page.getByRole('button', { name: /编\s*辑/, exact: true }).click();
  };
  await open();
  const form = page.getByRole('dialog', { name: '编辑', exact: true });
  await form.getByRole('textbox', { name: '名称', exact: true }).fill('未确认改名');
  await form.getByRole('button', save).click();
  await expect(form).toContainText('结果待确认');
  await form.getByRole('button', { name: /取\s*消/, exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await open();
  await expect(form.getByRole('textbox', { name: '名称', exact: true })).toHaveValue('未确认改名');
  await expect(form.getByRole('textbox', { name: '名称', exact: true })).toBeDisabled();
  await expect(form.getByRole('button', save)).toBeDisabled();
  expect(writes).toBe(1);
});
