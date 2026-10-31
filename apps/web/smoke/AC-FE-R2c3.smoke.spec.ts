import type { Page, Request } from '@playwright/test';
import { test, expect, employee } from './fixtures.js';
import {
  ackToken,
  bill,
  billId,
  business,
  conflict,
  department,
  draftId,
  employeeRevision,
  intention,
  intentionId,
  openRow,
  person,
  preview,
  receiver,
  setup,
  subordinate,
  switchView,
} from './retirement-fixtures.js';

const personHeaders = [
  '姓名',
  '工号',
  '部门',
  '职位',
  '预计退休日期',
  '距退休天数',
  '最早可退休日期',
  '最晚可退休日期',
];
const billHeaders = ['姓名', '工号', '部门', '职位', '最后工作日', '退休生效日期', '退休类型', '办理方式', '审批状态'];
const headers = {
  upcoming: personHeaders,
  overdue: personHeaders,
  processing: billHeaders,
  completed: [...billHeaders, '是否同时返聘'],
  all: [...billHeaders, '是否同时返聘', '发起时间'],
};
const dialog = (page: Page) => page.getByRole('dialog').last();
const confirm = (page: Page) =>
  page
    .getByRole('button', { name: /确\s*定/ })
    .last()
    .click();

async function choose(page: Page, label: string, text: string) {
  await dialog(page)
    .getByRole('combobox', { name: label, exact: true })
    .locator('xpath=ancestor::div[contains(@class,"ant-select-selector")]')
    .click();
  // 上一个下拉框收起动画中仍可见：取最新展开的一个
  const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
  await dropdown.locator('.ant-select-item-option-content').getByText(text, { exact: true }).click();
  await dialog(page).locator('.ant-modal-title').click();
}
async function date(page: Page, label: string, value: string) {
  const input = dialog(page)
    .locator('.ant-form-item')
    .filter({ has: page.locator('label').getByText(label, { exact: true }) })
    .locator('input');
  await input.fill(value);
  await input.press('Enter');
  await dialog(page).locator('.ant-modal-title').click();
}
const posted = (request: Request) => ({
  body: request.postDataJSON() as Record<string, unknown>,
  ifMatch: request.headers()['if-match'],
  key: request.headers()['idempotency-key'],
});
/** 打开员工行的人员详情并点入口。 */
async function enter(page: Page, entry: string) {
  await openRow(page, 'upcoming');
  await page.getByRole('button', { name: entry, exact: true }).click();
}
async function previewWith(page: Page, lastWorkDate: string) {
  await date(page, '最后工作日', lastWorkDate);
  await dialog(page)
    .getByRole('button', { name: /预\s*览/ })
    .click();
  await expect(dialog(page).getByRole('region', { name: '提交前预览' })).toBeVisible();
}

test('AC-FE-R2c3-01 五视图各按 view 读，列按投影，切换 / 筛选 / 分页不串数据', async ({ page }) => {
  const { queries } = await setup(page);
  await expect(page.getByRole('heading', { name: '退休管理', exact: true })).toBeVisible();
  await expect.poll(() => queries[0]?.get('view')).toBe('upcoming');
  expect(queries[0]?.get('pageSize')).toBe('30');
  for (const view of ['upcoming', 'overdue', 'processing', 'completed', 'all'] as const) {
    await switchView(page, view);
    expect(queries.at(-1)?.get('view')).toBe(view);
    await expect(page.locator('.retirement-table .ant-table-thead th')).toHaveText([...headers[view], '操作']);
  }
  await expect(page.getByRole('cell', { name: '提前退休', exact: true }).first()).toBeVisible();
  await switchView(page, 'upcoming');
  await expect(page.getByRole('cell', { name: '2026-11-30', exact: true })).toBeVisible();
  await page.getByLabel('即将退休天数').fill('60');
  await page.getByRole('button', { name: /查\s*询/ }).click();
  await expect.poll(() => queries.at(-1)?.get('upcomingDays')).toBe('60');
  expect(queries.at(-1)?.get('view')).toBe('upcoming');
  await switchView(page, 'completed');
  await expect(page.getByLabel('即将退休天数')).toHaveCount(0);
  expect(queries.at(-1)?.has('upcomingDays')).toBe(false);
  await switchView(page, 'upcoming');
  expect(queries.at(-1)?.has('upcomingDays')).toBe(false);
  await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
});

test('AC-FE-R2c3-02 预计退休日期不可见时不出天数控件；字段被裁剪显示占位；无按钮时不出入口', async ({ page }) => {
  const { server } = await setup(page, { employeeFields: ['name', 'code'], buttons: [] });
  await expect(page.getByRole('cell', { name: person.name, exact: true })).toBeVisible();
  await expect(page.getByLabel('即将退休天数')).toHaveCount(0);
  const { expectedRetirementDate: _p, daysToRetirement: _d, ...trimmed } = person;
  server.views.upcoming = [trimmed];
  await page.getByRole('button', { name: /刷\s*新/ }).click();
  await expect(page.locator('.retirement-table tr.ant-table-row td').nth(4)).toHaveText('--');
  await openRow(page, 'upcoming');
  await expect(page.getByRole('dialog').getByText('员工档案').first()).toBeVisible();
  for (const name of ['退休办理', '退休申请', '意向退休日期申请'])
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
});

test('AC-FE-R2c3-03 意向退休日期申请：新建草稿按员工 revision，再按申请 revision 提交审批', async ({ page }) => {
  const { server } = await setup(page);
  const sent: (ReturnType<typeof posted> & { url: string })[] = [];
  await page.route(`**/employment/retirement-intentions/employees/${employee}`, (route) => {
    sent.push({ ...posted(route.request()), url: route.request().url() });
    server.intentions = [intention('draft')];
    return route.fulfill({ status: 201, json: intention('draft') });
  });
  await page.route(`**/employment/retirement-intentions/${intentionId}/submit`, (route) => {
    sent.push({ ...posted(route.request()), url: route.request().url() });
    server.intentions = [intention('in_review', 2)];
    return route.fulfill({ json: intention('in_review', 2) });
  });
  await enter(page, '意向退休日期申请');
  await expect(dialog(page).getByText('暂无进行中的意向退休日期申请')).toBeVisible();
  await dialog(page)
    .getByRole('button', { name: /新\s*建/ })
    .click();
  await date(page, '意向退休日期', '2026-12-31');
  await dialog(page)
    .getByRole('button', { name: /保\s*存/ })
    .click();
  await expect(page.getByText('已保存')).toBeVisible();
  await expect(dialog(page).getByText('草稿')).toBeVisible();
  await dialog(page).getByRole('button', { name: '提交审批', exact: true }).click();
  await page
    .getByRole('tooltip')
    .getByRole('button', { name: /确\s*定/ })
    .click();
  await expect(page.getByText('意向退休日期申请已提交')).toBeVisible();
  await expect(dialog(page).getByText('审批中')).toBeVisible();
  expect(sent.map(({ body, ifMatch }) => ({ body, ifMatch }))).toEqual([
    { body: { intendedDate: '2026-12-31', reason: null }, ifMatch: String(employeeRevision) },
    { body: {}, ifMatch: '1' },
  ]);
  expect(sent[1]!.key).not.toBe(sent[0]!.key);
});

test('AC-FE-R2c3-04 退休办理：预览 → 职责转交 → 在途调动确认后同一上下文重提，人员移入退休中', async ({ page }) => {
  const { server, queries } = await setup(page);
  const previews: ReturnType<typeof posted>[] = [];
  const sent: ReturnType<typeof posted>[] = [];
  await page.route(`**/employment/retirements/employees/${employee}/preview`, async (route) => {
    previews.push(posted(route.request()));
    return route.fulfill({ json: preview(String(previews.at(-1)!.body.lastWorkDate)) });
  });
  await page.route(`**/employment/retirements/employees/${employee}`, (route) => {
    sent.push(posted(route.request()));
    if (sent.length === 1)
      return route.fulfill(
        conflict('有新的在途调动，确认后继续', { reason: 'EXIT_PENDING_TRANSFER_ACK_REQUIRED', ackToken: 'ack-2' }),
      );
    server.employeeRevision = employeeRevision + 1;
    server.views = { ...server.views, upcoming: [], processing: [bill('approved')], all: [bill('approved')] };
    return route.fulfill({ status: 201, json: business() });
  });
  await enter(page, '退休办理');
  await expect(dialog(page).getByRole('region', { name: '职责转交' })).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: /提\s*交/ })).toBeDisabled();
  await previewWith(page, '2026-11-29');
  await expect(dialog(page).getByText('将作废的在途任职申请：2 件')).toBeVisible();
  await expect(dialog(page).getByText('在途调动 / 考核将被作废，提交即视为确认。')).toBeVisible();
  await choose(page, '职责接收人', '合成接收人');
  await choose(page, '转交下属', '合成下属');
  await dialog(page).getByRole('checkbox', { name: '转交部门负责人' }).check();
  await dialog(page)
    .getByRole('button', { name: /提\s*交/ })
    .click();
  await expect(page.getByText('有新的在途调动，确认后继续').last()).toBeVisible();
  await confirm(page);
  await expect(page.getByText('退休办理成功')).toBeVisible();
  expect(previews.map((item) => item.body)).toEqual([{ lastWorkDate: '2026-11-29' }]);
  const dutyTransfer = {
    subordinates: [{ employeeId: subordinate, receiverId: receiver, relation: 'direct' }],
    orgRoles: [{ orgId: department, role: 'person_in_charge', receiverId: receiver }],
  };
  expect(sent[0]!.body).toEqual({
    mode: 'direct',
    lastWorkDate: '2026-11-29',
    exit: { dutyTransfer, pendingTransferAck: ackToken },
  });
  expect(sent[1]!.body).toEqual({ ...sent[0]!.body, exit: { dutyTransfer, pendingTransferAck: 'ack-2' } });
  expect(sent.map((item) => item.ifMatch)).toEqual([String(employeeRevision), String(employeeRevision)]);
  expect(sent[1]!.key).not.toBe(sent[0]!.key);
  await expect.poll(() => queries.at(-1)?.get('view')).toBe('upcoming');
  await expect(page.getByRole('cell', { name: person.name, exact: true })).toHaveCount(0);
  await switchView(page, 'processing');
  await expect(page.getByRole('cell', { name: '审批通过', exact: true })).toBeVisible();
});

test('AC-FE-R2c3-05 退休申请：无职责转交区，先建草稿再按草稿 revision 提交', async ({ page }) => {
  const { server } = await setup(page);
  const sent: (ReturnType<typeof posted> & { url: string })[] = [];
  await page.route(`**/employment/retirements/employees/${employee}/preview`, (route) =>
    route.fulfill({ json: { ...preview('2026-11-29'), ack: null } }),
  );
  const draft = { id: draftId, mode: 'application', status: 'draft', revision: 1 };
  await page.route(`**/employment/retirements/employees/${employee}`, (route) => {
    sent.push({ ...posted(route.request()), url: route.request().url() });
    server.employeeRevision = employeeRevision + 1;
    return route.fulfill({ status: 201, json: business(draft) });
  });
  await page.route(`**/employment/retirements/${draftId}/submit`, (route) => {
    sent.push({ ...posted(route.request()), url: route.request().url() });
    return route.fulfill({ json: business({ ...draft, status: 'in_review', revision: 2 }) });
  });
  await enter(page, '退休申请');
  await expect(dialog(page).getByRole('region', { name: '职责转交' })).toHaveCount(0);
  await previewWith(page, '2026-11-29');
  await dialog(page)
    .getByRole('button', { name: /提\s*交/ })
    .click();
  await expect(page.getByText('退休申请提交成功')).toBeVisible();
  expect(sent.map(({ body, ifMatch }) => ({ body, ifMatch }))).toEqual([
    { body: { mode: 'application', lastWorkDate: '2026-11-29' }, ifMatch: String(employeeRevision) },
    { body: {}, ifMatch: '1' },
  ]);
  expect(sent[1]!.url).toContain(`/retirements/${draftId}/submit`);
});

test('AC-FE-R2c3-06 退休单详情：交接页签只读缺口，撤销后从退休中消失', async ({ page }) => {
  const { server } = await setup(page);
  server.views.processing = [bill('approved')];
  server.views.all = [bill('approved')];
  const sent: ReturnType<typeof posted>[] = [];
  await page.route(`**/employment/retirements/${billId}/cancel`, (route) => {
    sent.push(posted(route.request()));
    const cancellation = { id: '90000000-0000-4000-8000-000000000001', reason: '合成撤销原因' };
    server.billRevision = 3;
    server.views.processing = [];
    server.views.all = [bill('approved', { revision: 3, cancellation })];
    return route.fulfill({ json: { ...business({ revision: 3 }), cancellation, downstream: {} } });
  });
  await openRow(page, 'processing');
  const drawer = page.locator('.ant-drawer');
  await expect(drawer.getByText(person.name).first()).toBeVisible();
  for (const tab of ['退休信息', '退休交接', '变更记录'])
    await expect(drawer.getByRole('tab', { name: tab })).toBeVisible();
  await expect(drawer.getByText('合成接收人')).toBeVisible();
  await drawer.getByRole('tab', { name: '退休交接' }).click();
  await expect(drawer.getByText(/后端未开放退休交接子流程/)).toBeVisible();
  await drawer.getByRole('tab', { name: '变更记录' }).click();
  await expect(drawer.getByRole('cell', { name: '2026-11-29', exact: true })).toBeVisible();
  await expect(drawer.getByRole('button', { name: /提\s*交|撤\s*回/ })).toHaveCount(0);
  await drawer.getByRole('button', { name: '撤销退休', exact: true }).click();
  await dialog(page).getByLabel('撤销原因').fill('合成撤销原因');
  await confirm(page);
  await expect(page.getByText('已撤销退休')).toBeVisible();
  expect(sent).toEqual([{ body: { reason: '合成撤销原因' }, ifMatch: '2', key: expect.any(String) }]);
  await expect(page.locator('.retirement-table tr.ant-table-row')).toHaveCount(0);
});

test('AC-FE-R2c3-07 409 版本冲突：重读员工最新 revision、保留输入，核对后按新版本重提', async ({ page }) => {
  const { server } = await setup(page);
  const sent: ReturnType<typeof posted>[] = [];
  await page.route(`**/employment/retirements/employees/${employee}/preview`, (route) =>
    route.fulfill({ json: { ...preview('2026-11-29'), ack: null } }),
  );
  await page.route(`**/employment/retirements/employees/${employee}`, (route) => {
    sent.push(posted(route.request()));
    if (sent.length === 1)
      return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT', message: '版本冲突' } } });
    server.employeeRevision = employeeRevision + 2;
    return route.fulfill({ status: 201, json: business({ employeeRevision: employeeRevision + 2 }) });
  });
  await enter(page, '退休办理');
  await previewWith(page, '2026-11-29');
  server.employeeRevision = employeeRevision + 1;
  await dialog(page)
    .getByRole('button', { name: /提\s*交/ })
    .click();
  await expect(
    dialog(page)
      .getByText(/版本冲突/)
      .first(),
  ).toBeVisible();
  const reread = dialog(page).getByRole('button', { name: '重读最新版本' });
  if (await reread.isVisible()) await reread.click();
  await dialog(page).getByRole('button', { name: '已核对差异，继续编辑' }).click();
  await expect(dialog(page).locator('input[value="2026-11-29"]')).toBeVisible();
  await dialog(page)
    .getByRole('button', { name: /提\s*交/ })
    .click();
  await expect(page.getByText('退休办理成功')).toBeVisible();
  expect(sent.map((item) => item.ifMatch)).toEqual([String(employeeRevision), String(employeeRevision + 1)]);
  expect(sent[1]!.body).toEqual({ mode: 'direct', lastWorkDate: '2026-11-29' });
});

test('AC-FE-R2c3-08 结果未知只读锁定：关闭重开、换入口、换视图后仍锁定，不换命令 ID 重提', async ({ page }) => {
  await setup(page);
  let attempts = 0;
  await page.route(`**/employment/retirements/employees/${employee}/preview`, (route) =>
    route.fulfill({ json: { ...preview('2026-11-29'), ack: null } }),
  );
  await page.route(`**/employment/retirements/employees/${employee}`, (route) => {
    attempts += 1;
    return route.abort('connectionreset');
  });
  await enter(page, '退休办理');
  await previewWith(page, '2026-11-29');
  const submit = dialog(page).getByRole('button', { name: /提\s*交/ });
  await submit.click();
  await expect(dialog(page).getByText(/结果待确认/)).toBeVisible();
  await expect(submit).toBeDisabled();
  await dialog(page)
    .getByRole('button', { name: /取\s*消/ })
    .click();
  await page.getByRole('button', { name: '退休申请', exact: true }).click();
  await expect(dialog(page).getByText('本对象有未确认的其他操作，确认结果前不能发起新操作。')).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: /提\s*交/ })).toBeDisabled();
  await dialog(page)
    .getByRole('button', { name: /取\s*消/ })
    .click();
  await page.getByRole('dialog', { name: '员工档案' }).getByRole('button', { name: '关闭' }).click();
  await switchView(page, 'overdue');
  await switchView(page, 'upcoming');
  await enter(page, '退休办理');
  await expect(dialog(page).getByText(/结果待确认/)).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: /提\s*交/ })).toBeDisabled();
  expect(attempts).toBe(1);
});

// ---- 第 2 轮返工回归（审查结论 P2-1～P2-5；形状对照 exit-routes.ts projectCancelReceipt 与 exit-downstream.ts）----

/** 按字段权裁剪的写回执（context.ts trimEmploymentResponse）：顶层只留可见字段，fields / customFields 逐项裁剪。 */
function trimmed(raw: Record<string, unknown>, shown: string[], kept: string[] = []) {
  return Object.fromEntries(
    Object.entries({ ...raw, fields: {}, customFields: {} }).filter(
      ([key]) => shown.includes(key) || ['fields', 'customFields', 'record', ...kept].includes(key),
    ),
  );
}
const recordPermission = (json: Record<string, unknown>) => ({
  json: {
    objectCode: 'TenantBase.EmploymentRecord',
    dataOperations: { read: true, create: true, update: true },
    ...json,
  },
});

test('AC-FE-R2c3-09 P2-1 撤销回执裁掉类型、意向回执裁掉状态：照常确认成功，不锁结果未知', async ({ page }) => {
  const { server } = await setup(page);
  const shown = ['id', 'employeeId', 'revision', 'name', 'code', 'mode', 'lastWorkDate', 'effectiveDate'];
  await page.route('**/permission/me/objects/TenantBase.EmploymentRecord', (route) =>
    route.fulfill(
      recordPermission({
        viewableFields: [...shown, 'intendedDate', 'reason'],
        editableFields: ['intendedDate', 'reason'],
        buttons: ['Employment.RetireCancel', 'Employment.RetireIntention'].map((buttonCode) => ({
          buttonCode,
          level: 'detail',
        })),
      }),
    ),
  );
  await page.reload();
  server.views.processing = [bill('approved')];
  server.views.all = [bill('approved')];
  let writes = 0;
  await page.route(`**/employment/retirements/${billId}/cancel`, (route) => {
    writes += 1;
    const cancellation = {
      id: '80000000-0000-4000-8000-000000000002',
      case: 'approved_voided',
      stateBefore: 'approved',
      reason: '合成撤销原因',
      revision: 1,
      createdAt: '2026-10-30T00:00:00.000Z',
    };
    server.billRevision = 3;
    server.views.processing = [];
    server.views.all = [bill('voided', { revision: 3, cancellation })];
    const raw = {
      ...business({ status: 'voided', revision: 3 }),
      cancellation,
      downstream: { items: [], additional: [] },
    };
    return route.fulfill({ json: trimmed(raw, shown, ['cancellation', 'downstream']) });
  });
  await openRow(page, 'processing');
  await page.locator('.ant-drawer').getByRole('button', { name: '撤销退休', exact: true }).click();
  await dialog(page).getByLabel('撤销原因').fill('合成撤销原因');
  await confirm(page);
  await expect(page.getByText('已撤销退休')).toBeVisible();
  await expect(page.getByText(/结果待确认/)).toHaveCount(0);
  expect(writes).toBe(1);
  await page.reload();

  // 意向新建：回执裁掉 status（intentionView 经 trimEmploymentResponse），保存仍成功
  const intentionShown = ['id', 'employeeId', 'revision', 'intendedDate', 'reason'];
  await page.route(`**/employment/retirement-intentions/employees/${employee}`, (route) => {
    writes += 1;
    const view = trimmed(intention('draft'), intentionShown);
    const { fields: _f, customFields: _c, record: _r, ...plain } = view;
    server.intentions = [plain];
    return route.fulfill({ status: 201, json: plain });
  });
  await enter(page, '意向退休日期申请');
  await dialog(page)
    .getByRole('button', { name: /新\s*建/ })
    .click();
  await date(page, '意向退休日期', '2026-12-31');
  await dialog(page)
    .getByRole('button', { name: /保\s*存/ })
    .click();
  await expect(page.getByText('已保存')).toBeVisible();
  await expect(page.getByText(/结果待确认/)).toHaveCount(0);
  expect(writes).toBe(2);
});

test('AC-FE-R2c3-10 P2-2 单据提交被要求确认在途调动：确认后令牌进 pendingTransferAck，原单与 revision 不变', async ({
  page,
}) => {
  const { server } = await setup(page);
  server.views.all = [bill('draft', { mode: 'application' })];
  const sent: (ReturnType<typeof posted> & { url: string })[] = [];
  await page.route(`**/employment/retirements/${billId}/submit`, (route) => {
    sent.push({ ...posted(route.request()), url: route.request().url() });
    if (sent.length === 1)
      return route.fulfill(
        conflict('有在途调动，提交将作废', { reason: 'EXIT_PENDING_TRANSFER_ACK_REQUIRED', ackToken: 'ack-2' }),
      );
    server.billRevision = 3;
    return route.fulfill({ json: business({ mode: 'application', status: 'in_review', revision: 3 }) });
  });
  await openRow(page, 'all');
  await page
    .locator('.ant-drawer')
    .getByRole('button', { name: /提\s*交/ })
    .click();
  await page
    .getByRole('tooltip')
    .getByRole('button', { name: /确\s*定/ })
    .click();
  await expect(page.locator('.ant-modal-confirm')).toBeVisible();
  await confirm(page);
  await expect(page.getByText('已提交')).toBeVisible();
  expect(sent.map(({ body, ifMatch }) => ({ body, ifMatch }))).toEqual([
    { body: {}, ifMatch: '2' },
    { body: { pendingTransferAck: 'ack-2' }, ifMatch: '2' },
  ]);
  for (const item of sent) expect(item.url).toContain(`/retirements/${billId}/submit`);
});

/** 申请第一步建草稿（回执 = EmploymentBusiness，草稿 revision 1），员工 revision 加一。 */
async function draftCreation(page: Page, server: { employeeRevision: number }) {
  let creates = 0;
  await page.route(`**/employment/retirements/employees/${employee}/preview`, (route) =>
    route.fulfill({ json: { ...preview('2026-11-29'), ack: null } }),
  );
  await page.route(`**/employment/retirements/employees/${employee}`, (route) => {
    creates += 1;
    server.employeeRevision = employeeRevision + 1;
    return route.fulfill({
      status: 201,
      json: business({ id: draftId, mode: 'application', status: 'draft', revision: 1 }),
    });
  });
  return () => creates;
}

test('AC-FE-R2c3-11 P2-3 申请第二步 409：重读真实草稿，按服务端草稿 revision 重提', async ({ page }) => {
  const { server } = await setup(page);
  const creates = await draftCreation(page, server);
  const sent: ReturnType<typeof posted>[] = [];
  await page.route(`**/employment/retirements/${draftId}/submit`, (route) => {
    sent.push(posted(route.request()));
    if (sent.length === 1) {
      server.billRevision = 2;
      return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT', message: '版本冲突' } } });
    }
    server.billRevision = 3;
    return route.fulfill({
      json: business({ id: draftId, mode: 'application', status: 'in_review', revision: 3 }),
    });
  });
  await enter(page, '退休申请');
  await previewWith(page, '2026-11-29');
  await dialog(page)
    .getByRole('button', { name: /提\s*交/ })
    .click();
  const resume = dialog(page).getByRole('button', { name: '已核对差异，继续编辑' });
  await expect(resume).toBeVisible();
  await resume.click();
  await dialog(page)
    .getByRole('button', { name: /提\s*交/ })
    .click();
  await expect(page.getByText('退休申请提交成功')).toBeVisible();
  expect(sent.map((item) => [item.body, item.ifMatch])).toEqual([
    [{}, '1'],
    [{}, '2'],
  ]);
  expect(creates()).toBe(1);
});

test('AC-FE-R2c3-12 P2-3 申请第二步结果未知：关闭重开仍是同一草稿，回查原单查草稿而不是员工', async ({ page }) => {
  const { server } = await setup(page);
  const creates = await draftCreation(page, server);
  let submits = 0;
  await page.route(`**/employment/retirements/${draftId}/submit`, (route) => {
    submits += 1;
    return route.abort('connectionreset');
  });
  await enter(page, '退休申请');
  await previewWith(page, '2026-11-29');
  await dialog(page)
    .getByRole('button', { name: /提\s*交/ })
    .click();
  await expect(dialog(page).getByText(/结果待确认/)).toBeVisible();
  await dialog(page)
    .getByRole('button', { name: /取\s*消/ })
    .click();
  await page.getByRole('button', { name: '退休申请', exact: true }).click();
  await expect(dialog(page).getByText(/结果待确认/)).toBeVisible();
  await expect(dialog(page).getByText(/申请已保存，继续提交同一申请/)).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: /提\s*交/ })).toBeDisabled();
  const reads: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'GET' && request.url().includes('/employment/'))
      reads.push(new URL(request.url()).pathname);
  });
  await dialog(page).getByRole('button', { name: '回查原单', exact: true }).click();
  await expect.poll(() => reads.length).toBeGreaterThan(0);
  expect(reads).toContain(`/api/tenant/employment/businesses/${draftId}`);
  expect(reads.some((path) => path.endsWith(`/employees/${employee}`))).toBe(false);
  expect([creates(), submits]).toEqual([1, 1]);
});

test('AC-FE-R2c3-13 P2-5 撤销成功后展示服务端返回的下游清单，动作刷新后不丢', async ({ page }) => {
  const { server } = await setup(page);
  await page.route(`**/employment/retirements/${billId}/cancel`, (route) => {
    const cancellation = {
      id: '80000000-0000-4000-8000-000000000001',
      case: 'record_deleted_reinstated',
      stateBefore: 'effective',
      reason: '合成撤销原因',
      revision: 1,
      createdAt: '2026-10-30T00:00:00.000Z',
    };
    server.billRevision = 3;
    server.views.completed = [];
    server.views.all = [bill('deleted', { revision: 3, cancellation })];
    // trimDownstream：可见目标只回 type / id / detail，不可见只计 hiddenCount；四类固定在前，附加项在后
    const downstream = {
      items: [
        {
          kind: 'contract',
          status: 'found',
          targets: [
            { type: 'contract', id: '90000000-0000-4000-8000-000000000001', detail: { effect: 'contract_terminated' } },
          ],
          hiddenCount: 0,
        },
        { kind: 'duty_transfer', status: 'none', targets: [], hiddenCount: 0 },
        { kind: 'handover', status: 'none', targets: [], hiddenCount: 0 },
        { kind: 'payroll', status: 'not_connected', targets: [], hiddenCount: 0 },
      ],
      additional: [
        {
          kind: 'application_voided',
          action: 'reinitiate',
          targets: [{ type: 'employment-business', id: draftId, detail: { effect: 'application_voided' } }],
          hiddenCount: 1,
        },
      ],
    };
    return route.fulfill({ json: { ...business({ status: 'deleted', revision: 3 }), cancellation, downstream } });
  });
  await openRow(page, 'completed');
  const drawer = page.locator('.ant-drawer');
  await drawer.getByRole('button', { name: '撤销退休', exact: true }).click();
  await dialog(page).getByLabel('撤销原因').fill('合成撤销原因');
  await confirm(page);
  await expect(page.getByText('已撤销退休')).toBeVisible();
  // 撤销后单据带撤销记录，撤销按钮随刷新卸载；清单留在详情层
  await expect(drawer.getByRole('button', { name: '撤销退休', exact: true })).toHaveCount(0);
  const list = drawer.getByRole('region', { name: '撤销退休后的下游数据' });
  await expect(list).toBeVisible();
  await expect(list.getByText('合同：有记录（1 件）')).toBeVisible();
  await expect(list.getByText('薪资档案：未接入')).toBeVisible();
  await expect(list.getByText('被作废的在途任职申请：需重新发起（2 件，其中 1 件无权查看）')).toBeVisible();
  // DEC-714：前端不补“合同需手工处理 / 已恢复”等文案，也不推算账号状态
  await expect(drawer.getByText(/手工|已恢复|账号/)).toHaveCount(0);
});
