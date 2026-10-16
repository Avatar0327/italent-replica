import { test, expect, employee, user } from './fixtures.js';
import { orgId, otherEmployee } from './r3d2-fixtures.js';
import { mockInfo, infoId, type InfoKind } from './f154-fixtures.js';

// F-154 首批行为红测。夹具仅含现有 key-info-routes 的真实投影字段，
// 不伪造尚未落库的职业发展条线 / 拟晋升职级 / 拟晋升职务。
// DEC-543：三项缺后端契约字段后补 F-185（取证 #355），本片不渲染。
const span = { startDate: '2026-10-01', endDate: '2026-12-31', revision: 1, createdBy: user };
const cases = [
  {
    path: 'tutorships',
    title: '带教信息',
    create: '新增',
    count: 5,
    fields: ['带教人', '被带教人', '开始时间', '结束日期'],
    row: { ...span, tutorEmployeeId: otherEmployee, tuteeEmployeeId: employee, remark: null },
    headers: ['带教人', '带教人邮箱', '带教人部门', '被带教人', '被带教人邮件', '被带教人部门', '开始时间', '结束日期'],
  },
  {
    path: 'careers',
    title: '职业发展信息',
    create: '新建',
    count: 4,
    fields: ['发展员工', '开始时间', '结束时间', '优势项', '待发展项', '拟晋升职位'],
    row: {
      ...span,
      employeeId: employee,
      targetPositionId: null,
      strengths: null,
      developmentItems: null,
      intendedCity: null,
    },
    headers: [
      '发展员工',
      '开始时间',
      '结束时间',
      '优势项',
      '待发展项',
      '当前职级',

      '当前职位',
      '拟晋升职位',
      '当前职务',
    ],
  },
  {
    path: 'work-shifts',
    title: '轮岗信息',
    create: '新建',
    count: 7,
    fields: ['姓名', '开始时间', '结束时间', '轮岗部门', '轮岗职位', '轮岗导师'],
    row: { ...span, employeeId: employee, orgId, positionId: null, postId: null, mentorEmployeeId: null },
    headers: ['姓名', '邮箱', '部门', '开始时间', '结束时间', '轮岗部门', '轮岗职位', '轮岗导师'],
  },
];

test.use({ viewport: { width: 1440, height: 900 } });
for (const [index, spec] of cases.entries()) {
  test(`AC-FE-F154-0${index + 1} ${spec.title}展示真实列表及新建字段`, async ({ page }) => {
    await mockInfo(page);
    await page.goto('/');
    await page.getByLabel('切换演示身份').selectOption(user);
    await expect(page).toHaveURL(/\/staff$/);
    await page.goto(`/idp/${spec.path}`);
    await expect(page.getByRole('heading', { name: spec.title, exact: true })).toBeVisible();
    for (const name of spec.headers) await expect(page.getByRole('columnheader', { name, exact: true })).toBeVisible();
    await expect(page.getByText(`共${spec.count}条`, { exact: true })).toBeVisible();
    for (const name of ['导入', '导出', '轮岗申请', '高级筛选'])
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: new RegExp(`^${spec.create.split('').join('\\s*')}$`) }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    for (const field of spec.fields) await expect(dialog.getByText(field, { exact: true })).toBeVisible();
  });
}

async function enter(page: import('@playwright/test').Page, kind: InfoKind) {
  await page.goto('/');
  await page.getByLabel('切换演示身份').selectOption(user);
  await expect(page).toHaveURL(/\/staff$/);
  await page.goto(`/idp/${kind}`);
}
async function edit(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: '编辑', exact: true }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

test('AC-FE-F154-04 职业发展编辑回显、冲突重读保留改动并回填未改日期', async ({ page }) => {
  const calls = await mockInfo(page, { conflictTimes: 1 });
  await enter(page, 'careers');
  await edit(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('合成员工甲');
  await dialog.getByLabel('优势项', { exact: true }).fill('更新优势');
  await dialog.getByRole('button', { name: /保\s*存/ }).click();
  await dialog.getByRole('button', { name: '重读最新版本' }).click();
  await expect(dialog.getByLabel('结束时间', { exact: true })).toHaveValue('2027-06-30');
  await expect(dialog.getByLabel('优势项', { exact: true })).toHaveValue('更新优势');
  await dialog.getByRole('button', { name: '已核对差异，继续编辑' }).click();
  await dialog.getByRole('button', { name: /保\s*存/ }).click();
  await expect(dialog).toBeHidden();
  expect(calls.map((c) => c.revision)).toEqual(['"1"', '"2"']);
  expect(calls[1]!.body).toEqual({ strengths: '更新优势' });
});

for (const invalidReceipt of [false, true])
  test(`AC-FE-F154-05 ${invalidReceipt ? '错误回执' : '服务端异常'}关闭换页重开仍锁定`, async ({ page }) => {
    const calls = await mockInfo(page, invalidReceipt ? { invalidReceipt } : { writeStatus: 503 });
    await enter(page, 'careers');
    await edit(page);
    await page.getByRole('dialog').getByLabel('优势项', { exact: true }).fill('未确认改动');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /保\s*存/ })
      .click();
    await expect(page.getByRole('dialog')).toContainText('结果待确认');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /取\s*消/ })
      .click();
    // SPA 菜单换页，不重载浏览器；模块存储必须继续锁定。
    await page.getByRole('menuitem', { name: '轮岗信息', exact: true }).click();
    await page.getByRole('menuitem', { name: '职业发展信息', exact: true }).click();
    await edit(page);
    await expect(page.getByRole('dialog').getByRole('button', { name: /保\s*存/ })).toBeDisabled();
    expect(calls).toHaveLength(1);
  });

test('AC-FE-F154-06 无对象更新权不能靠按钮提交，裁剪员工仍保留记录', async ({ page }) => {
  await mockInfo(page, {
    operations: { 'IDP.Career': { create: false, update: false, delete: false } },
    fields: { 'IDP.Career': { viewable: ['startDate', 'endDate', 'strengths'], editable: ['strengths'] } },
  });
  await enter(page, 'careers');
  await expect(page.getByText('共4条', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '编辑', exact: true }).first()).toBeDisabled();
  await expect(page.getByRole('combobox', { name: '发展员工', exact: true })).toHaveCount(0);
});

test('AC-FE-F154-07 人员读取失败显示局部错误并重读', async ({ page }) => {
  await mockInfo(page, { personError: true });
  await enter(page, 'tutorships');
  await expect(page.getByText('共5条', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '重读关联信息' })).toBeVisible();
});

test('AC-FE-F154-08 行删除回执沿用原 revision，刷新列表', async ({ page }) => {
  const calls = await mockInfo(page);
  await enter(page, 'work-shifts');
  await page.getByRole('button', { name: '删除', exact: true }).nth(1).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认删除' }).click();
  await expect(page.getByText('共6条', { exact: true })).toBeVisible();
  expect(calls[0]).toMatchObject({ method: 'DELETE', path: `/api/tenant/idp/work-shifts/${infoId}`, revision: '"1"' });
});
