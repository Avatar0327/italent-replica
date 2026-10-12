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
        ],
      },
    }),
  );
  await page.route('**/api/tenant/org/organizations**', (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith(id)
        ? { id, revision: 1, name: '合成组织', code: 'ORG-001', enabled: true, establishedOn: '2026-01-01' }
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
    await page.screenshot({ path: testInfo.outputPath('page.png'), fullPage: true });
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
    await page.screenshot({ path: testInfo.outputPath('page.png'), fullPage: true });
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
  expect(writes[0]!.body).toMatchObject({ name: '合成新职层', enabled: true, startDate: '2026-10-12' });
  expect(writes[0]!.headers['if-match']).toBe('0');
  expect(writes[0]!.headers['idempotency-key']).toMatch(/^[\da-f-]{36}$/);
  expect(writes[0]!.headers['x-tenant-id']).toBe('10000000-0000-4000-8000-000000000001');
});

test('AC-FE-R1a-08 组织变更显式联动，冲突后不盲重放', async ({ page, baseURL }) => {
  await page.context().addCookies([
    { name: 'italent_demo_tenant', value: '10000000-0000-4000-8000-000000000001', url: baseURL! },
    { name: 'italent_demo_user', value: user, url: baseURL! },
  ]);
  const bodies: Record<string, unknown>[] = [];
  await page.route(`**/api/tenant/org/organizations/${id}`, (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT' } } });
  });
  await page.goto('/org?tab=changes');
  await page.getByRole('button', { name: '合成组织', exact: true }).click();
  await page.getByRole('button', { name: /变\s*更/, exact: true }).click();
  await page.getByRole('dialog').getByLabel('机构名称').fill('合成组织二');
  await page.getByRole('button', { name: /保\s*存/ }).click();
  await expect(page.getByText('请选择是否新增任职')).toBeVisible();
  expect(bodies).toHaveLength(0);
  await page.getByRole('dialog').getByLabel('是否新增任职').click();
  await page.getByTitle('否', { exact: true }).click();
  await page.getByRole('button', { name: /保\s*存/ }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('刷新');
  expect(bodies).toEqual([{ name: '合成组织二', effectiveDate: '2026-10-12', addEmployment: false }]);
  await page.getByRole('button', { name: /保\s*存/ }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('重新打开');
  expect(bodies).toHaveLength(1);
});

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
  await expect(page.getByRole('dialog')).toContainText('级联停用');
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
