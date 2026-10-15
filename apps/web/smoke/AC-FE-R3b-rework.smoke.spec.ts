import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { ev, id, setupR3b } from './r3b-fixtures.js';

test.setTimeout(90_000);

async function editEvaluation(page: Page, overrides: Record<string, unknown>) {
  await setupR3b(page, '/evaluation');
  await page.route(`**/evaluation/activities/${id}`, (route) => route.fulfill({ json: { ...ev, ...overrides } }));
  await page.getByRole('button', { name: ev.name, exact: true }).click();
  await page.getByRole('button', { name: /编\s*辑/, exact: true }).click();
  return page.getByRole('dialog', { name: '编辑', exact: true });
}

const saveButton = { name: /保\s*存/, exact: true };
const cancelButton = { name: /取\s*消/, exact: true };

test('AC-FE-R3b-R2-01 360 结果未知关闭重开及切换页签不能生成第二个创建命令', async ({ page }) => {
  await setupR3b(page, '/survey360');
  const commands: string[] = [];
  await page.route('**/survey360/activities', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    commands.push(route.request().headers()['idempotency-key']!);
    return route.fulfill({ status: 503, json: { error: { code: 'RESULT_UNKNOWN' } } });
  });
  await page.getByRole('button', { name: '新增活动', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新增活动', exact: true });
  await form.getByLabel('名称', { exact: true }).fill('合成未确认活动');
  await form.getByRole('button', saveButton).click();
  await expect(form.getByRole('alert')).toBeVisible();
  await form.getByRole('button', cancelButton).click();
  await page.getByRole('tab', { name: '套卷', exact: true }).click();
  await page.getByRole('tab', { name: '评估活动', exact: true }).click();
  await page.getByRole('button', { name: '新增活动', exact: true }).click();
  await expect(form).toContainText('结果待确认');
  await expect(form).toContainText('合成未确认活动');
  await expect(form).toContainText(commands[0]!);
  await expect(form.getByRole('button', saveButton)).toHaveCount(0);
  await expect(form.locator('input:not([disabled])')).toHaveCount(0);
  expect(commands).toHaveLength(1);
});

test('AC-FE-R3b-R2-02 数值条件阻止反向范围，合法修改仍以数值提交', async ({ page }) => {
  const form = await editEvaluation(page, {
    conditions: [
      {
        kind: 'common',
        applicantKind: 'self',
        expression: null,
        details: [{ seq: 1, source: 'employee', field: 'age', operator: 'between', value1: 2, value2: 10 }],
      },
    ],
  });
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'PATCH') writes++;
  });
  await form.getByRole('button', { name: '下一步' }).click();
  await form.getByLabel('值', { exact: true }).fill('20');
  await form.getByRole('button', { name: '下一步' }).click();
  await form.getByRole('button', saveButton).click();
  await expect(form.getByRole('alert')).toContainText('开始值不能大于结束值');
  expect(writes).toBe(0);
  await form.getByRole('button', { name: '上一步' }).click();
  await form.getByLabel('值', { exact: true }).fill('3');
  await form.getByRole('button', { name: '下一步' }).click();
  const request = page.waitForRequest((r) => r.method() === 'PATCH');
  await form.getByRole('button', saveButton).click();
  const body = (await request).postDataJSON();
  expect(body.conditions[0].details[0]).toMatchObject({ value1: 3, value2: 10 });
});

test('AC-FE-R3b-R2-03 新选组织默认包含下级并提交，允许取消', async ({ page }) => {
  const form = await editEvaluation(page, { orgRange: [] });
  await page.route('**/org/organizations?*', (route) => route.fulfill({ json: { items: [{ id, name: '合成集团' }] } }));
  // 候选请求已在表单打开时发出，重新打开以读取合成组织。
  await form.getByRole('button', cancelButton).click();
  await page.getByRole('button', { name: /编\s*辑/, exact: true }).click();
  const range = form.locator('.ant-form-item').filter({ has: page.locator('label[title="组织范围"]') });
  await range.getByRole('combobox').click();
  await page.locator('.ant-select-item-option[title="合成集团"]').click();
  await page.keyboard.press('Escape');
  const descendants = range.getByRole('checkbox', { name: /包含下级/ });
  await expect(descendants).toBeChecked();
  await descendants.uncheck();
  await expect(descendants).not.toBeChecked();
  await descendants.check();
  await form.getByRole('button', { name: '下一步' }).click();
  await form.getByRole('button', { name: '下一步' }).click();
  const request = page.waitForRequest((r) => r.method() === 'PATCH');
  await form.getByRole('button', saveButton).click();
  expect((await request).postDataJSON().orgRange).toEqual([{ orgId: id, includeDescendants: true }]);
});

test('AC-FE-R3b-F134 申请人类型勾选在点击事件内同步生效，同一帧连续点击不丢操作', async ({ page }) => {
  const form = await editEvaluation(page, { applicants: ['self'] });
  const self = form.getByRole('checkbox', { name: '员工本人', exact: true });
  const others = form.getByRole('checkbox', { name: '非员工本人', exact: true });
  await expect(self).toBeChecked();
  await expect(others).not.toBeChecked();
  // 同一个任务里连点两项、立刻读状态：不能等到下一轮调度才反映，也不能用旧状态覆盖前一次点击。
  const states = await page.evaluate(() => {
    const input = (value: string) =>
      document.querySelector<HTMLInputElement>(`input[type="checkbox"][value="${value}"]`)!;
    input('self').click();
    const afterFirst = input('self').checked;
    input('others').click();
    return { afterFirst, self: input('self').checked, others: input('others').checked };
  });
  expect(states).toEqual({ afterFirst: false, self: false, others: true });
  await form.getByRole('button', { name: '下一步' }).click();
  await form.getByRole('button', { name: '下一步' }).click();
  const request = page.waitForRequest((r) => r.method() === 'PATCH');
  await form.getByRole('button', saveButton).click();
  expect((await request).postDataJSON()).toEqual({ applicants: ['others'] });
});

test('AC-FE-R3b-R2-04 已有报名锁申请级别等后端锁定字段，可跨级数仍允许修改', async ({ page }) => {
  const form = await editEvaluation(page, { applyCount: 1 });
  for (const label of ['活动类型', '组织范围', '申请类别', '申请级别', '评定生效日期', '活动通知范围']) {
    const item = form.locator('.ant-form-item').filter({ has: page.locator(`label[title="${label}"]`) });
    await expect(item.locator('input:not([disabled])')).toHaveCount(0);
  }
  const jump = form.locator('.ant-form-item').filter({ has: page.locator('label[title="可跨级数"]') });
  await expect(jump.getByRole('spinbutton')).toBeEnabled();
  await jump.getByRole('spinbutton').fill('2');
  await form.getByLabel('名称', { exact: true }).fill('合成报名后改名');
  await form.getByRole('button', { name: '下一步' }).click();
  await form.getByRole('button', { name: '下一步' }).click();
  await expect(form.getByRole('button', { name: '添加', exact: true })).toHaveCount(0);
  await expect(form.getByRole('button', { name: '移除', exact: true })).toHaveCount(0);
  await expect(form.getByRole('checkbox', { name: '强控报名截止' })).toBeDisabled();
  const request = page.waitForRequest((r) => r.method() === 'PATCH');
  await form.getByRole('button', saveButton).click();
  expect((await request).postDataJSON()).toEqual({ name: '合成报名后改名', maxLevelJump: 2 });
});

for (const entry of [
  { tab: '套卷', title: '新建套卷', path: 'questionnaires' },
  { tab: '题库 · 企业自定义', title: '新增套卷模板', path: 'questionnaire-templates' },
]) {
  test(`AC-FE-R3b-R2-01 ${entry.title} 共用结果未知保护`, async ({ page }) => {
    await setupR3b(page, '/survey360');
    let writes = 0;
    await page.route(`**/survey360/${entry.path}`, (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      writes++;
      return route.fulfill({ status: 503, json: { error: { code: 'RESULT_UNKNOWN' } } });
    });
    await page.getByRole('tab', { name: entry.tab, exact: true }).click();
    await page.getByRole('button', { name: entry.title, exact: true }).click();
    const form = page.getByRole('dialog', { name: entry.title, exact: true });
    await form.getByLabel('名称', { exact: true }).fill('合成未确认套卷');
    await form.getByRole('button', saveButton).click();
    await expect(form).toContainText('结果待确认');
    await form.getByRole('button', cancelButton).click();
    // 套卷从活动详情再次进入，与独立套卷页共用同一个页面状态。
    if (entry.path === 'questionnaires') {
      await page.getByRole('tab', { name: '评估活动', exact: true }).click();
      await page.getByRole('button', { name: '合成领导力评估', exact: true }).click();
      await page.getByRole('dialog').getByRole('tab', { name: '套卷', exact: true }).click();
    }
    await page.getByRole('button', { name: entry.title, exact: true }).click();
    await expect(form).toContainText('结果待确认');
    await expect(form.getByRole('button', saveButton)).toHaveCount(0);
    expect(writes).toBe(1);
  });
}

for (const appraiser of [false, true]) {
  test(`AC-FE-R3b-R2-01 ${appraiser ? '评价者' : '评价对象'} 关闭详情重开仍保护原命令`, async ({ page }) => {
    await setupR3b(page, '/survey360');
    const path = `/activities/${id}/objects${appraiser ? `/${id}/appraisers` : ''}`;
    let writes = 0;
    await page.route(`**/survey360${path}`, (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      writes++;
      return route.fulfill({ status: 503, json: { error: { code: 'RESULT_UNKNOWN' } } });
    });
    const title = appraiser ? '添加评价者' : '添加评价对象';
    const open = async () => {
      await page.getByRole('button', { name: '合成领导力评估', exact: true }).click();
      await page.getByRole('dialog').getByRole('tab', { name: '评价关系', exact: true }).click();
      if (appraiser) await page.getByRole('button', { name: '设置评价者', exact: true }).click();
      await page.getByRole('button', { name: title, exact: true }).click();
    };
    await open();
    const form = page.getByRole('dialog', { name: title, exact: true });
    for (const [label, candidate] of [
      ['选择人员', '合成候选'],
      [appraiser ? '评价角色' : '选取套卷', appraiser ? '合成候选' : '合成协作套卷'],
    ]) {
      const item = form.locator('.ant-form-item').filter({ has: page.locator(`label[title="${label}"]`) });
      const select = item.getByRole('combobox');
      await select.click();
      const listbox = await select.getAttribute('aria-controls');
      await page
        .locator('.ant-select-dropdown')
        .filter({ has: page.locator(`[id="${listbox}"]`) })
        .locator(`.ant-select-item-option[title="${candidate}"]`)
        .click();
      await form.getByText(title, { exact: true }).click();
    }
    await form.getByRole('button', saveButton).click();
    await expect(form).toContainText('结果待确认');
    await form.getByRole('button', cancelButton).click();
    if (appraiser)
      await page
        .getByRole('dialog', { name: '设置评价者', exact: true })
        .getByRole('button', { name: '关闭', exact: true })
        .click();
    await page
      .getByRole('dialog', { name: '合成领导力评估', exact: true })
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    await open();
    await expect(form).toContainText('结果待确认');
    await expect(form.getByRole('button', saveButton)).toHaveCount(0);
    expect(writes).toBe(1);
  });
}

test('AC-FE-R3b-R2-01 评定新建共用结果未知保护', async ({ page }) => {
  await setupR3b(page, '/evaluation');
  await page.route('**/org/organizations?*', (route) => route.fulfill({ json: { items: [{ id, name: '合成候选' }] } }));
  await page.route('**/qualification/*?*', (route) => route.fulfill({ json: { items: [{ id, name: '合成候选' }] } }));
  let writes = 0;
  await page.route('**/evaluation/activities', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    writes++;
    return route.fulfill({ status: 503, json: { error: { code: 'RESULT_UNKNOWN' } } });
  });
  await page.getByRole('button', { name: '新建评定活动', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新建评定活动', exact: true });
  await form.getByLabel('名称', { exact: true }).fill('合成未确认评定');
  for (const label of ['活动类型', '所属组织', '周期', '负责人', '组织范围', '申请类别', '申请级别']) {
    const item = form.locator('.ant-form-item').filter({ has: page.locator(`label[title="${label}"]`) });
    const select = item.getByRole('combobox');
    await select.click();
    const listbox = await select.getAttribute('aria-controls');
    await page
      .locator('.ant-select-dropdown')
      .filter({ has: page.locator(`[id="${listbox}"]`) })
      .locator('.ant-select-item-option[title="合成候选"]')
      .click();
    await form.getByText('新建评定活动', { exact: true }).click();
  }
  await form
    .locator('.ant-form-item')
    .filter({ has: page.locator('label[title="年度"]') })
    .getByRole('spinbutton')
    .fill('2026');
  const date = form
    .locator('.ant-form-item')
    .filter({ has: page.locator('label[title="评定生效日期"]') })
    .locator('input');
  await date.fill('2026-10-31');
  await date.press('Enter');
  await form.getByRole('checkbox', { name: '员工本人', exact: true }).check();
  await form.getByRole('button', { name: '下一步' }).click();
  await form.getByRole('button', { name: '下一步' }).click();
  for (const section of await form.locator('.r3b-repeat').all()) {
    for (const label of ['开始日期', '结束日期']) {
      const input = section.getByText(label, { exact: true }).locator('input');
      await input.fill('2026-10-31');
      await input.press('Enter');
    }
  }
  await form.getByLabel('审批流程编码', { exact: true }).fill('DEMO-APPLY');
  await form.getByRole('button', saveButton).click();
  await expect(form).toContainText('结果待确认');
  await form.getByRole('button', cancelButton).click();
  await page.getByRole('button', { name: '新建评定活动', exact: true }).click();
  await expect(form).toContainText('合成未确认评定');
  await expect(form.getByRole('button', saveButton)).toHaveCount(0);
  expect(writes).toBe(1);
});
