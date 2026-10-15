// F-132 第 2 段（组织页）：按原站核对后的按钮位置与顺序、列设置（B2_03 居中两栏弹窗）、组织导入与变更 / 停用表单。
// 夹具按接口真实形状：组织行含 broadType、isVirtual、displayOrder；导入回执 200 { results }，行冲突 409 CONFLICT，
// 更新行版本过期 409 REVISION_CONFLICT（details 含 expected / actual / rowIndex / sourceCode）。
import type { Page, Request } from '@playwright/test';
import { test, expect, user } from './fixtures.js';

const tenant = '10000000-0000-4000-8000-000000000001';
const id = '40000000-0000-4000-8000-000000000001';
const parent = '40000000-0000-4000-8000-000000000002';
const ALL = [
  'sourceCode',
  'parentId',
  'name',
  'code',
  'enabled',
  'parents',
  'remarks',
  'shortName',
  'fullName',
  'location',
  'broadType',
  'isVirtual',
  'displayOrder',
  'personInChargeId',
  'hrbpId',
  'establishedOn',
  'effectiveDate',
  'startDate',
  'stopDate',
];
const org = {
  id,
  revision: 1,
  name: '合成组织',
  code: 'ORG-001',
  shortName: null,
  fullName: '合成集团/合成组织',
  broadType: '部门',
  isVirtual: false,
  displayOrder: null,
  location: null,
  remarks: null,
  enabled: true,
  establishedOn: '2026-01-01',
  startDate: '2026-01-01',
  stopDate: '9999-12-31',
  personInChargeId: null,
  hrbpId: null,
  parents: { admin: { parentId: null, sequence: null } },
};
const BUTTONS = ['create@list', 'update@detail', 'import@list'];
async function setup(page: Page, baseURL: string, buttons = BUTTONS, operations = { create: true, update: true }) {
  await page.clock.setFixedTime(new Date('2026-10-12T08:00:00Z'));
  await page.context().addCookies([
    { name: 'italent_demo_tenant', value: tenant, url: baseURL },
    { name: 'italent_demo_user', value: user, url: baseURL },
  ]);
  await page.route('**/permission/me/objects/*', (route) =>
    route.fulfill({
      json: {
        objectCode: new URL(route.request().url()).pathname.split('/').at(-1),
        dataOperations: operations,
        viewableFields: ALL,
        editableFields: ALL,
        buttons: buttons.map((code) => ({ buttonCode: code.split('@')[0], level: code.split('@')[1] })),
      },
    }),
  );
  const lists: Request[] = [];
  await page.route('**/api/tenant/org/organizations**', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const detail = new URL(route.request().url()).pathname.endsWith(id);
    if (!detail) lists.push(route.request());
    return route.fulfill({ json: detail ? org : { items: [org], hasDataPermission: true } });
  });
  return lists;
}
const menu = (page: Page) => page.locator('.ant-dropdown:visible').getByRole('menuitem');
const save = (page: Page) => page.getByRole('dialog').getByRole('button', { name: /保\s*存/, exact: true });
const rows = [
  { sourceCode: 'SRC-1', code: 'ORG-101', name: '合成导入一', parentId: parent },
  { sourceCode: 'SRC-2', code: 'ORG-001', name: '合成组织', parentId: parent, orgId: id, expectedRevision: 1 },
];
const file = (name: string, content: unknown[]) => ({
  name,
  mimeType: 'application/json',
  buffer: Buffer.from(JSON.stringify({ rows: content })),
});
async function chooseImport(page: Page) {
  await page.getByRole('button', { name: '更多操作' }).click();
  await page.getByRole('menuitem', { name: '导入' }).click();
  const dialog = page.getByRole('dialog', { name: '导入组织' });
  await dialog.getByLabel('选择文件').setInputFiles(file('org-import.json', rows));
  await expect(dialog.getByText('已读取 2 行')).toBeVisible();
  return dialog;
}
type Reply = { status: number; json: unknown };
async function routeImport(page: Page, reply: (request: Request) => Reply) {
  const posts: Request[] = [];
  await page.route('**/api/tenant/org/import', (route) => {
    posts.push(route.request());
    return route.fulfill(reply(route.request()));
  });
  return posts;
}

test('AC-FE-R1a-42 工具栏、行内、详情按钮按原站位置与顺序', async ({ page, baseURL }) => {
  await setup(page, baseURL!);
  await page.goto('/org');
  const row = page.locator('tr[data-row-key]').first();
  await expect(row.getByRole('button')).toHaveText([/合成组织/, '新建下级', /编\s*辑/, '更多']);
  await row.getByRole('button', { name: '更多' }).click();
  await expect(menu(page)).toHaveText(['变更', '停用']);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '更多操作' }).click();
  await expect(menu(page)).toHaveText(['导入']);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '刷新' })).toHaveCount(0);
  await row.getByRole('button', { name: '合成组织', exact: true }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByRole('button', { name: /编\s*辑/ })).toBeVisible();
  await drawer.getByRole('button', { name: '更多操作' }).click();
  await expect(menu(page)).toHaveText(['变更', '停用', '新建下级']);
  await page.getByRole('menuitem', { name: '新建下级' }).click();
  const create = page.getByRole('dialog', { name: '新建下级' });
  await expect(create.getByText('点击保存之前请仔细确认以下信息，保存后系统即刻建立新组织')).toBeVisible();
  await expect(create.getByTitle('合成组织')).toBeVisible();
  for (const label of ['编码', '名称', '简称', '工作地'])
    await expect(create.getByLabel(label, { exact: true })).toBeVisible();
});

test('AC-FE-R1a-42 无导入按钮不出导入入口（反向）', async ({ page, baseURL }) => {
  await setup(page, baseURL!, ['create@list', 'update@detail']);
  await page.goto('/org');
  await expect(page.getByRole('button', { name: /^新\s*建$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '更多操作' })).toHaveCount(0);
});

test('AC-FE-R1a-43 组织导入：整批提交 { rows }，按回执显示逐行结果并刷新列表', async ({ page, baseURL }) => {
  const lists = await setup(page, baseURL!);
  const posts = await routeImport(page, (request) => {
    const sent = (request.postDataJSON() as { rows: typeof rows }).rows;
    const results = [
      { sourceCode: sent[0]!.sourceCode, code: sent[0]!.code, status: 'created', orgId: parent },
      { sourceCode: sent[1]!.sourceCode, code: sent[1]!.code, status: 'updated', orgId: id },
    ];
    return { status: 200, json: { results } };
  });
  await page.goto('/org');
  await expect(page.locator('tr[data-row-key]')).toHaveCount(1);
  const before = lists.length;
  const dialog = await chooseImport(page);
  await save(page).click();
  await expect(dialog).toHaveCount(0);
  const result = page.getByRole('dialog', { name: '导入结果' });
  await expect(result.locator('tbody tr')).toHaveText([/SRC-1\s*ORG-101\s*新建/, /SRC-2\s*ORG-001\s*更新/]);
  await expect(page.getByText('导入成功，列表已刷新。')).toBeVisible();
  expect(lists.length).toBeGreaterThan(before);
  expect(posts).toHaveLength(1);
  expect(posts[0]!.postDataJSON()).toEqual({ rows });
  expect(posts[0]!.headers()['if-match']).toBe('0');
  expect(posts[0]!.headers()['idempotency-key']).toMatch(/^[\da-f-]{36}$/);
});

test('AC-FE-R1a-43 组织导入行冲突 409：整批未保存，提示服务端原因，可改文件再提', async ({ page, baseURL }) => {
  await setup(page, baseURL!);
  const error = { code: 'CONFLICT', message: '导入行冲突，整批未保存', details: { rowIndex: 1, sourceCode: 'SRC-2' } };
  const posts = await routeImport(page, () => ({ status: 409, json: { error } }));
  await page.goto('/org');
  const dialog = await chooseImport(page);
  await save(page).click();
  await expect(dialog.getByText('导入行冲突，整批未保存')).toBeVisible();
  await expect(save(page)).toBeEnabled();
  await expect(page.getByRole('dialog', { name: '导入结果' })).toHaveCount(0);
  expect(posts).toHaveLength(1);
});

for (const [label, reply] of [
  ['服务端 503', { status: 503, json: { error: { code: 'SERVICE_UNAVAILABLE', message: '服务暂不可用' } } }],
  ['回执形状不符', { status: 200, json: { items: [] } }],
] as const) {
  test(`AC-FE-R1a-43 组织导入结果未知（${label}）：锁定，关闭重开仍锁定，不发新命令`, async ({ page, baseURL }) => {
    await setup(page, baseURL!);
    const posts = await routeImport(page, () => reply);
    await page.goto('/org');
    const dialog = await chooseImport(page);
    await save(page).click();
    await expect(dialog.getByText(/处理中 \/ 结果待确认/)).toBeVisible();
    await expect(save(page)).toBeDisabled();
    await expect(page.getByRole('dialog', { name: '导入结果' })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: '更多操作' }).click();
    await page.getByRole('menuitem', { name: '导入' }).click();
    await expect(dialog.getByText(/处理中 \/ 结果待确认/)).toBeVisible();
    await expect(dialog.getByText('已读取 2 行')).toBeVisible();
    await expect(save(page)).toBeDisabled();
    expect(posts).toHaveLength(1);
  });
}

test('AC-FE-R1a-42 有导入按钮但新建、更新数据权都没有时不出导入入口（反向）', async ({ page, baseURL }) => {
  await setup(page, baseURL!, BUTTONS, { create: false, update: false });
  await page.goto('/org');
  await expect(page.locator('tr[data-row-key]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '更多操作' })).toHaveCount(0);
});

test('AC-FE-R1a-43 组织导入逐行预检：只有新建权时，带 orgId 的更新行就地提示，不发请求（反向）', async ({
  page,
  baseURL,
}) => {
  await setup(page, baseURL!, BUTTONS, { create: true, update: false });
  const posts = await routeImport(page, () => ({ status: 200, json: { results: [] } }));
  await page.goto('/org');
  await page.getByRole('button', { name: '更多操作' }).click();
  await page.getByRole('menuitem', { name: '导入' }).click();
  const dialog = page.getByRole('dialog', { name: '导入组织' });
  await dialog.getByLabel('选择文件').setInputFiles(file('org-import.json', rows));
  await expect(dialog.getByText('第 2 行需要更新组织的权限，当前无权更新')).toBeVisible();
  await save(page).click();
  await expect(dialog.getByText('请选择导入文件')).toBeVisible();
  expect(posts).toHaveLength(0);
});

test('AC-FE-R1a-43 组织导入换文件：读取完成前不能提交旧文件，较早的读取结果不覆盖后选的文件', async ({
  page,
  baseURL,
}) => {
  await setup(page, baseURL!);
  // 名为 slow.json 的文件读取挂起，直到页面调用 releaseSlow()，模拟大文件读取未完成。
  await page.addInitScript(() => {
    const read = File.prototype.text;
    File.prototype.text = function (this: File) {
      if (this.name !== 'slow.json') return read.call(this);
      return new Promise<string>((done) => {
        (window as unknown as { releaseSlow(): void }).releaseSlow = () => done(read.call(this));
      });
    };
  });
  const posts = await routeImport(page, (request) => {
    const sent = (request.postDataJSON() as { rows: typeof rows }).rows;
    const results = sent.map((item) => ({ sourceCode: item.sourceCode, code: item.code, status: 'created' }));
    return { status: 200, json: { results } };
  });
  await page.goto('/org');
  const dialog = await chooseImport(page);
  const third = { sourceCode: 'SRC-3', code: 'ORG-103', name: '合成导入三', parentId: parent };
  await dialog.getByLabel('选择文件').setInputFiles(file('slow.json', [...rows, third]));
  await expect(dialog.getByText('已读取 2 行')).toHaveCount(0);
  await save(page).click();
  await expect(dialog.getByText('请选择导入文件')).toBeVisible();
  expect(posts).toHaveLength(0);
  await expect(dialog.getByText('正在读取文件…')).toBeVisible();
  await dialog.getByLabel('选择文件').setInputFiles(file('fast.json', [third]));
  await expect(dialog.getByText('已读取 1 行')).toBeVisible();
  await page.evaluate(async () => {
    (window as unknown as { releaseSlow(): void }).releaseSlow();
    await new Promise((done) => setTimeout(done, 200));
  });
  await expect(dialog.getByText('已读取 1 行')).toBeVisible();
  await save(page).click();
  await expect(page.getByRole('dialog', { name: '导入结果' })).toBeVisible();
  expect(posts.map((request) => request.postDataJSON())).toEqual([{ rows: [third] }]);
});

test('AC-FE-R1a-43 组织导入更新行版本冲突 409 REVISION_CONFLICT：重读最新版本、核对后显式重提', async ({
  page,
  baseURL,
}) => {
  await setup(page, baseURL!);
  const reads: Request[] = [];
  await page.route(`**/api/tenant/org/organizations/${id}`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    reads.push(route.request());
    return route.fulfill({ json: { ...org, revision: 2, name: '他人改过的名称' } });
  });
  const conflict = {
    code: 'REVISION_CONFLICT',
    message: '组织已被他人修改，请刷新后显式重提',
    details: { expected: 1, actual: 2, rowIndex: 1, sourceCode: 'SRC-2' },
  };
  const posts = await routeImport(page, (request) => {
    const sent = (request.postDataJSON() as { rows: typeof rows }).rows;
    if (sent[1]!.expectedRevision !== 2) return { status: 409, json: { error: conflict } };
    const results = sent.map((item) => ({ sourceCode: item.sourceCode, code: item.code, status: 'updated' }));
    return { status: 200, json: { results } };
  });
  await page.goto('/org');
  const dialog = await chooseImport(page);
  await save(page).click();
  await expect(dialog.getByText(/版本冲突/)).toBeVisible();
  await expect(save(page)).toBeDisabled();
  await dialog.getByRole('button', { name: '重读最新版本' }).click();
  await dialog.getByRole('button', { name: '已核对差异，继续编辑' }).click();
  await expect(save(page)).toBeEnabled();
  await expect(dialog.getByText('已读取 2 行')).toBeVisible();
  await save(page).click();
  await expect(page.getByRole('dialog', { name: '导入结果' })).toBeVisible();
  expect(reads).toHaveLength(1);
  expect(posts.map((request) => request.postDataJSON())).toEqual([
    { rows },
    { rows: [rows[0], { ...rows[1], expectedRevision: 2 }] },
  ]);
});

test('AC-FE-R1a-44 列设置：齿轮打开居中两栏弹窗，勾选、拖动排序、恢复默认，确定后生效', async ({ page, baseURL }) => {
  await setup(page, baseURL!);
  await page.goto('/org');
  const headers = page.locator('thead th');
  const defaults = [
    '机构ID',
    '机构名称',
    '机构全称',
    '所在城市',
    '机构类型',
    '建立日期',
    '启用日期',
    '禁用日期',
    '操作',
  ];
  await expect(headers).toHaveText(defaults.map((text) => new RegExp(`^${text}`)));
  const open = async () => {
    await page.getByRole('button', { name: '列设置' }).click();
    await page.getByText('设置显示字段', { exact: true }).click();
    return page.getByRole('dialog', { name: '设置显示字段' });
  };
  let modal = await open();
  await expect(modal.getByRole('checkbox', { name: '机构ID' })).toBeDisabled();
  await modal.getByRole('checkbox', { name: '机构简称' }).check();
  await modal.getByRole('checkbox', { name: '机构全称' }).uncheck();
  const selected = modal.getByRole('list', { name: '已选字段' });
  await selected
    .getByRole('listitem', { name: '机构简称' })
    .dragTo(selected.getByRole('listitem', { name: '所在城市' }));
  await expect(selected.getByRole('listitem')).toHaveText([
    '机构ID',
    '机构名称',
    '机构简称',
    '所在城市',
    '机构类型',
    '建立日期',
    '启用日期',
    '禁用日期',
  ]);
  await modal.getByRole('button', { name: /取\s*消/ }).click();
  await expect(headers).toHaveText(defaults.map((text) => new RegExp(`^${text}`)));
  modal = await open();
  await modal.getByRole('checkbox', { name: '机构简称' }).check();
  // 右栏固定高度：拖动可见范围内的项（新勾选的简称排在末尾）。
  await selected
    .getByRole('listitem', { name: '启用日期' })
    .dragTo(selected.getByRole('listitem', { name: '机构全称' }));
  await modal.getByRole('button', { name: /确\s*定/ }).click();
  await expect(headers).toHaveText(
    [
      '机构ID',
      '机构名称',
      '启用日期',
      '机构全称',
      '所在城市',
      '机构类型',
      '建立日期',
      '禁用日期',
      '机构简称',
      '操作',
    ].map((text) => new RegExp(`^${text}`)),
  );
  modal = await open();
  await modal.getByRole('button', { name: '恢复默认' }).click();
  await modal.getByRole('button', { name: /确\s*定/ }).click();
  await expect(headers).toHaveText(defaults.map((text) => new RegExp(`^${text}`)));
});

test('AC-FE-R1a-45 变更表单按原站字段与说明，显示顺序与虚拟组织随变更提交', async ({ page, baseURL }) => {
  await setup(page, baseURL!);
  const patches: Request[] = [];
  await page.route(`**/api/tenant/org/organizations/${id}`, (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    patches.push(route.request());
    return route.fulfill({ json: { ...org, revision: 2, displayOrder: 3, isVirtual: true } });
  });
  await page.goto('/org');
  const row = page.locator('tr[data-row-key]').first();
  await row.getByRole('button', { name: '更多' }).click();
  await page.getByRole('menuitem', { name: '变更' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('说明', { exact: true })).toBeVisible();
  await expect(dialog.getByText('变更生效日期', { exact: true })).toBeVisible();
  const labels = dialog.locator('.ant-form-item-label label');
  await expect(labels).toContainText(['名称', '简称', '编码', '显示顺序', '负责人', 'HRBP', '虚拟组织', '机构类型']);
  await dialog.getByLabel('显示顺序', { exact: true }).fill('3');
  await dialog.getByRole('radio', { name: '是' }).check();
  await save(page).click();
  await expect(dialog).toHaveCount(0);
  expect(patches.map((request) => request.postDataJSON())).toEqual([
    { effectiveDate: '2026-10-12', displayOrder: 3, isVirtual: true },
  ]);
  expect(patches[0]!.headers()['if-match']).toBe('1');
});

test('AC-FE-R1a-45 停用表单显示停用日期与被停用组织', async ({ page, baseURL }) => {
  await setup(page, baseURL!);
  await page.goto('/org');
  await page.locator('tr[data-row-key]').first().getByRole('button', { name: '更多' }).click();
  await page.getByRole('menuitem', { name: '停用' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('停用日期', { exact: true })).toBeVisible();
  await expect(dialog.getByText('停用组织', { exact: true })).toBeVisible();
  await expect(dialog.getByText('合成组织', { exact: true })).toBeVisible();
  await expect(dialog).toContainText('级联停用');
});
