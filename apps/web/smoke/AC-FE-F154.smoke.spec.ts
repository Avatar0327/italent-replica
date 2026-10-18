import type { Page } from '@playwright/test';
import { test, expect, employee, user } from './fixtures.js';
import { orgId, otherEmployee } from './r3d2-fixtures.js';
import { mockInfo, infoId, type InfoKind } from './f154-fixtures.js';

// F-154 原有行为回归；职业发展夹具已同步 #417 / F-185 的真实可空字段。
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
  test(`AC-FE-F154-0${index + 1} ${spec.title}展示真实列表及新建字段`, async ({ page }, testInfo) => {
    await mockInfo(page);
    await page.goto('/');
    await page.getByLabel('切换演示身份').selectOption(user);
    await expect(page).toHaveURL(/\/staff$/);
    await page.goto(`/idp/${spec.path}`);
    await expect(page.getByRole('heading', { name: spec.title, exact: true })).toBeVisible();
    for (const name of spec.headers) await expect(page.getByRole('columnheader', { name, exact: true })).toBeVisible();
    await expect(page.getByText(`共${spec.count}条`, { exact: true })).toBeVisible();
    await expect(page.getByRole('table')).toContainText('合成员工甲');
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${spec.path}-list.png`) });
    for (const name of ['导入', '导出', '轮岗申请', '高级筛选'])
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: new RegExp(`^${spec.create.split('').join('\\s*')}$`) }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    for (const field of spec.fields) await expect(dialog.getByText(field, { exact: true })).toBeVisible();
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${spec.path}-form.png`) });
  });
}

async function enter(page: Page, kind: InfoKind) {
  await page.goto('/');
  await page.getByLabel('切换演示身份').selectOption(user);
  await expect(page).toHaveURL(/\/staff$/);
  await page.goto(`/idp/${kind}`);
}
async function edit(page: Page) {
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
  await expect(dialog.getByRole('group', { name: '结束时间', exact: true }).getByRole('textbox')).toHaveValue(
    '2027-06-30',
  );
  await expect(dialog.getByLabel('优势项', { exact: true })).toHaveValue('更新优势');
  await dialog.getByRole('button', { name: '已核对差异，继续编辑' }).click();
  await dialog.getByRole('button', { name: /保\s*存/ }).click();
  await expect(dialog).toBeHidden();
  expect(calls.map((c) => c.revision)).toEqual(['1', '2']);
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
  await page.getByRole('button', { name: '删除', exact: true }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: '确认删除' }).click();
  await expect(page.getByText('共6条', { exact: true })).toBeVisible();
  expect(calls[0]).toMatchObject({ method: 'DELETE', path: `/api/tenant/idp/work-shifts/${infoId}`, revision: '1' });
});

test('AC-FE-F154-09 批量删除一次确认，逐条回执保留失败项', async ({ page }) => {
  const calls = await mockInfo(page, { conflictTimes: 1 });
  await enter(page, 'work-shifts');
  await page.getByRole('checkbox').nth(1).check();
  await page.getByRole('checkbox').nth(2).check();
  await page
    .locator('.page-heading')
    .getByRole('button', { name: /删\s*除/ })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '删除所选记录' }).click();
  await expect(dialog).toContainText('重读最新版本');
  await expect(dialog).toContainText('已删除');
  await expect(page.getByText('共6条', { exact: true })).toBeVisible();
  expect(calls).toHaveLength(2);
});

for (const batch of [false, true]) {
  test(`AC-FE-F154-17 ${batch ? '批量' : '单条'}删除冲突展示实际变化，核对后才用新版本删除`, async ({ page }) => {
    const calls = await mockInfo(page, {
      conflictTimes: 1,
      fields: { 'IDP.WorkShift': { viewable: ['startDate', 'endDate'], editable: [] } },
    });
    await enter(page, 'work-shifts');
    if (batch) {
      await page.getByRole('checkbox').nth(1).check();
      await page.getByRole('checkbox').nth(2).check();
      await page
        .locator('.page-heading')
        .getByRole('button', { name: /删\s*除/ })
        .click();
    } else {
      await page.getByRole('button', { name: '删除', exact: true }).first().click();
    }
    const dialog = page.getByRole('dialog');
    const item = dialog.locator('.info-delete-item').first();
    const remove = item.getByRole('button', { name: '确认删除' });
    await dialog.getByRole('button', { name: batch ? '删除所选记录' : '确认删除' }).click();
    if (batch) await expect(dialog.getByRole('button', { name: '已删除' })).toBeVisible();
    await expect(remove).toBeDisabled();
    await item.getByRole('button', { name: '重读最新版本' }).click();
    const difference = item.getByRole('row').filter({ hasText: '结束时间' });
    await expect(difference).toContainText('2026-12-31');
    await expect(difference).toContainText('2027-06-30');
    await expect(item.getByText('字段值无变化', { exact: true })).toHaveCount(0);
    await expect(item.getByText('2026-10-01 · 2027-06-30', { exact: true })).toBeVisible();
    await expect(item.getByRole('table')).not.toContainText('姓名');
    await expect(remove).toBeDisabled();
    expect(calls).toHaveLength(batch ? 2 : 1);
    await item.getByRole('button', { name: '已核对差异，继续编辑' }).click();
    await expect(remove).toBeEnabled();
    await remove.click();
    await expect(page.getByText(`共${batch ? 5 : 6}条`, { exact: true })).toBeVisible();
    expect(calls.map((call) => call.revision)).toEqual(batch ? ['1', '1', '2'] : ['1', '2']);
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: `/api/tenant/idp/work-shifts/${infoId}` });
    expect(calls.map((call) => call.body)).toEqual(batch ? [{}, {}, {}] : [{}, {}]);
  });
}

async function choose(page: Page, field: string, value: string) {
  await page.getByRole('dialog').getByLabel(field, { exact: true }).click();
  const control = page.getByRole('dialog').getByLabel(field, { exact: true });
  const listId = await control.getAttribute('aria-controls');
  await page
    .locator('.ant-select-dropdown')
    .filter({ has: page.locator(`[id="${listId}"]`) })
    .getByText(value, { exact: true })
    .click();
}
async function setDate(page: Page, label: string, value: string) {
  const input = page.getByRole('dialog').getByRole('group', { name: label, exact: true }).getByRole('textbox');
  await input.fill(value);
  await input.press('Enter');
}
for (const spec of cases)
  test(`AC-FE-F154-11 ${spec.title}新建成功后编辑回显并提交`, async ({ page }) => {
    const calls = await mockInfo(page);
    await enter(page, spec.path as InfoKind);
    await page
      .locator('.page-heading')
      .getByRole('button', { name: new RegExp(spec.create.split('').join('\\s*')) })
      .click();
    if (spec.path === 'tutorships') {
      await choose(page, '带教人', '合成导师乙');
      await choose(page, '被带教人', '合成员工甲');
    } else await choose(page, spec.path === 'careers' ? '发展员工' : '姓名', '合成员工甲');
    await setDate(page, '开始时间', '2027-01-01');
    await setDate(page, spec.path === 'tutorships' ? '结束日期' : '结束时间', '2027-02-01');
    if (spec.path === 'work-shifts') {
      await choose(page, '轮岗部门', '合成研发部');
      await choose(page, '轮岗职位', '合成轮岗职位');
    }
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /保\s*存/ })
      .click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.getByText(`共${spec.count + 1}条`, { exact: true })).toBeVisible();
    await edit(page);
    await expect(page.getByRole('dialog')).toContainText('合成员工甲');
    await setDate(page, '开始时间', '2026-09-01');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /保\s*存/ })
      .click();
    await expect(page.getByRole('dialog')).toBeHidden();
    expect(calls.map((c) => c.method)).toEqual(['POST', 'PATCH']);
    expect(calls.map((c) => c.revision)).toEqual(['0', '1']);
    expect(calls[1]!.body).toEqual({ startDate: '2026-09-01' });
    for (const key of ['careerLineId', 'currentLevelId', 'currentPositionId', 'currentPostId', 'currentPostName'])
      expect(calls[0]!.body).not.toHaveProperty(key);
    if (spec.path === 'careers')
      expect(calls[0]!.body).toMatchObject({ targetProfessionalLineId: null, targetLevelId: null, targetPostId: null });
  });

test('AC-FE-F154-12 人员只读仍回显姓名，只提交可编辑字段', async ({ page }) => {
  const calls = await mockInfo(page, {
    fields: {
      'IDP.Career': {
        viewable: ['employeeId', 'startDate', 'endDate', 'strengths'],
        editable: ['strengths'],
      },
    },
  });
  await enter(page, 'careers');
  await edit(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('合成员工甲');
  await expect(dialog).not.toContainText(employee);
  await dialog.getByLabel('优势项', { exact: true }).fill('仅修改可编辑字段');
  await dialog.getByRole('button', { name: /保\s*存/ }).click();
  await expect(dialog).toBeHidden();
  expect(calls[0]!.body).toEqual({ strengths: '仅修改可编辑字段' });
});

test('AC-FE-F154-13 写入成功后重读 403 仍锁定，不把写入误判为拒绝', async ({ page }) => {
  const calls = await mockInfo(page);
  await page.route(`**/api/tenant/idp/careers/${infoId}`, (route) =>
    route.request().method() === 'GET' && calls.length
      ? route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN' } } })
      : route.fallback(),
  );
  await enter(page, 'careers');
  await edit(page);
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('优势项', { exact: true }).fill('保存后读权限变化');
  await dialog.getByRole('button', { name: /保\s*存/ }).click();
  await expect(dialog).toContainText('结果待确认');
  await expect(dialog.getByRole('button', { name: /保\s*存/ })).toBeDisabled();
  expect(calls).toHaveLength(1);
});

test('AC-FE-F154-14 新建结果未知换页重开仍使用集合恢复槽', async ({ page }) => {
  const calls = await mockInfo(page, { writeStatus: 503 });
  await enter(page, 'careers');
  await page
    .locator('.page-heading')
    .getByRole('button', { name: /新\s*建/ })
    .click();
  await choose(page, '发展员工', '合成员工甲');
  await setDate(page, '开始时间', '2027-01-01');
  await setDate(page, '结束时间', '2027-02-01');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /保\s*存/ })
    .click();
  await expect(page.getByRole('dialog')).toContainText('待确认');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /取\s*消/ })
    .click();
  await page.getByRole('menuitem', { name: '轮岗信息', exact: true }).click();
  await page.getByRole('menuitem', { name: '职业发展信息', exact: true }).click();
  await page
    .locator('.page-heading')
    .getByRole('button', { name: /新\s*建/ })
    .click();
  await expect(page.getByRole('dialog')).toContainText('待确认');
  await expect(page.getByRole('dialog').getByRole('button', { name: /保\s*存/ })).toHaveCount(0);
  expect(calls).toHaveLength(1);
});

test('AC-FE-F154-15 写入成功到后续读取完成一直锁定', async ({ page }) => {
  const calls = await mockInfo(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reading = false;
  await page.route(`**/api/tenant/idp/careers/${infoId}`, async (route) => {
    if (route.request().method() === 'GET' && calls.length) {
      reading = true;
      await gate;
    }
    await route.fallback();
  });
  await enter(page, 'careers');
  await edit(page);
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('优势项', { exact: true }).fill('等待回查');
  await dialog.getByRole('button', { name: /保\s*存/ }).click();
  await expect.poll(() => reading).toBe(true);
  try {
    await expect(dialog.getByRole('button', { name: /保\s*存/ })).toBeDisabled();
    await expect(dialog.getByLabel('优势项', { exact: true })).toBeDisabled();
    expect(calls).toHaveLength(1);
  } finally {
    release();
  }
  await expect(dialog).toBeHidden();
});

test('AC-FE-F154-16 可见值筛选生效，缺必填字段编辑权不开放新建', async ({ page }) => {
  await mockInfo(page);
  await enter(page, 'tutorships');
  await expect(page.getByRole('combobox', { name: '开始时间', exact: true })).toBeEnabled();
  await page.getByRole('combobox', { name: '开始时间', exact: true }).click();
  await page
    .locator('.ant-select-dropdown:visible .ant-select-item-option-content')
    .filter({ hasText: /^2026-10-01$/ })
    .click();
  await expect(page.getByText('共1条', { exact: true })).toBeVisible();
  await mockInfo(page, {
    fields: {
      'IDP.Career': {
        viewable: ['startDate', 'endDate', 'strengths'],
        editable: ['strengths'],
      },
    },
  });
  await page.goto('/idp/careers');
  await expect(page.locator('.page-heading').getByRole('button', { name: /新\s*建/ })).toBeDisabled();
});
