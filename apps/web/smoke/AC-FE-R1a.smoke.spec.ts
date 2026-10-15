import { test, expect, user } from './fixtures.js';

const id = '40000000-0000-4000-8000-000000000001';
const fields = [
  'name',
  'code',
  'enabled',
  'parents',
  'remarks',
  'establishedOn',
  'effectiveDate',
  'startDate',
  'stopDate',
  'layerLevel',
  'grade',
  'level',
  'orgId',
  'postId',
  'periodType',
  'maintenanceMode',
];
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-12T08:00:00Z'));
  await page.route('**/permission/me/objects/*', (route) =>
    route.fulfill({
      json: {
        objectCode: new URL(route.request().url()).pathname.split('/').at(-1),
        dataOperations: { create: true, update: true },
        viewableFields: fields,
        editableFields: fields,
        buttons: [
          { buttonCode: 'create', level: 'list' },
          { buttonCode: 'update', level: 'detail' },
          { buttonCode: 'syncSequence', level: 'list' },
        ],
      },
    }),
  );
  await page.route('**/api/tenant/org/organizations**', (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith(id)
        ? {
            id,
            revision: 1,
            name: '合成组织',
            code: 'ORG-001',
            enabled: true,
            establishedOn: '2026-01-01',
            parents: { admin: { parentId: null, sequence: null } },
          }
        : { items: [{ id, revision: 1, name: '合成组织', code: 'ORG-001', enabled: true }], hasDataPermission: true },
    }),
  );
  await page.route('**/api/tenant/job/**', (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith(id)
        ? { id, revision: 1, name: '合成条目', code: 'JOB-001', enabled: true }
        : { items: [{ id, revision: 1, name: '合成条目', code: 'JOB-001', enabled: true }], today: '2026-10-12' },
    }),
  );
  await page.route('**/api/tenant/establishment/schemes**', (route) =>
    route.fulfill({
      json: {
        items: [{ id, revision: 1, name: '合成年度方案', periodType: 'annual', maintenanceMode: 'local' }],
      },
    }),
  );
});

for (const kind of [
  'layers',
  'grades',
  'level-types',
  'levels',
  'sequences',
  'professional-lines',
  'posts',
  'positions',
]) {
  test(`AC-FE-R1a-03 ${kind} 身份切换、列表、详情、新建与编辑抽屉`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(`/job?kind=${kind}`);
    await page.getByLabel('切换演示身份').selectOption(user);
    await page.waitForURL('**/staff');
    await page.goto(`/job?kind=${kind}`);
    await expect(page.getByRole('button', { name: '合成条目', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '合成条目', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page
      .getByRole('button', { name: /编\s*辑/, exact: true })
      .last()
      .click();
    await expect(page.getByRole('dialog').getByLabel('名称', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /取\s*消/, exact: true }).click();
    await page.getByRole('button', { name: /新\s*建/, exact: true }).click();
    await expect(page.getByRole('dialog').getByLabel('名称', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('page.png'), fullPage: true, animations: 'disabled' });
    expect(errors).toEqual([]);
  });
}
for (const tab of ['list', 'tree', 'changes', 'establishment']) {
  test(`AC-FE-R1a-04 组织 ${tab} 页面与抽屉`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(`/org?tab=${tab}`);
    await page.getByLabel('切换演示身份').selectOption(user);
    await page.waitForURL('**/staff');
    await page.goto(`/org?tab=${tab}`);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    if (tab === 'establishment') await expect(page.getByText('合成年度方案')).toBeVisible();
    else {
      await page.getByText('合成组织', { exact: true }).first().click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page
        .getByRole('button', { name: tab === 'changes' ? /变\s*更/ : /编\s*辑/, exact: true })
        .last()
        .click();
      await expect(page.getByRole('dialog').getByRole('button', { name: /保\s*存/ })).toBeVisible();
      await page.getByRole('button', { name: /取\s*消/ }).click();
    }
    await page.getByRole('switch', { name: '注释' }).click();
    await expect(page.locator('.decision-note')).toHaveCount(2);
    await page.screenshot({ path: testInfo.outputPath('page.png'), fullPage: true, animations: 'disabled' });
    expect(errors).toEqual([]);
  });
}

test('AC-FE-R1a-06 只读身份不展示写按钮或隐藏字段', async ({ page, baseURL }) => {
  await page.context().addCookies([
    { name: 'italent_demo_tenant', value: '10000000-0000-4000-8000-000000000001', url: baseURL! },
    { name: 'italent_demo_user', value: user, url: baseURL! },
  ]);
  await page.route('**/permission/me/objects/*', (route) =>
    route.fulfill({
      json: {
        objectCode: new URL(route.request().url()).pathname.split('/').at(-1),
        dataOperations: { create: false, update: false, delete: false },
        viewableFields: ['name'],
        editableFields: [],
        buttons: [],
      },
    }),
  );
  await page.goto('/job?kind=layers');
  await expect(page.getByRole('button', { name: '合成条目' })).toBeVisible();
  await expect(page.getByRole('button', { name: /新\s*建/ })).toHaveCount(0);
  await expect(page.getByText('JOB-001')).toHaveCount(0);
  await page.getByRole('button', { name: '合成条目' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('button', { name: /编\s*辑/ })).toHaveCount(0);
});

test('AC-FE-R1a-07 新建职层校验必填项并携带租户、命令键和 revision', async ({ page, baseURL }) => {
  await page.context().addCookies([
    { name: 'italent_demo_tenant', value: '10000000-0000-4000-8000-000000000001', url: baseURL! },
    { name: 'italent_demo_user', value: user, url: baseURL! },
  ]);
  const writes: { body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  await page.route('**/api/tenant/job/layers', (route) => {
    writes.push({ body: route.request().postDataJSON(), headers: route.request().headers() });
    return route.fulfill({ status: 201, json: { id, revision: 1 } });
  });
  await page.goto('/job?kind=layers');
  await page.getByRole('button', { name: /新\s*建/ }).click();
  await page.getByRole('button', { name: /保\s*存/ }).click();
  await expect(page.getByText('请填写必填项', { exact: true })).toBeVisible();
  expect(writes).toHaveLength(0);
  await page.getByRole('dialog').getByLabel('名称', { exact: true }).fill('合成新职层');
  await page.getByRole('button', { name: /保\s*存/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(writes).toHaveLength(1);
  expect(writes[0]!.body).toMatchObject({ name: '合成新职层', enabled: true });
  expect(writes[0]!.body).toHaveProperty('startDate', '2026-10-12');
  expect(writes[0]!.headers['if-match']).toBe('0');
  expect(writes[0]!.headers['idempotency-key']).toMatch(/^[\da-f-]{36}$/);
  expect(writes[0]!.headers['x-tenant-id']).toBe('10000000-0000-4000-8000-000000000001');
});

// AC-FE-R1a-08（冲突重读）随表单内核一起移到 AC-FE-R1a-kernel.smoke.spec.ts。

test('AC-FE-R1a-09 组织停用提交后端校验，编制详情只读', async ({ page, baseURL }) => {
  await page.context().addCookies([
    { name: 'italent_demo_tenant', value: '10000000-0000-4000-8000-000000000001', url: baseURL! },
    { name: 'italent_demo_user', value: user, url: baseURL! },
  ]);
  let body: unknown;
  await page.route(`**/api/tenant/org/organizations/${id}`, (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({ json: { id, revision: 2, enabled: false } });
  });
  await page.goto('/org');
  await page.getByRole('button', { name: '合成组织', exact: true }).click();
  await page.getByRole('button', { name: /停\s*用/, exact: true }).click();
  await expect(page.getByRole('dialog', { name: '停用 · 合成组织' })).toContainText('级联停用');
  await page.getByRole('button', { name: /保\s*存/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(body).toEqual({ enabled: false, effectiveDate: '2026-10-12' });
  await page.route(`**/api/tenant/establishment/schemes/${id}`, (route) =>
    route.fulfill({
      json: {
        id,
        name: '合成年度方案',
        periodType: 'annual',
        maintenanceMode: 'local',
      },
    }),
  );
  await page.goto('/org?tab=establishment');
  await page.getByRole('button', { name: '合成年度方案' }).click();
  await expect(page.getByRole('dialog')).toContainText('年度');
  await expect(page.getByRole('dialog').getByRole('button', { name: /保\s*存/ })).toHaveCount(0);
});

test('AC-FE-R1a-12 列表序列同步保留选中对象 revision 和异步回执', async ({ page, baseURL }) => {
  await page.context().addCookies([
    { name: 'italent_demo_tenant', value: '10000000-0000-4000-8000-000000000001', url: baseURL! },
    { name: 'italent_demo_user', value: user, url: baseURL! },
  ]);
  const writes: unknown[] = [];
  await page.route('**/api/tenant/job/posts/sync-sequence', (route) => {
    writes.push(route.request().postDataJSON());
    return route.fulfill({ status: 202, json: { taskId: id, state: 'pending' } });
  });
  await page.goto('/job?kind=posts');
  await expect(page.getByRole('button', { name: '合成条目' })).toBeVisible();
  await page.getByRole('checkbox').nth(1).check();
  await page.getByRole('button', { name: '同步序列到任职', exact: true }).click();
  await page.getByRole('button', { name: /确\s*认/, exact: true }).click();
  await expect(page.getByText('后台开始处理对应任职记录上的序列，完成后会给你发送消息。')).toBeVisible();
  expect(writes).toEqual([{ items: [{ id, revision: 1 }] }]);
});

test('AC-FE-R1a-13 原站视图切换、主题尺寸与15条分页', async ({ page }, testInfo) => {
  const sizes: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/tenant/job/positions') sizes.push(url.searchParams.get('pageSize') ?? '');
  });
  await page.goto('/job?kind=positions');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.waitForURL('**/staff');
  await page.goto('/job?kind=positions');
  await expect(page.getByRole('button', { name: '合成条目', exact: true })).toBeVisible();
  await expect(page.locator('.ant-breadcrumb')).toHaveCount(0);
  await expect(page.getByText('15条/页', { exact: true })).toBeVisible();
  expect(sizes.length).toBeGreaterThan(0);
  expect(sizes.every((size) => size === '15')).toBe(true);
  await page.getByText('15条/页', { exact: true }).click();
  await page.getByText('30条/页', { exact: true }).click();
  await expect.poll(() => sizes.at(-1)).toBe('30');
  const create = page.getByRole('button', { name: /新\s*建/, exact: true });
  await expect(create).toHaveCSS('background-color', 'rgb(20, 110, 255)');
  await expect(create).toHaveCSS('height', '32px');
  await expect(create).toHaveCSS('border-radius', '5px');
  await expect(page.locator('.ant-table-tbody > tr.ant-table-row').first()).toHaveCSS('height', '40px');
  await expect(page.locator('.ant-table-thead > tr').first()).toHaveCSS('height', '40px');
  await expect(page.locator('.ant-table-cell').first()).toHaveCSS('font-size', '12px');
  await expect(page.getByRole('button', { name: '合成条目', exact: true })).toHaveCSS('color', 'rgb(0, 84, 240)');
  await expect(page.locator('.shell-content')).toHaveCSS('background-color', 'rgb(247, 249, 250)');
  await page.getByRole('button', { name: '切换视图' }).click();
  await page.getByRole('menuitem', { name: '职等', exact: true }).click();
  await expect(page).toHaveURL(/kind=grades/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('职等');
  await expect(create).toBeEnabled();
  await expect(page.locator('.ant-spin-spinning')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('reference-list.png'), fullPage: true, animations: 'disabled' });
});

test('AC-FE-R1a-14 详情页签留在右侧抽屉，编辑使用双列弹窗', async ({ page }, testInfo) => {
  await page.goto('/org');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.waitForURL('**/staff');
  await page.goto('/org');
  await page.getByRole('button', { name: '切换视图' }).click();
  await page.getByRole('menuitem', { name: '组织架构图', exact: true }).click();
  await expect(page).toHaveURL(/tab=tree/);
  await page.getByRole('button', { name: '合成组织', exact: true }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByRole('tab', { name: '组织单元', exact: true })).toBeVisible();
  await expect.poll(async () => Math.round((await drawer.boundingBox())?.x ?? -1)).toBe(320);
  await page.screenshot({ path: testInfo.outputPath('reference-detail.png'), fullPage: true, animations: 'disabled' });
  await drawer.getByRole('button', { name: /编\s*辑/, exact: true }).click();
  await expect(page.locator('.ant-modal')).toBeVisible();
  await expect(page.locator('.ant-modal')).toHaveCSS('width', '800px');
  await expect(page.locator('.form-fields-modal').first()).toHaveCSS('display', 'grid');
  await expect(page.locator('.ant-modal')).toHaveCSS('transform', 'none');
  await page.screenshot({ path: testInfo.outputPath('reference-form.png'), fullPage: true, animations: 'disabled' });
});

for (const route of ['/org', '/job?kind=positions']) {
  test(`AC-FE-R1a-15 ${route} 高级筛选仅确认后生效，取消丢弃草稿`, async ({ page }) => {
    const queries: URL[] = [];
    const endpoint = route === '/org' ? '/api/tenant/org/organizations' : '/api/tenant/job/positions';
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === endpoint) queries.push(url);
    });
    await page.goto(route);
    await page.getByLabel('切换演示身份').selectOption(user);
    await page.waitForURL('**/staff');
    await page.goto(route);
    const open = page.getByRole('button', { name: '高级筛选', exact: true });
    await open.click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toHaveCSS('width', '500px');
    const count = queries.length;
    await drawer.getByLabel('名称', { exact: true }).fill('不应生效');
    await drawer.getByRole('button', { name: /取\s*消/ }).click();
    expect(queries).toHaveLength(count);
    await open.click();
    await expect(drawer.getByLabel('名称', { exact: true })).toHaveValue('');
    await drawer.getByLabel('名称', { exact: true }).fill('合成');
    await drawer.getByRole('button', { name: /确\s*定/ }).click();
    await expect.poll(() => queries.at(-1)?.searchParams.get('name')).toBe('合成');
    await expect(page.locator('.page-filters .ant-input-search input').first()).toHaveValue('合成');
    await open.click();
    await drawer.getByRole('button', { name: /清\s*空/ }).click();
    await expect(drawer.getByLabel('名称', { exact: true })).toHaveValue('');
    await drawer.getByRole('button', { name: /确\s*定/ }).click();
    await expect.poll(() => queries.at(-1)?.searchParams.get('name')).toBeNull();
    expect(queries.at(-1)?.searchParams.get('includeDisabled')).toBe('true');
    expect(queries.at(-1)?.searchParams.get('asOf')).toBe('2026-10-12');
  });
}
