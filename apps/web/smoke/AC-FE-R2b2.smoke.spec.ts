import type { Page, Locator } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { item, named, pickDate, save } from './contracts-fixtures.js';
import { companyId, entryId, nextId, setupEntries, typeId } from './entry-fixtures.js';

// 首个行为门禁：旧实现没有 entries 菜单；不靠 import 不存在的文件制造红测。
// DEC-546/548：取消入口由 F-192 另派；已取消场景用夹具造数据。
async function choose(scope: Locator, label: string, option: string) {
  await item(scope, label).locator('.ant-select-selector').click();
  await scope.page().locator('.ant-select-dropdown:visible').getByTitle(option, { exact: true }).click();
}
async function entryPage(page: Page, baseURL: string) {
  const state = await setupEntries(page, baseURL);
  await expect(page.getByRole('menuitem', { name: '入职管理', exact: true })).toBeVisible({ timeout: 5000 });
  return state;
}
const tab = (page: Page, text: string) => page.getByRole('tab', { name: text, exact: true });
const row = (page: Page) => page.getByRole('row').filter({ hasText: '合成入职甲' });
async function onboard(page: Page) {
  await row(page)
    .getByRole('button', { name: /更多|▾/ })
    .click();
  await page.getByRole('menuitem', { name: '入职', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /^入职(?:\s|$)/ });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function selectedAction(page: Page, label: string) {
  await row(page).getByRole('checkbox').check();
  if (await page.getByRole('button', { name: label, exact: true }).count())
    await page.getByRole('button', { name: label, exact: true }).click();
  else {
    await page
      .locator('.ant-tabs-extra-content')
      .getByRole('button', { name: /更多操作/ })
      .click();
    await page.getByRole('menuitem', { name: label, exact: true }).click();
  }
  return page.getByRole('dialog', { name: new RegExp(`^${label}`) });
}

test('AC-FE-R2b2-01 菜单、四视图请求和列头', async ({ page, baseURL }) => {
  const state = await entryPage(page, baseURL!);
  for (const [view, label, column] of [
    ['all', '全部待入职', '计划入职日期'],
    ['today', '今日待入职', '报到日期'],
    ['cancelled', '已取消入职', '取消说明'],
    ['hired', '已入职', '当前状态'],
  ]) {
    await tab(page, label!).click();
    await expect(page.getByRole('columnheader', { name: column, exact: true })).toBeVisible();
    await expect.poll(() => state.reads.some((url) => url.includes(`view=${view}`))).toBe(true);
  }
  expect(state.writes).toEqual([]);
});

test('AC-FE-R2b2-02 已取消不能入职，已入职只读', async ({ page, baseURL }) => {
  const state = await entryPage(page, baseURL!);
  state.row.entryStatus = 1;
  await tab(page, '已取消入职').click();
  await expect(row(page)).toContainText('取消');
  await expect(row(page).getByRole('button', named('入职'))).toHaveCount(0);
  await expect(row(page).getByRole('button', { name: /更多|▾/ })).toHaveCount(0);
  state.row.employeeStatus = 2;
  await tab(page, '已入职').click();
  await expect(row(page)).toContainText('试用');
  await expect(row(page).locator('button:enabled')).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

test('AC-FE-R2b2-03 AC-EN-08 日期自动计算、手改、终止日必填和办理入职', async ({ page, baseURL }) => {
  const state = await entryPage(page, baseURL!);
  const dialog = await onboard(page);
  for (const title of ['员工信息', '汇报关系', '合同协议', '入职定薪', '社保信息'])
    await expect(dialog.getByRole('heading', { name: title, exact: true })).toBeAttached();
  await expect(dialog.getByRole('button', named('暂存'))).toBeDisabled();
  await choose(dialog, '是否有试用期', '是');
  await choose(dialog, '试用期(月)', '1');
  await expect(item(dialog, '预计试用结束日期').getByRole('textbox')).toHaveValue('2026-11-14');
  await pickDate(dialog, '预计试用结束日期', '2026-11-13');
  await choose(dialog, '法人公司', '合成法人公司');
  await choose(dialog, '合同类型', '合成合同类型');
  await choose(dialog, '期限类型', '固定期限');
  await dialog.getByRole('button', save).click();
  await expect(item(dialog, '终止日期')).toContainText('必填');
  expect(state.writes).toEqual([]);
  await pickDate(dialog, '终止日期', '2027-10-14');
  await dialog.getByRole('button', save).click();
  await expect(dialog).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({
    path: `/api/tenant/employment/pending-entries/${entryId}/complete`,
    method: 'POST',
    revision: '4',
    body: {
      probation: true,
      contract: {
        companyId,
        typeId,
        termType: 'fixed',
        endDate: '2027-10-14',
        probationStartDate: '2026-10-15',
        probationEndDate: '2026-11-13',
      },
    },
  });
  expect(state.writes[0]!.command).toBeTruthy();
  expect(Object.keys(state.writes[0]!.body as object).sort()).toEqual(['contract', 'probation']);
  await expect(row(page)).toHaveCount(0);
  await tab(page, '已入职').click();
  await expect(row(page)).toContainText('试用');
});

test('AC-FE-R2b2-04 后端错误原文呈现', async ({ page, baseURL }) => {
  const state = await entryPage(page, baseURL!);
  state.error = '合成后端原文：请核对部门生效时点';
  const dialog = await onboard(page);
  await choose(dialog, '是否有试用期', '否');
  await dialog.getByRole('button', save).click();
  await expect(dialog.getByText(state.error, { exact: true })).toBeVisible();
  expect(state.writes[0]!.body).toEqual({ probation: false });
});

for (const [status, reason, text] of [
  ['generated', '', 'synthetic.entry@example.invalid'],
  ['failed', 'PREFIX_EMPTY', '前缀为空'],
  ['failed', 'PREFIX_ILLEGAL', '非法字符'],
  ['skipped', 'REHIRE_NOT_GENERATED', '重聘'],
  ['no_rule', '', '规则'],
])
  test(`AC-FE-R2b2-05 AC-EN-06 邮箱 ${status}/${reason}`, async ({ page, baseURL }) => {
    const state = await entryPage(page, baseURL!);
    if (status !== 'generated')
      state.email = {
        status: status!,
        ...(reason ? { reason } : {}),
        ...(status === 'failed' ? { ruleId: typeId, ruleName: '合成邮箱规则' } : {}),
      };
    const dialog = await onboard(page);
    await dialog.getByRole('button', { name: '生成邮箱', exact: true }).click();
    await expect(dialog).toContainText(text!);
    if (status === 'generated') await expect(dialog).toContainText('合成邮箱规则');
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toMatchObject({
      body: {},
      revision: '4',
      path: `/api/tenant/employment/pending-entries/${entryId}/generate-email`,
    });
  });

test('AC-FE-R2b2-06 AC-EN-03 改期校验与新 ID 重读', async ({ page, baseURL }) => {
  const state = await entryPage(page, baseURL!);
  const dialog = await selectedAction(page, '改期入职');
  await dialog.getByRole('button', save).click();
  await expect(item(dialog, '入职日期')).toContainText('必填');
  expect(state.writes).toEqual([]);
  await pickDate(dialog, '入职日期', '2026-10-25');
  const before = state.reads.length;
  await dialog.getByRole('button', save).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page)).toContainText('延期');
  await expect(row(page)).toContainText('2026-10-25');
  expect(state.row.id).toBe(nextId);
  expect(state.reads.slice(before).some((url) => url.includes('/pending-entries?'))).toBe(true);
  await expect(page.getByText('操作成功', { exact: true })).toBeVisible();
});

test('AC-FE-R2b2-07 无取消入口，已取消夹具改期恢复', async ({ page, baseURL }) => {
  const state = await entryPage(page, baseURL!);
  await row(page)
    .getByRole('button', { name: /更多|▾/ })
    .click();
  await expect(page.getByRole('menuitem', named('改期入职'))).toHaveCount(0);
  await expect(page.getByRole('menuitem', named('取消入职'))).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(row(page).getByRole('button', named('编辑'))).toBeEnabled();
  state.row.entryStatus = 1;
  await tab(page, '已取消入职').click();
  await expect(row(page)).toContainText('取消');
  const postpone = await selectedAction(page, '改期入职');
  await pickDate(postpone, '入职日期', '2026-10-25');
  await postpone.getByRole('button', save).click();
  await expect(postpone).toHaveCount(0);
  await tab(page, '全部待入职').click();
  await expect(row(page)).toContainText('延期');
  expect(state.writes.every((write) => !write.path.endsWith('/cancel'))).toBe(true);
});

test('AC-FE-R2b2-08 删除气泡确认后四视图不可见', async ({ page, baseURL }) => {
  const state = await entryPage(page, baseURL!);
  await row(page)
    .getByRole('button', { name: /更多|▾/ })
    .click();
  await page.getByRole('menuitem', { name: '删除人员', exact: true }).click();
  await expect(page.getByText('删除的人员将不可恢复，是否继续？', { exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
  await page.getByRole('button', named('是')).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]).toMatchObject({
    method: 'DELETE',
    revision: '4',
    path: `/api/tenant/employment/pending-entries/${entryId}`,
  });
  for (const label of ['今日待入职', '已取消入职', '已入职', '全部待入职']) {
    await tab(page, label).click();
    await expect(row(page)).toHaveCount(0);
  }
});

test('AC-FE-R2b2-09 409 重读保留改动，显式确认后用新 revision', async ({ page, baseURL }) => {
  const state = await entryPage(page, baseURL!);
  let first = true;
  await page.route('**/pending-entries/*/complete', async (route) => {
    if (!first) return route.fallback();
    first = false;
    state.row.revision = 8;
    return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT', message: '合成版本冲突' } } });
  });
  const dialog = await onboard(page);
  await choose(dialog, '是否有试用期', '否');
  await dialog.getByRole('button', save).click();
  await dialog.getByRole('button', named('重读最新版本')).click();
  await dialog.getByRole('button', named('已核对差异，继续编辑')).click();
  await dialog.getByRole('button', save).click();
  await expect(dialog).toHaveCount(0);
  expect(state.writes[0]).toMatchObject({ revision: '8', body: { probation: false } });
});

for (const action of ['complete', 'generate-email'])
  test(`AC-FE-R2b2-10 ${action} 结果未知后关闭、换视图、重开仍锁定`, async ({ page, baseURL }) => {
    await entryPage(page, baseURL!);
    let writes = 0;
    await page.route(`**/pending-entries/*/${action}`, (route) => {
      writes++;
      return route.fulfill({ json: { status: 'unexpected' } });
    });
    let dialog = await onboard(page);
    await choose(dialog, '是否有试用期', '否');
    await dialog.getByRole('button', action === 'complete' ? save : named('生成邮箱')).click();
    await expect(dialog.getByRole('button', save)).toBeDisabled();
    await dialog.getByRole('button', named('取消')).click();
    await tab(page, '今日待入职').click();
    dialog = await onboard(page);
    await expect(dialog.getByRole('button', save)).toBeDisabled();
    await expect(dialog.getByRole('button', named('生成邮箱'))).toBeDisabled();
    await dialog.getByRole('button', named('回查原单')).click();
    await expect(dialog).toContainText('原单当前值');
    await expect(dialog.getByRole('button', save)).toBeDisabled();
    expect(writes).toBe(1);
  });

test('AC-FE-R2b2-11 只有按钮权限，没有对象更新权时不出现入职动作', async ({ page, baseURL }) => {
  const state = await entryPage(page, baseURL!);
  await page.route('**/permission/me/objects/TenantBase.EmploymentRecord', (route) =>
    route.fulfill({
      json: {
        objectCode: 'TenantBase.EmploymentRecord',
        dataOperations: {},
        viewableFields: ['id', 'revision'],
        editableFields: [],
        buttons: [{ buttonCode: 'Employment.Edit', level: 'detail' }],
      },
    }),
  );
  await page.reload();
  await row(page)
    .getByRole('button', { name: /更多|▾/ })
    .click();
  await expect(page.getByRole('menuitem', named('入职'))).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

for (const change of ['probation', 'date', 'relation'])
  test(`AC-FE-R2b2-12 编辑 ${change} 必填、真实 PATCH 和列表持久回填`, async ({ page, baseURL }) => {
    const state = await entryPage(page, baseURL!);
    await row(page).getByRole('button', named('编辑')).click();
    const dialog = page.getByRole('dialog', { name: /^编辑/ });
    await expect(item(dialog, '是否有试用期')).toContainText('请选择');
    await dialog.getByRole('button', save).click();
    await expect(item(dialog, '是否有试用期')).toContainText('必填');
    expect(state.writes).toEqual([]);
    await choose(dialog, '是否有试用期', '否');
    if (change === 'date') await pickDate(dialog, '计划入职日期', '2026-09-10');
    if (change === 'relation') await choose(dialog, '雇佣关系', '实习生');
    await dialog.getByRole('button', save).click();
    await expect(dialog).toHaveCount(0);
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toMatchObject({
      method: 'PATCH',
      revision: '4',
      path: `/api/tenant/employment/pending-entries/${entryId}`,
      body: {
        effectiveDate: change === 'date' ? '2026-09-10' : '2026-10-15',
        probation: false,
        employType: change === 'relation' ? 'intern' : 'internal',
      },
    });
    expect(state.writes[0]!.command).toBeTruthy();
    expect(state.row.id).toBe(change === 'probation' ? entryId : nextId);
    await expect(row(page)).toContainText('正常');
    await row(page).getByRole('button', named('编辑')).click();
    await expect(item(dialog, '是否有试用期')).toContainText('否');
    expect(Object.keys(state.writes[0]!.body as object).sort()).toEqual(['effectiveDate', 'employType', 'probation']);
  });

async function actionDialog(page: Page, action: string) {
  if (action === 'postpone') {
    const dialog = await selectedAction(page, '改期入职');
    await pickDate(dialog, '入职日期', '2026-10-25');
    return dialog;
  }
  if (action === 'edit') {
    await row(page).getByRole('button', named('编辑')).click();
    const dialog = page.getByRole('dialog', { name: /^编辑/ });
    await choose(dialog, '是否有试用期', '否');
    return dialog;
  }
  await row(page)
    .getByRole('button', { name: /更多|▾/ })
    .click();
  await page.getByRole('menuitem', named('删除人员')).click();
  return page.locator('.ant-popconfirm');
}
for (const action of ['edit', 'postpone', 'delete']) {
  for (const failure of ['conflict', 'unknown'])
    test(`AC-FE-R2b2-13 ${action} ${failure} 恢复槽跨视图且不盲重试`, async ({ page, baseURL }) => {
      const state = await entryPage(page, baseURL!);
      let attempts = 0;
      await page.route('**/pending-entries/**', (route) => {
        if (route.request().method() === 'GET') return route.fallback();
        attempts++;
        if (attempts > 1) return route.fallback();
        state.row.revision = 8;
        return failure === 'conflict'
          ? route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT', message: '合成版本冲突' } } })
          : route.fulfill({ json: { status: 'unexpected' } });
      });
      const submit = action === 'delete' ? named('是') : save;
      let dialog = await actionDialog(page, action);
      await dialog.getByRole('button', submit).click();
      await expect(dialog.getByRole('button', submit)).toBeDisabled();
      if (failure === 'conflict') {
        await dialog.getByRole('button', named('重读最新版本')).click();
        await dialog.getByRole('button', named('已核对差异，继续编辑')).click();
        await dialog.getByRole('button', submit).click();
        await expect(dialog).toHaveCount(0);
        expect(state.writes[0]!.revision).toBe('8');
        expect(attempts).toBe(2);
      } else {
        await dialog.getByRole('button', named(action === 'delete' ? '否' : '取消')).click();
        await tab(page, '今日待入职').click();
        // 重开时所有控件都已锁住，因此不再填值。
        if (action === 'postpone') dialog = await selectedAction(page, '改期入职');
        else if (action === 'edit') {
          await row(page).getByRole('button', named('编辑')).click();
          dialog = page.getByRole('dialog', { name: /^编辑/ });
        } else dialog = await actionDialog(page, action);
        await expect(dialog.getByRole('button', submit)).toBeDisabled();
        await dialog.getByRole('button', named('回查原单')).click();
        await expect(dialog).toContainText('原单当前值');
        await expect(dialog.getByRole('button', submit)).toBeDisabled();
        expect(attempts).toBe(1);
      }
    });
}

test('AC-FE-R2b2-14 编辑冲突重读从服务端列表恢复未改动的试用期', async ({ page, baseURL }) => {
  const state = await entryPage(page, baseURL!);
  state.row.probation = false;
  await page.reload();
  await page.route('**/pending-entries/*', (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    state.row.probation = true;
    state.row.revision = 8;
    return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT', message: '合成版本冲突' } } });
  });
  await row(page).getByRole('button', named('编辑')).click();
  const dialog = page.getByRole('dialog', { name: /^编辑/ });
  await pickDate(dialog, '计划入职日期', '2026-10-25');
  await dialog.getByRole('button', save).click();
  await dialog.getByRole('button', named('重读最新版本')).click();
  await dialog.getByRole('button', named('已核对差异，继续编辑')).click();
  await expect(item(dialog, '是否有试用期').locator('.ant-select-selection-item')).toHaveText('是');
  await expect(item(dialog, '计划入职日期').getByRole('textbox')).toHaveValue('2026-10-25');
});

test('AC-FE-R2b2-15 字段写权与删除对象权不足时关闭入口，合同不可创建时不提交合同', async ({ page, baseURL }) => {
  const state = await entryPage(page, baseURL!);
  await page.route('**/permission/me/objects/*', (route) =>
    route.fulfill({
      json: {
        objectCode: decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!),
        dataOperations: { update: true },
        viewableFields: ['id', 'revision'],
        editableFields: [],
        buttons: ['Employment.Edit', 'Employment.Delete'].map((buttonCode) => ({ buttonCode, level: 'detail' })),
      },
    }),
  );
  await page.reload();
  await expect(row(page).getByRole('button', named('编辑'))).toBeDisabled();
  await row(page).getByRole('checkbox').check();
  await page
    .locator('.ant-tabs-extra-content')
    .getByRole('button', { name: /更多操作/ })
    .click();
  await expect(page.getByRole('menuitem', named('改期入职'))).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await row(page)
    .getByRole('button', { name: /更多|▾/ })
    .click();
  await expect(page.getByRole('menuitem', named('删除人员'))).toHaveCount(0);
  await page.getByRole('menuitem', named('入职')).click();
  const dialog = page.getByRole('dialog', { name: /^入职(?:\s|$)/ });
  await expect(item(dialog, '法人公司').locator('.ant-select')).toHaveCount(0);
  await choose(dialog, '是否有试用期', '否');
  await dialog.getByRole('button', save).click();
  await expect(dialog).toHaveCount(0);
  expect(state.writes[0]!.body).toEqual({ probation: false });
});

test('AC-FE-R2b2-16 写成功后等整页重读，读失败维持 unknown 锁', async ({ page, baseURL }) => {
  const state = await entryPage(page, baseURL!);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reading = false;
  await page.route('**/pending-entries?*', async (route) => {
    if (!state.writes.length) return route.fallback();
    reading = true;
    await hold;
    return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: '合成读失败' } } });
  });
  const dialog = await actionDialog(page, 'edit');
  await dialog.getByRole('button', save).click();
  await expect.poll(() => reading).toBe(true);
  await expect(dialog.getByRole('button', save)).toBeDisabled();
  expect(state.writes).toHaveLength(1);
  release();
  await expect(dialog.getByRole('button', named('回查原单'))).toBeVisible();
  await expect(dialog.getByRole('button', save)).toBeDisabled();
  expect(state.writes).toHaveLength(1);
});

test('AC-FE-R2b2-17 服务端裁剪字段只展示占位，不补出名称或用于搜索', async ({ page, baseURL }) => {
  const state = await entryPage(page, baseURL!);
  await page.route('**/pending-entries?*', (route) =>
    route.fulfill({
      json: {
        items: [{ id: entryId, employeeId: state.row.employeeId, revision: 4, probation: null }],
        page: 1,
        pageSize: 30,
        hasDataPermission: true,
      },
    }),
  );
  await page.reload();
  await expect(page.getByRole('row').filter({ has: page.getByRole('button', named('编辑')) })).toContainText('--');
  await expect(page.getByText('合成入职甲', { exact: true })).toHaveCount(0);
  await expect(page.getByText('合成入职部门', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', named('姓名 ▾'))).toBeDisabled();
  expect(state.writes).toEqual([]);
});
for (const status of [400, 403, 409])
  test(`AC-FE-R2b2-18 编辑 ${status} 保留后端原文`, async ({ page, baseURL }) => {
    await entryPage(page, baseURL!);
    const message = `合成后端 ${status} 原文`;
    await page.route('**/pending-entries/*', (route) =>
      route.request().method() === 'PATCH'
        ? route.fulfill({ status, json: { error: { code: 'BUSINESS_REJECTED', message } } })
        : route.fallback(),
    );
    const dialog = await actionDialog(page, 'edit');
    await dialog.getByRole('button', save).click();
    await expect(dialog.getByText(message, { exact: true })).toBeVisible();
  });

test('AC-FE-R2b2-19 编辑未知后其他动作共用原单锁', async ({ page, baseURL }) => {
  await entryPage(page, baseURL!);
  let writes = 0;
  await page.route('**/pending-entries/*', (route) => {
    if (route.request().method() === 'GET') return route.fallback();
    writes++;
    return route.fulfill({ json: {} });
  });
  let dialog = await actionDialog(page, 'edit');
  await dialog.getByRole('button', save).click();
  await dialog.getByRole('button', named('取消')).click();
  dialog = await selectedAction(page, '改期入职');
  await expect(dialog.getByRole('button', save)).toBeDisabled();
  await dialog.getByRole('button', named('取消')).click();
  dialog = await onboard(page);
  await expect(dialog.getByRole('button', save)).toBeDisabled();
  await expect(dialog.getByRole('button', named('生成邮箱'))).toBeDisabled();
  await dialog.getByRole('button', named('取消')).click();
  dialog = await actionDialog(page, 'delete');
  await expect(dialog.getByRole('button', named('是'))).toBeDisabled();
  expect(writes).toBe(1);
});

for (const action of ['edit', 'complete'])
  test(`AC-FE-R2b2-20 ${action} 打开前他人改试用期时整条重读`, async ({ page, baseURL }) => {
    const state = await entryPage(page, baseURL!);
    state.row.probation = false;
    await page.reload();
    await expect(row(page)).toBeVisible();
    Object.assign(state.row, { probation: true, revision: 8, employType: 'external' });
    let dialog;
    if (action === 'complete') dialog = await onboard(page);
    else {
      await row(page).getByRole('button', named('编辑')).click();
      dialog = page.getByRole('dialog', { name: /^编辑/ });
    }
    await expect(item(dialog, '是否有试用期').locator('.ant-select-selection-item')).toHaveText('是');
    if (action === 'complete') await choose(dialog, '试用期(月)', '1');
    await dialog.getByRole('button', save).click();
    await expect(dialog).toHaveCount(0);
    expect(state.writes[0]).toMatchObject({ revision: '8', body: { probation: true } });
  });
