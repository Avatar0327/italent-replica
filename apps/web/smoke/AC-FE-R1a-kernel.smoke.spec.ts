// F-132 第 1 段第 2 轮：组织、职务写入口接 F-123 表单内核（冲突重读保留草稿、回执按形状校验），
// 组织新建 / 新建下级与负责人展示，名称无查看权时不出名称筛选。
import type { Page, Request } from '@playwright/test';
import { test, expect, user } from './fixtures.js';

const tenant = '10000000-0000-4000-8000-000000000001';
const id = '40000000-0000-4000-8000-000000000001';
const person = '50000000-0000-4000-8000-000000000001';
const ALL = [
  'name',
  'code',
  'enabled',
  'parents',
  'remarks',
  'shortName',
  'location',
  'personInChargeId',
  'hrbpId',
  'establishedOn',
  'effectiveDate',
  'startDate',
  'stopDate',
  'layerLevel',
  'displayOrder',
  'orgId',
  'postId',
];
interface Options {
  viewable?: string[];
  create?: boolean;
}
async function setup(page: Page, baseURL: string, options: Options = {}) {
  await page.clock.setFixedTime(new Date('2026-10-12T08:00:00Z'));
  await page.context().addCookies([
    { name: 'italent_demo_tenant', value: tenant, url: baseURL },
    { name: 'italent_demo_user', value: user, url: baseURL },
  ]);
  const viewable = options.viewable ?? ALL;
  const create = options.create ?? true;
  await page.route('**/permission/me/objects/*', (route) =>
    route.fulfill({
      json: {
        objectCode: new URL(route.request().url()).pathname.split('/').at(-1),
        dataOperations: { create, update: true },
        viewableFields: viewable,
        editableFields: viewable,
        buttons: [
          ...(create ? [{ buttonCode: 'create', level: 'list' }] : []),
          { buttonCode: 'update', level: 'detail' },
        ],
      },
    }),
  );
  const org = {
    id,
    revision: 1,
    name: '合成组织',
    code: 'ORG-001',
    enabled: true,
    remarks: '原备注',
    establishedOn: '2026-01-01',
    personInChargeId: person,
    parents: { admin: { parentId: null, sequence: null } },
  };
  await page.route('**/api/tenant/org/organizations**', (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith(id) ? org : { items: [org], hasDataPermission: true },
    }),
  );
  const job = { id, revision: 1, name: '合成条目', code: 'JOB-001', enabled: true, layerLevel: 1 };
  await page.route('**/api/tenant/job/**', (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith(id) ? job : { items: [job], today: '2026-10-12' },
    }),
  );
  await page.route(`**/api/tenant/personnel/employees/${person}`, (route) =>
    route.fulfill({ json: { id: person, revision: 1, name: '合成负责人' } }),
  );
}
const save = (page: Page) => page.getByRole('dialog').getByRole('button', { name: /保\s*存/, exact: true });
const writes = (requests: Request[]) => requests.filter((request) => request.method() !== 'GET');

test('AC-FE-R1a-27 职务编辑冲突：重读最新版本保留草稿并回填未改字段，核对后只再发一条命令', async ({
  page,
  baseURL,
}) => {
  await setup(page, baseURL!);
  const requests: Request[] = [];
  let conflicted = false;
  await page.route(`**/api/tenant/job/layers/${id}**`, (route) => {
    const request = route.request();
    requests.push(request);
    const latest = { id, revision: conflicted ? 2 : 1, name: '合成条目', code: conflicted ? 'JOB-002' : 'JOB-001' };
    if (request.method() === 'GET') return route.fulfill({ json: { ...latest, enabled: true, layerLevel: 1 } });
    if (!conflicted) {
      conflicted = true;
      return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT' } } });
    }
    return route.fulfill({ json: { ...latest, revision: 3, name: '合成条目二' } });
  });
  await page.goto('/job?kind=layers');
  await page.getByRole('button', { name: '合成条目', exact: true }).click();
  await page
    .getByRole('button', { name: /编\s*辑/, exact: true })
    .last()
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('名称', { exact: true }).fill('合成条目二');
  await save(page).click();
  await expect(dialog.getByText('版本冲突：输入已保留，请重读最新版本并核对差异后重提。')).toBeVisible();
  await expect(save(page)).toBeDisabled();
  const reads = requests.filter((request) => request.method() === 'GET').length;
  await dialog.getByRole('button', { name: '重读最新版本' }).click();
  await expect.poll(() => requests.filter((request) => request.method() === 'GET').length).toBe(reads + 1);
  await expect(dialog.getByLabel('名称', { exact: true })).toHaveValue('合成条目二');
  await expect(dialog.getByLabel('编码', { exact: true })).toHaveValue('JOB-002');
  await dialog.getByRole('button', { name: '已核对差异，继续编辑' }).click();
  await save(page).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('保存成功，请刷新查看所选日期的数据。')).toBeVisible();
  const sent = writes(requests);
  expect(sent.map((request) => request.postDataJSON())).toEqual([
    { name: '合成条目二', effectiveDate: '2026-10-12' },
    { name: '合成条目二', effectiveDate: '2026-10-12' },
  ]);
  expect(sent.map((request) => request.headers()['if-match'])).toEqual(['1', '2']);
  expect(new Set(sent.map((request) => request.headers()['idempotency-key'])).size).toBe(2);
});

test('AC-FE-R1a-08 组织变更显式联动；冲突后重读、核对差异再提交，不盲重放', async ({ page, baseURL }) => {
  await setup(page, baseURL!);
  const requests: Request[] = [];
  let conflicted = false;
  await page.route(`**/api/tenant/org/organizations/${id}**`, (route) => {
    const request = route.request();
    requests.push(request);
    const latest = {
      id,
      revision: conflicted ? 2 : 1,
      name: '合成组织',
      code: 'ORG-001',
      enabled: true,
      remarks: conflicted ? '他人备注' : '原备注',
      parents: { admin: { parentId: null, sequence: null } },
    };
    if (request.method() === 'GET') return route.fulfill({ json: latest });
    if (!conflicted) {
      conflicted = true;
      return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT' } } });
    }
    return route.fulfill({ json: { ...latest, revision: 3, name: '合成组织二' } });
  });
  await page.goto('/org?tab=changes');
  await page.getByRole('button', { name: '合成组织', exact: true }).click();
  await page.getByRole('button', { name: /变\s*更/, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('机构名称').fill('合成组织二');
  await save(page).click();
  await expect(page.getByText('请选择是否新增任职')).toBeVisible();
  expect(writes(requests)).toHaveLength(0);
  await dialog.getByLabel('是否新增任职').click();
  await page.getByTitle('否', { exact: true }).click();
  await save(page).click();
  await expect(dialog.getByText('版本冲突：输入已保留，请重读最新版本并核对差异后重提。')).toBeVisible();
  await expect(save(page)).toBeDisabled();
  await dialog.getByRole('button', { name: '重读最新版本' }).click();
  await expect(dialog.getByLabel('备注')).toHaveValue('他人备注');
  await expect(dialog.getByLabel('机构名称')).toHaveValue('合成组织二');
  await dialog.getByRole('button', { name: '已核对差异，继续编辑' }).click();
  await save(page).click();
  await expect(dialog).toHaveCount(0);
  const sent = writes(requests);
  const body = { name: '合成组织二', effectiveDate: '2026-10-12', addEmployment: false };
  expect(sent.map((request) => request.postDataJSON())).toEqual([body, body]);
  expect(sent.map((request) => request.headers()['if-match'])).toEqual(['1', '2']);
});

test('AC-FE-R1a-29 组织行内入口与详情共用内核：冲突后「重读最新版本」重新读取原单', async ({ page, baseURL }) => {
  await setup(page, baseURL!);
  const requests: Request[] = [];
  await page.route(`**/api/tenant/org/organizations/${id}**`, (route) => {
    const request = route.request();
    requests.push(request);
    if (request.method() === 'GET')
      return route.fulfill({ json: { id, revision: 2, name: '合成组织', enabled: true, remarks: '他人备注' } });
    return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT' } } });
  });
  await page.goto('/org');
  const row = page.locator('tr[data-row-key]').first();
  await row.getByRole('button', { name: /更\s*多/ }).click();
  await page.getByRole('menuitem', { name: '变更' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('备注').fill('我的备注');
  await save(page).click();
  await expect(dialog.getByText('版本冲突：输入已保留，请重读最新版本并核对差异后重提。')).toBeVisible();
  await dialog.getByRole('button', { name: '重读最新版本' }).click();
  await expect.poll(() => requests.filter((request) => request.method() === 'GET').length).toBe(1);
  await expect(dialog.getByLabel('备注')).toHaveValue('我的备注');
  await expect(dialog.getByRole('button', { name: '已核对差异，继续编辑' })).toBeEnabled();
});

test('AC-FE-R1a-28 回执缺少原单 ID 时不显示成功，表单锁定待回查', async ({ page, baseURL }) => {
  await setup(page, baseURL!);
  await page.route(`**/api/tenant/job/layers/${id}`, (route) =>
    route.request().method() === 'GET' ? route.fallback() : route.fulfill({ json: {} }),
  );
  await page.route('**/api/tenant/org/organizations', (route) =>
    route.request().method() === 'POST' ? route.fulfill({ status: 201, json: {} }) : route.fallback(),
  );
  await page.goto('/job?kind=layers');
  await page.getByRole('button', { name: '合成条目', exact: true }).click();
  await page
    .getByRole('button', { name: /编\s*辑/, exact: true })
    .last()
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('名称', { exact: true }).fill('合成条目二');
  await save(page).click();
  await expect(dialog.getByText('处理中 / 结果待确认。当前表单已锁定，请勿重新创建命令。')).toBeVisible();
  await expect(save(page)).toBeDisabled();
  await expect(page.getByText(/保存成功/)).toHaveCount(0);
  await page.goto('/org');
  await page.getByRole('button', { name: /^新\s*建$/ }).click();
  await createOrganization(page);
  await expect(dialog.getByText('处理中 / 结果待确认。当前表单已锁定，请勿重新创建命令。')).toBeVisible();
  await expect(page.getByText(/保存成功/)).toHaveCount(0);
});

async function createOrganization(page: Page) {
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('机构名称').fill('合成新组织');
  await dialog.getByLabel('机构简称').fill('合成新');
  const parent = dialog
    .locator('.ant-form-item')
    .filter({ has: page.locator('label').filter({ hasText: '行政维度上级' }) })
    .getByRole('combobox');
  if (!(await dialog.getByTitle('合成组织').count())) {
    await parent.focus();
    await parent.press('ArrowDown');
    await expect(page.locator('.ant-select-dropdown:visible').getByTitle('合成组织').last()).toBeVisible();
    await parent.press('Enter');
  }
  await save(page).click();
}

test('AC-FE-R1a-30 组织新建与新建下级：按权限出入口，请求体带行政维度上级，按新建命令提交', async ({
  page,
  baseURL,
}) => {
  await setup(page, baseURL!);
  const posts: Request[] = [];
  await page.route('**/api/tenant/org/organizations', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    posts.push(route.request());
    const body = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({ status: 201, json: { id: `5${posts.length}000000-0000-4000-8000-000000000001`, ...body } });
  });
  await page.goto('/org');
  await page.getByRole('button', { name: /^新\s*建$/ }).click();
  await expect(page.getByRole('dialog').getByLabel('生效日期')).toHaveValue('2026-10-12');
  await createOrganization(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const row = page.locator('tr[data-row-key]').first();
  await row.getByRole('button', { name: '新建下级' }).click();
  await expect(page.getByRole('dialog').getByTitle('合成组织')).toBeVisible();
  await createOrganization(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const body = {
    name: '合成新组织',
    shortName: '合成新',
    establishedOn: '2026-10-12',
    parents: { admin: { parentId: id } },
  };
  expect(posts.map((request) => request.postDataJSON())).toEqual([body, body]);
  expect(posts.map((request) => request.headers()['if-match'])).toEqual(['0', '0']);
});

test('AC-FE-R1a-30 无新建权不出新建、新建下级（反向）', async ({ page, baseURL }) => {
  await setup(page, baseURL!, { create: false });
  await page.goto('/org');
  await expect(page.getByRole('button', { name: '合成组织', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^新\s*建$/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '新建下级' })).toHaveCount(0);
});

test('AC-FE-R1a-31 组织详情展示负责人姓名；无负责人查看权时不出该字段', async ({ page, baseURL }) => {
  await setup(page, baseURL!);
  await page.goto('/org');
  await page.getByRole('button', { name: '合成组织', exact: true }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText('负责人', { exact: true })).toBeVisible();
  await expect(drawer.getByText('合成负责人', { exact: true })).toBeVisible();
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await setup(page, baseURL!, { viewable: ALL.filter((field) => field !== 'personInChargeId') });
  await page.goto('/org');
  await page.getByRole('button', { name: '合成组织', exact: true }).click();
  await expect(drawer.getByText('机构ID', { exact: true })).toBeVisible();
  await expect(drawer.getByText('负责人', { exact: true })).toHaveCount(0);
});

test('AC-FE-R1a-32 职位表单基本信息含上级职位、虚线上级；详情汇报关系与职位说明按原站叫法', async ({
  page,
  baseURL,
}) => {
  await setup(page, baseURL!);
  await page.goto('/job?kind=positions');
  await page.getByRole('button', { name: /新\s*建/, exact: true }).click();
  const dialog = page.getByRole('dialog');
  const basic = dialog.locator('section').filter({ has: page.getByRole('heading', { name: '基本信息' }) });
  await expect(basic.getByText('上级职位', { exact: true })).toBeVisible();
  await expect(basic.getByText('虚线上级', { exact: true })).toBeVisible();
  await expect(dialog.getByText('直线上级', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('heading', { name: '职位汇报关系' })).toHaveCount(0);
});

test('AC-FE-R1a-34 引用对象名称被裁剪时显示不在可见范围', async ({ page, baseURL }) => {
  await setup(page, baseURL!);
  await page.route(`**/api/tenant/job/positions/${id}**`, (route) =>
    route.fulfill({ json: { id, revision: 1, name: '合成职位', orgId: id } }),
  );
  await page.route(`**/api/tenant/org/organizations/${id}**`, (route) =>
    route.fulfill({ json: { id, revision: 1 } }),
  );
  await page.goto('/job?kind=positions');
  await page.getByRole('button', { name: '合成条目', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('（不在可见范围）')).toBeVisible();
});

for (const path of ['/org', '/job?kind=posts']) {
  test(`AC-FE-R1a-33 ${path} 无名称查看权时不出名称筛选，请求不带 name`, async ({ page, baseURL }) => {
    await setup(page, baseURL!, { viewable: ALL.filter((field) => field !== 'name') });
    const queries: URL[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (/\/api\/tenant\/(org\/organizations|job\/posts)$/.test(url.pathname)) queries.push(url);
    });
    await page.goto(path);
    await expect(page.locator('tr[data-row-key]').first()).toBeVisible();
    await expect(page.locator('.page-filters .ant-input-search')).toHaveCount(0);
    await page.getByRole('button', { name: '高级筛选', exact: true }).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByRole('button', { name: /确\s*定/ })).toBeVisible();
    await expect(drawer.getByLabel('名称', { exact: true })).toHaveCount(0);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every((url) => !url.searchParams.has('name'))).toBe(true);
  });
}
