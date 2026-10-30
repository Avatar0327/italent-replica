// F-329（DEC-705）：员工档案三类编辑入口。接口全是合成桩，回执形态按后端：
// 人员 PATCH 回整份人员 DTO（revision + 1）；子集 POST / PATCH / DELETE 回整行（删除带 deleted: true）；
// 任职 PATCH /records/:id 回任职业务 DTO（id 为记录 id、revision + 1）。
import type { Page } from '@playwright/test';
import { actionButton } from './action-button.js';
import { capture, item, named, save, type Write } from './contracts-fixtures.js';
import { test, expect, user, employee } from './fixtures.js';

const recordId = '60000000-0000-4000-8000-000000000001';
const educationId = '60000000-0000-4000-8000-000000000002';
const personFields = [
  'id',
  'name',
  'email',
  'workDate',
  'idType',
  'idNumber',
  'birthday',
  'gender',
  'mobilePhone',
  'code',
  'entryDate',
  'employeeStatus',
  'expectedRetirementDate',
  'expectedRetirementConfirmed',
  'dailyWageStandard',
];
const educationFields = ['id', 'school', 'major', 'startDate', 'endDate', 'isHighestEducation'];
const recordFields = ['id', 'revision', 'status', 'kind', 'effectiveDate', 'stopDate', 'isCurrent', 'place', 'remarks'];
const permissions: Record<string, unknown> = {
  'TenantBase.EmployeeInformation': {
    dataOperations: { view: true, update: true },
    viewableFields: personFields,
    // 授了日工资标准的编辑权，表单也不出现（DEC-705）
    editableFields: personFields.filter((name) => !['id', 'code', 'entryDate', 'employeeStatus'].includes(name)),
    buttons: [{ buttonCode: 'update', level: 'detail' }],
  },
  'TenantBase.Education': {
    dataOperations: { view: true, create: true, update: true, delete: true },
    viewableFields: educationFields,
    editableFields: educationFields.slice(1),
    buttons: [
      { buttonCode: 'create', level: 'list' },
      { buttonCode: 'update', level: 'detail' },
      { buttonCode: 'delete', level: 'detail' },
    ],
  },
  'TenantBase.EmploymentRecord': {
    dataOperations: { view: true, update: true },
    viewableFields: recordFields,
    editableFields: ['place', 'remarks'],
    buttons: [{ buttonCode: 'Employment.Edit', level: 'detail' }],
  },
};
type Reply = { status: number; json: unknown } | 'abort';
type Route = Parameters<Parameters<Page['route']>[1]>[0];
const stale = { status: 409, json: { error: { code: 'REVISION_CONFLICT', message: '版本冲突' } } };

function seed() {
  const person = {
    id: employee,
    name: '合成林晓',
    email: 'lin@example.com',
    code: 'DEMO-001',
    gender: '女',
    entryDate: '2024-01-01',
    employeeStatus: 3,
    mobilePhone: null as string | null,
    dailyWageStandard: '300.00',
    revision: 1,
  };
  const education = [{ id: educationId, school: '合成示例大学', major: '合成专业', revision: 1 }];
  const record = {
    id: recordId,
    employeeId: employee,
    revision: 3,
    status: 'effective',
    kind: 'hire',
    effectiveDate: '2024-01-01',
    stopDate: '9999-12-31',
    isCurrent: true,
    fields: { place: '合成城市', remarks: null as string | null },
  };
  return { person, education, record, writes: [] as Write[], next: [] as Reply[] };
}
type Server = ReturnType<typeof seed>;

/** 记下写请求；排队的应答（409 / 断连）优先，否则按服务端状态应答。 */
function answer(server: Server, route: Route, fallback: (write: Write) => Reply) {
  capture(server.writes, route.request());
  const result = server.next.shift() ?? fallback(server.writes.at(-1)!);
  return result === 'abort' ? route.abort('connectionreset') : route.fulfill(result);
}

async function personRoutes(page: Page, server: Server) {
  const { person } = server;
  await page.route('**/personnel/employees?*', (route) =>
    route.fulfill({
      json: { items: [{ id: employee, name: person.name, code: person.code }], hasDataPermission: true },
    }),
  );
  await page.route(`**/personnel/employees/${employee}`, (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { ...person } });
    return answer(server, route, (write) => {
      if (write.revision !== String(person.revision)) return stale;
      Object.assign(person, write.body, { revision: person.revision + 1 });
      return { status: 200, json: { ...person } };
    });
  });
}

function subsetWrite(server: Server, method: string, id: string | undefined, write: Write): Reply {
  const { education } = server;
  if (method === 'POST') {
    const row = { id: '60000000-0000-4000-8000-000000000003', ...(write.body as object), revision: 1 };
    education.push(row as (typeof education)[number]);
    return { status: 201, json: row };
  }
  const index = education.findIndex((entry) => entry.id === id);
  const row = education[index]!;
  if (write.revision !== String(row.revision)) return stale;
  const next = { ...row, ...(write.body as object), revision: row.revision + 1 };
  if (method === 'DELETE') {
    education.splice(index, 1);
    return { status: 200, json: { ...next, deleted: true } };
  }
  education[index] = next;
  return { status: 200, json: next };
}

async function subsetRoutes(page: Page, server: Server) {
  await page.route(`**/personnel/employees/${employee}/subsets/**`, (route) => {
    const request = route.request();
    const [kind, id] = new URL(request.url()).pathname.split('/subsets/')[1]!.split('/');
    const rows = kind === 'education' ? server.education : [];
    if (request.method() !== 'GET')
      return answer(server, route, (write) => subsetWrite(server, request.method(), id, write));
    if (!id) return route.fulfill({ json: { items: rows.map((row) => ({ ...row })) } });
    const row = rows.find((entry) => entry.id === id);
    return row ? route.fulfill({ json: { ...row } }) : route.fulfill({ status: 404, json: { error: {} } });
  });
}

async function recordRoutes(page: Page, server: Server) {
  const { record } = server;
  await page.route('**/employment/employees/*/records?*', (route) =>
    route.fulfill({ json: { items: [structuredClone(record)] } }),
  );
  await page.route(`**/employment/records/${recordId}`, (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: structuredClone(record) });
    return answer(server, route, (write) => {
      if (write.revision !== String(record.revision)) return stale;
      Object.assign(record.fields, (write.body as { fields: object }).fields);
      record.revision += 1;
      return { status: 200, json: structuredClone(record) };
    });
  });
}

async function setup(page: Page, grants = permissions) {
  const server = seed();
  await page.route('**/permission/me/objects/*', (route) => {
    const code = decodeURIComponent(route.request().url().split('/').at(-1)!);
    const granted = grants[code];
    return granted ? route.fulfill({ json: { objectCode: code, ...granted } }) : route.fallback();
  });
  await personRoutes(page, server);
  await subsetRoutes(page, server);
  await recordRoutes(page, server);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/staff');
  await page.getByLabel('切换演示身份').selectOption(user);
  await expect(page.getByRole('button', { name: '合成林晓', exact: true })).toBeVisible();
  return server;
}
const personPath = `/api/tenant/personnel/employees/${employee}`;
const drawer = (page: Page) => page.getByRole('dialog', { name: '编辑人员', exact: true });
const brief = (writes: Write[]) => writes.map(({ method, path, revision, body }) => [method, path, revision, body]);

test('AC-FE-F329-01 列表行与抬头「编辑人员」：两节整表、只提交改动字段，日工资标准不出现', async ({ page }) => {
  const server = await setup(page);
  await page
    .getByRole('row', { name: /合成林晓/ })
    .getByRole('button', named('编辑人员'))
    .click();
  const form = drawer(page);
  await expect(form.getByText('员工信息', { exact: true })).toBeVisible();
  await expect(form.getByText('任职信息', { exact: true })).toBeVisible();
  await expect(form).not.toContainText('日工资标准');
  // 工号、入职日期不是人员对象可写字段：只读显示
  await expect(item(form, '工号')).toContainText('DEMO-001');
  await expect(item(form, '工号').getByRole('textbox')).toHaveCount(0);
  await item(form, '手机号码').getByRole('textbox').fill('00000000000');
  await form.getByRole('button', save).click();
  await expect(form).toHaveCount(0);

  await page.getByRole('button', { name: '合成林晓', exact: true }).click();
  const detail = page.getByRole('dialog', { name: '员工档案', exact: true });
  await expect(detail.getByRole('tab', { name: '人员信息', exact: true })).toBeVisible();
  await expect(detail).not.toContainText('日工资标准');
  await expect(detail).not.toContainText('300.00');
  await detail.getByRole('button', named('编辑人员')).click();
  await expect(item(drawer(page), '手机号码').getByRole('textbox')).toHaveValue('00000000000');
  await item(drawer(page), '员工姓名').getByRole('textbox').fill('合成林晓改');
  await drawer(page).getByRole('button', save).click();
  await expect(drawer(page)).toHaveCount(0);
  await expect(detail.getByRole('heading', { name: '合成林晓改' })).toBeVisible();
  expect(brief(server.writes)).toEqual([
    ['PATCH', personPath, '1', { mobilePhone: '00000000000' }],
    ['PATCH', personPath, '2', { name: '合成林晓改' }],
  ]);
});

test('AC-FE-F329-02 「编辑人员」409 重读后按新版本重提；结果未知关闭重开仍锁定', async ({ page }) => {
  const server = await setup(page);
  await page
    .getByRole('row', { name: /合成林晓/ })
    .getByRole('button', named('编辑人员'))
    .click();
  await item(drawer(page), '手机号码').getByRole('textbox').fill('00000000001');
  // 别人先改了邮箱：服务端版本前进到 2
  Object.assign(server.person, { email: 'other@example.com', revision: 2 });
  await drawer(page).getByRole('button', save).click();
  await expect(drawer(page).getByText('版本冲突', { exact: false })).toBeVisible();
  await actionButton(drawer(page), '重读最新版本').click();
  await drawer(page).getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
  await expect(item(drawer(page), '手机号码').getByRole('textbox')).toHaveValue('00000000001');
  await drawer(page).getByRole('button', save).click();
  await expect(drawer(page)).toHaveCount(0);
  expect(server.person).toMatchObject({ email: 'other@example.com', mobilePhone: '00000000001', revision: 3 });

  server.next.push('abort');
  await page
    .getByRole('row', { name: /合成林晓/ })
    .getByRole('button', named('编辑人员'))
    .click();
  await item(drawer(page), '证件类型').getByRole('textbox').fill('合成证件');
  await drawer(page).getByRole('button', save).click();
  await expect(drawer(page).getByText('结果待确认', { exact: false })).toBeVisible();
  await drawer(page).getByRole('button', named('取消')).click();
  await page
    .getByRole('row', { name: /合成林晓/ })
    .getByRole('button', named('编辑人员'))
    .click();
  await expect(drawer(page).getByText('结果待确认', { exact: false })).toBeVisible();
  await expect(drawer(page).getByRole('button', save)).toBeDisabled();
  expect(brief(server.writes).map(([method, , revision, body]) => [method, revision, body])).toEqual([
    ['PATCH', '1', { mobilePhone: '00000000001' }],
    ['PATCH', '2', { mobilePhone: '00000000001' }],
    ['PATCH', '3', { idType: '合成证件' }],
  ]);
});

test('AC-FE-F329-03 子集逐条新增 / 编辑 / 删除，任职记录「编辑任职」只提交 fields 补丁', async ({ page }) => {
  const server = await setup(page);
  await page.getByRole('button', { name: '合成林晓', exact: true }).click();
  const section = page.getByRole('region', { name: '教育经历' });
  await expect(section).toContainText('合成示例大学');
  await section.getByRole('button', named('新增')).click();
  const create = page.getByRole('dialog', { name: '新增教育经历', exact: true });
  await item(create, '学校').getByRole('textbox').fill('合成第二大学');
  await create.getByRole('button', save).click();
  await expect(create).toHaveCount(0);
  await expect(section).toContainText('合成第二大学');

  const first = section.locator('.staff-subset-row').filter({ hasText: '合成示例大学' });
  await first.getByRole('button', named('编辑')).click();
  const update = page.getByRole('dialog', { name: '编辑教育经历', exact: true });
  await expect(item(update, '专业').getByRole('textbox')).toHaveValue('合成专业');
  await item(update, '专业').getByRole('textbox').fill('合成新专业');
  await update.getByRole('button', save).click();
  await expect(update).toHaveCount(0);
  await expect(section).toContainText('合成新专业');

  await section
    .locator('.staff-subset-row')
    .filter({ hasText: '合成第二大学' })
    .getByRole('button', named('删除'))
    .click();
  await page.getByRole('tooltip').getByRole('button', named('确定')).click();
  await expect(section).not.toContainText('合成第二大学');

  await page.getByRole('tab', { name: '任职记录', exact: true }).click();
  await page.getByRole('button', named('编辑任职')).click();
  const job = page.getByRole('dialog', { name: '编辑任职', exact: true });
  await expect(item(job, '工作地点').getByRole('textbox')).toHaveValue('合成城市');
  await item(job, '备注').getByRole('textbox').fill('合成备注');
  await job.getByRole('button', save).click();
  await expect(job).toHaveCount(0);

  const base = `${personPath}/subsets/education`;
  expect(brief(server.writes)).toEqual([
    ['POST', base, '0', { school: '合成第二大学' }],
    ['PATCH', `${base}/${educationId}`, '1', { major: '合成新专业' }],
    ['DELETE', `${base}/60000000-0000-4000-8000-000000000003`, '1', {}],
    ['PATCH', `/api/tenant/employment/records/${recordId}`, '3', { fields: { remarks: '合成备注' } }],
  ]);
});

test('AC-FE-F329-04 无修改权限时三类入口都不显示', async ({ page }) => {
  const readOnly = Object.fromEntries(
    Object.entries(permissions).map(([code, granted]) => [
      code,
      { ...(granted as object), editableFields: [], buttons: [] },
    ]),
  );
  await setup(page, readOnly);
  await expect(page.getByRole('button', named('编辑人员'))).toHaveCount(0);
  await page.getByRole('button', { name: '合成林晓', exact: true }).click();
  const section = page.getByRole('region', { name: '教育经历' });
  await expect(section).toContainText('合成示例大学');
  await expect(page.getByRole('button', named('编辑人员'))).toHaveCount(0);
  await expect(section.getByRole('button', named('新增'))).toHaveCount(0);
  await expect(section.getByRole('button', named('编辑'))).toHaveCount(0);
  await expect(section.getByRole('button', named('删除'))).toHaveCount(0);
  await page.getByRole('tab', { name: '任职记录', exact: true }).click();
  await expect(page.getByText('生效中', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', named('编辑任职'))).toHaveCount(0);
});
