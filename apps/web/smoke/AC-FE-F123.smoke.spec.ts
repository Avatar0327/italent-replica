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
    await form.getByRole('textbox', { name: /名称$/, exact: true }).fill('我的未保存名称');
    if (kind === 'evaluation') {
      await form.getByRole('button', { name: '下一步', exact: true }).click();
      await form.getByRole('button', { name: '下一步', exact: true }).click();
    }
    await form.getByRole('button', save).click();
    if (kind === 'survey360')
      await expect(form.getByRole('textbox', { name: /名称$/, exact: true })).toHaveValue('我的未保存名称');
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
  await form.getByRole('textbox', { name: /名称$/, exact: true }).fill('未确认改名');
  await form.getByRole('button', save).click();
  await expect(form).toContainText('结果待确认');
  await form.getByRole('button', { name: /取\s*消/, exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await open();
  await expect(form.getByRole('textbox', { name: /名称$/, exact: true })).toHaveValue('未确认改名');
  await expect(form.getByRole('textbox', { name: /名称$/, exact: true })).toBeDisabled();
  await expect(form.getByRole('button', save)).toBeDisabled();
  expect(writes).toBe(1);
});

test('AC-FE-F123 提交中重复点击只发一次，只提交当前可编辑字段，422 后可改正', async ({ page }) => {
  await setupR3b(page, '/survey360');
  await page.route('**/permission/me/objects/Survey360.Activity', (route) =>
    route.fulfill({
      json: {
        objectCode: 'Survey360.Activity',
        dataOperations: { read: true },
        viewableFields: ['name', 'welcome', 'status'],
        editableFields: ['name'],
        buttons: [{ buttonCode: 'update', level: 'detail' }],
      },
    }),
  );
  await expect(page.getByRole('button', { name: activity.name, exact: true })).toBeVisible();
  await page.reload();
  await page.getByLabel('切换演示身份').selectOption('20000000-0000-4000-8000-000000000001');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: { command: string; body: unknown }[] = [];
  await page.route(`**/survey360/activities/${id}`, async (route) => {
    if (route.request().method() === 'GET') return route.fallback();
    requests.push({ command: route.request().headers()['idempotency-key']!, body: route.request().postDataJSON() });
    if (requests.length === 1) {
      await gate;
      return route.fulfill({ status: 422, json: { error: { code: 'VALIDATION_FAILED', message: '合成拒绝' } } });
    }
    return route.fulfill({ json: { ...activity, revision: 4 } });
  });
  await page.getByRole('button', { name: activity.name, exact: true }).click();
  await page.getByRole('button', { name: /编\s*辑/, exact: true }).click();
  const form = page.getByRole('dialog', { name: '编辑', exact: true });
  const name = form.getByRole('textbox', { name: /名称$/, exact: true });
  await name.fill('第一次改名');
  await form.getByRole('button', save).evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(() => requests.length).toBe(1);
  await expect(name).toBeDisabled();
  release();
  await expect(name).toBeEnabled();
  await expect(name).toHaveValue('第一次改名');
  await name.fill('修正名称');
  await form.getByRole('button', save).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests.map((r) => r.body)).toEqual([{ name: '第一次改名' }, { name: '修正名称' }]);
  expect(requests[0]!.command).not.toBe(requests[1]!.command);
});
