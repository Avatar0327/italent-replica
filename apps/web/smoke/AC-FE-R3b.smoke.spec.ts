import { test, expect, user } from './fixtures.js';

// 本机多工作区并行，单项上限留给冷启动；不使用重试掩盖功能错误。
test.setTimeout(90_000);

for (const entry of [
  { path: '/evaluation', title: '活动设置', create: '新建评定活动' },
  { path: '/survey360', title: '评估活动', create: '新增活动' },
]) {
  test(`AC-FE-R3b-03 ${entry.path} 切换身份后打开列表与表单`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.route('**/permission/me/objects/*', (route) =>
      route.fulfill({
        json: {
          objectCode: decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!),
          dataOperations: { read: true, create: true, update: true },
          viewableFields: [
            'name',
            'status',
            'year',
            'typeId',
            'cycleId',
            'ownerOrgId',
            'managerEmployeeId',
            'startDate',
            'endDate',
            'effectiveDate',
            'orgRange',
            'categoryIds',
            'levelIds',
            'applicants',
            'maxLevelJump',
            'conditions',
            'chains',
            'scene',
            'form',
            'welcome',
            'showAppraiserName',
            'roleDisplay',
          ],
          editableFields: [
            'name',
            'year',
            'typeId',
            'cycleId',
            'ownerOrgId',
            'managerEmployeeId',
            'startDate',
            'endDate',
            'effectiveDate',
            'orgRange',
            'categoryIds',
            'levelIds',
            'applicants',
            'maxLevelJump',
            'conditions',
            'chains',
            'scene',
            'form',
            'welcome',
            'showAppraiserName',
            'roleDisplay',
          ],
          buttons: [{ buttonCode: 'create', level: 'list' }],
        },
      }),
    );
    await page.goto(entry.path);
    await page.getByLabel('切换演示身份').selectOption(user);
    await page.waitForURL('**/staff');
    await page.goto(entry.path);
    await expect(page.getByRole('heading', { name: entry.title, exact: true })).toBeVisible();
    await page.screenshot({ path: `/tmp/fe-r3b-${entry.path.slice(1)}.png` });
    await page.getByRole('button', { name: entry.create, exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByLabel('名称', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

// API 契约夹具仅用于页面冒烟；不是 DB 集成验证。
import { setupR3b, id, ev } from './r3b-fixtures.js';

test('AC-FE-R3b-04 评定详情、名单、演示注释与三步编辑，保存携带版本且不回传只读字段', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => {
    if (e.type() === 'error') errors.push(e.text());
  });
  await setupR3b(page, '/evaluation');
  await page.getByRole('button', { name: ev.name, exact: true }).click();
  const detail = page.getByRole('dialog', { name: ev.name, exact: true });
  await expect(detail).toBeVisible();
  await detail.getByRole('tab', { name: '参评名单' }).click();
  await expect(detail.getByRole('heading', { name: '参评名单', exact: true })).toBeVisible();
  await expect(detail.locator('tr[data-row-key]')).toHaveCount(1);
  await detail.getByRole('tab', { name: '评定过程' }).click();
  await expect(detail.getByText('以下为独立合成流程示意，不代表本活动人员或实际进度。')).toBeVisible();
  await detail.getByRole('button', { name: /编\s*辑/, exact: true }).click();
  const form = page.getByRole('dialog', { name: '编辑', exact: true });
  await form.screenshot({ path: '/tmp/fe-r3b-wizard.png' });
  await form.getByRole('textbox', { name: '名称', exact: true }).fill('合成改名');
  await form.getByRole('button', { name: '下一步', exact: true }).click();
  await form.getByRole('button', { name: '下一步', exact: true }).click();
  const request = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith(`/activities/${id}`));
  await form.getByRole('button', { name: /保\s*存/, exact: true }).click();
  const sent = await request;
  expect(sent.headers()['if-match']).toBe('2');
  expect(sent.headers()['idempotency-key']).toBeTruthy();
  expect(sent.postDataJSON()).toEqual({ name: '合成改名' });
  await expect(form).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('AC-FE-R3b-05 360 活动与评价关系的详情与表单均可渲染', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => {
    if (e.type() === 'error') errors.push(e.text());
  });
  await setupR3b(page, '/survey360');
  await page.getByRole('button', { name: '合成领导力评估', exact: true }).click();
  const detail = page.getByRole('dialog', { name: '合成领导力评估', exact: true });
  await detail.getByRole('tab', { name: '评价关系', exact: true }).click();
  await expect(detail.getByText('合成参评人', { exact: true })).toBeVisible();
  await detail.getByRole('button', { name: '添加评价对象', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '添加评价对象' })).toBeVisible();
  await page
    .getByRole('dialog', { name: '添加评价对象' })
    .getByRole('button', { name: /取\s*消/, exact: true })
    .click();
  await detail.getByRole('button', { name: '设置评价者', exact: true }).click();
  await expect(page.getByText('合成评价者', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '添加评价者', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '添加评价者' })).toBeVisible();

  expect(errors).toEqual([]);
});

test('AC-FE-R3b-06 只读权限不能看到新建、编辑、发布；隐藏字段不补全', async ({ page }) => {
  await setupR3b(page, '/evaluation', true);
  await expect(page.getByRole('columnheader', { name: '年度', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '新建评定活动', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: ev.name, exact: true }).click();
  await expect(page.getByRole('button', { name: /编\s*辑/, exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '发布活动', exact: true })).toHaveCount(0);
});

test('AC-FE-R3b-08 360 新建发送真实契约；评定版本冲突不自动重放', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await setupR3b(page, '/survey360');
  await page.getByRole('button', { name: '新增活动', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新增活动' });
  await form.getByLabel('名称', { exact: true }).fill('合成新活动');
  const pending = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/survey360/activities'));
  await form.getByRole('button', { name: /保\s*存/ }).click();
  const sent = await pending;
  expect(sent.postDataJSON()).toEqual({
    name: '合成新活动',
    form: 'single',
    showAppraiserName: true,
    roleDisplay: 'name',
  });
  expect(sent.headers()['if-match']).toBe('0');
  await setupR3b(page, '/evaluation');
  let writes = 0;
  await page.route(`**/evaluation/activities/${id}/publish`, (route) => {
    writes++;
    return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT' } } });
  });
  await page.getByRole('button', { name: ev.name, exact: true }).click();
  await page.getByRole('button', { name: '发布活动', exact: true }).click();
  await page.getByRole('button', { name: /确\s*定/, exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('刷新');
  const publish = page.getByRole('button', { name: /发布活动$/ });
  await expect(publish).toBeDisabled();
  await expect(publish).not.toHaveClass(/ant-btn-loading/);
  expect(writes).toBe(1);
  expect(errors).toEqual([]);
});

for (const title of ['套卷', '题库 · 企业自定义']) {
  test(`AC-FE-R3b-05 ${title} 列表、预览与编辑抽屉无控制台错误`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (e) => {
      if (e.type() === 'error') errors.push(e.text());
    });
    await setupR3b(page, '/survey360');
    await page.getByRole('tab', { name: title, exact: true }).click();
    await page.getByRole('button', { name: '合成协作套卷', exact: true }).click();
    const detail = page.getByRole('dialog', { name: '合成协作套卷', exact: true });
    await detail.getByRole('tab', { name: '预览', exact: true }).click();
    await expect(detail.getByText('主动共享信息')).toBeVisible();
    await detail.getByRole('button', { name: /编\s*辑/, exact: true }).click();
    await expect(page.getByRole('dialog', { name: /编\s*辑/, exact: true })).toBeVisible();
    await page
      .getByRole('dialog', { name: /编\s*辑/, exact: true })
      .getByRole('button', { name: /取\s*消/, exact: true })
      .click();
    await detail.getByRole('button', { name: '关闭', exact: true }).click();
    expect(errors).toEqual([]);
  });
}
