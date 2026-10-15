import { test, expect, user, employee } from './fixtures.js';
import type { Page } from '@playwright/test';

// F-153（DEC-511，W-870）：他人调动申请暂存按人一份——重选同一人自动带出、横幅可“点击清除”；我的申请不再列暂存单。
test.use({ viewport: { width: 1440, height: 900 } });

const draftId = '60000000-0000-4000-8000-000000000001';
// POST /transfers/employees/:id 的回执：新建业务单把员工版本从预览的 4 推进到 5，提交再推进一次（write-service）。
const receipt = { id: draftId, revision: 1, employeeRevision: 5, status: 'draft' };
const submittedReceipt = { ...receipt, revision: 2, employeeRevision: 6, status: 'in_review' };
// GET /api/tenant/employment/businesses/:id 的真实形状（read-model.ts）；fields 为完整预置字段快照。
const business = {
  ...receipt,
  employeeId: employee,
  kind: 'transfer',
  changeType: 'position_adjustment',
  mode: 'application',
  formId: 'hr',
  effectiveDate: '2026-10-20',
  fields: { place: '暂存工作地', departmentId: null },
  customFields: {},
  employeeStatus: 'employed',
  entryStatus: null,
  record: null,
  activation: null,
};
// GET /transfers/:id/linkage：options 只含可见联动项（visibleOptions）。
const linkage = {
  businessId: draftId,
  revision: 1,
  options: { adjustSalary: true },
  executedAt: null,
  contract: null,
  salaryReminder: null,
};
const linkageFields = ['effectiveDate', 'transferTypeCode', 'reasonCode', 'adjustSalary', 'withEstablishment'];
const button = (label: string) => new RegExp(`^${label.split('').join('\\s*')}$`);

test.beforeEach(async ({ page }) => {
  await page.route('**/permission/me/objects/TenantBase.EmploymentRecord', (route) =>
    route.fulfill({
      json: {
        objectCode: 'TenantBase.EmploymentRecord',
        dataOperations: { read: true, create: true },
        viewableFields: ['name', 'place'],
        editableFields: ['place'],
        buttons: [{ buttonCode: 'Transfer.Hr', level: 'detail' }],
      },
    }),
  );
  await page.route('**/api/tenant/approval/**', (route) => route.fulfill({ json: { items: [] } }));
  await page.route('**/employment/transfers/catalog**', (route) =>
    route.fulfill({
      json: {
        today: '2026-10-12',
        types: [{ code: 'transfer', name: '部门间调动', formId: 'hr' }],
        reasons: [],
        viewableFields: linkageFields,
        editableFields: linkageFields,
      },
    }),
  );
  await page.route('**/employment/employees?**', (route) =>
    route.fulfill({ json: { items: [{ id: employee, name: '合成员工', code: 'DEMO-001', revision: 3 }] } }),
  );
  await page.route('**/transfers/employees/*/preview', (route) =>
    route.fulfill({
      json: {
        employeeRevision: 4,
        allowDirectTransfer: true,
        allowedActions: { application: true, directList: true },
        form: {
          id: 'hr',
          name: '调动申请',
          isStandard: true,
          excludedAutofillFields: [],
          fieldModes: { 'preset:place': 'editable' },
          customFields: [],
        },
        fields: { place: '合成工作地' },
        customFields: {},
        before: { fields: { place: '原工作地' }, customFields: {} },
      },
    }),
  );
});

interface Backend {
  reads: number;
  creates: Record<string, unknown>[];
}
async function backend(page: Page, read: (route: Parameters<Parameters<Page['route']>[1]>[0]) => Promise<void>) {
  const state: Backend = { reads: 0, creates: [] };
  await page.route('**/employment/businesses/' + draftId, (route) => {
    state.reads++;
    return read(route);
  });
  await page.route('**/transfers/' + draftId + '/linkage', (route) => route.fulfill({ json: linkage }));
  await page.route('**/transfers/employees/' + employee, (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    state.creates.push(body);
    return route.fulfill({ json: body.submit ? submittedReceipt : receipt });
  });
  return state;
}
async function openTransfer(page: Page) {
  await page.goto('/transfer');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.waitForURL('**/staff');
  await page.goto('/transfer');
  await expect(page.locator('.hr-transfer-page').first()).toBeVisible({ timeout: 15_000 });
}
async function pick(page: Page, entry = '他人调动申请') {
  await page.getByRole('button', { name: button(entry) }).click();
  await page.locator('select[name="employeeId"]').selectOption(employee);
  await expect(page.locator('input[name="place"]')).toBeVisible();
}
async function back(page: Page) {
  await page.getByRole('button', { name: '返回调动管理', exact: true }).click();
}
async function stash(page: Page) {
  await openTransfer(page);
  await pick(page);
  await page.getByRole('button', { name: '暂存', exact: true }).click();
  // 只等“暂存成功”出现，原站文案单独断言（AC-FE-F153-07 末尾），使各用例按行为判红绿。
  const notice = page.getByText(/暂存成功/).first();
  await expect(notice).toBeVisible();
  const text = await notice.textContent();
  await back(page);
  return text;
}
// 横幅为“提示文字 + 点击清除”同一段落，按状态区域定位。
const banner = (page: Page) => page.getByRole('status').filter({ hasText: '已带出上次暂存信息' });
const salary = (page: Page, value: 'true' | 'false') => page.locator(`input[name="adjustSalary"][value="${value}"]`);

test('AC-FE-F153-07 暂存后重选同一人自动带出，提交按带出内容发送并不再带出', async ({ page }) => {
  const state = await backend(page, (route) => route.fulfill({ json: business }));
  const notice = await stash(page);
  expect(state.creates[0]).toMatchObject({ submit: false, mode: 'application' });
  await pick(page);
  await expect(page.locator('input[name="place"]')).toHaveValue('暂存工作地');
  await expect(banner(page)).toBeVisible();
  await expect(page.getByRole('button', { name: '点击清除', exact: true })).toBeVisible();
  await expect(page.locator('input[name="effectiveDate"]')).toHaveValue('2026-10-20');
  await expect(salary(page, 'true')).toBeChecked();
  await page.getByRole('button', { name: '提交', exact: true }).click();
  await expect.poll(() => state.creates.length).toBe(2);
  expect(state.creates[1]).toMatchObject({
    submit: true,
    effectiveDate: '2026-10-20',
    transferTypeCode: 'transfer',
    fields: { place: '暂存工作地' },
    linkage: { adjustSalary: true },
  });
  await back(page);
  await pick(page);
  await expect(banner(page)).toHaveCount(0);
  await expect(page.locator('input[name="place"]')).toHaveValue('合成工作地');
  expect(state.reads).toBe(1);
  expect(notice).toBe('信息暂存成功，下次选择此人可自动带出');
});

test('AC-FE-F153-08 点击清除回到空白表单并保留所选人员；再选此人不再带出', async ({ page }) => {
  const state = await backend(page, (route) => route.fulfill({ json: business }));
  await stash(page);
  await pick(page);
  await expect(page.locator('input[name="place"]')).toHaveValue('暂存工作地');
  await page.getByRole('button', { name: '点击清除', exact: true }).click();
  await expect(banner(page)).toHaveCount(0);
  await expect(page.locator('select[name="employeeId"]')).toHaveValue(employee);
  await expect(page.locator('input[name="place"]')).toHaveValue('合成工作地');
  await expect(page.locator('input[name="effectiveDate"]')).toHaveValue('2026-10-12');
  await expect(salary(page, 'false')).toBeChecked();
  await back(page);
  await pick(page);
  await expect(banner(page)).toHaveCount(0);
  expect(state.reads).toBe(1);
});

test('AC-FE-F153-09 我的申请不再列出本会话暂存单', async ({ page }) => {
  await backend(page, (route) => route.fulfill({ json: business }));
  await stash(page);
  await page.goto('/approval');
  await page.getByRole('button', { name: '应用导航' }).click();
  await page.getByRole('dialog', { name: '全部菜单' }).getByRole('link', { name: '审批中心', exact: true }).click();
  await page.getByRole('menuitem', { name: '我的申请', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的申请', exact: true })).toBeVisible();
  await expect(page.getByText('本会话暂存单', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /查看暂存申请/ })).toHaveCount(0);
});

test('AC-FE-F153-10 暂存已不是草稿（他处已提交）时不带出，也不再回查', async ({ page }) => {
  const state = await backend(page, (route) => route.fulfill({ json: { ...business, status: 'in_review' } }));
  await stash(page);
  await pick(page);
  await expect.poll(() => state.reads).toBe(1);
  await expect(banner(page)).toHaveCount(0);
  await expect(page.locator('input[name="place"]')).toHaveValue('合成工作地');
  await back(page);
  await pick(page);
  await expect(page.locator('input[name="place"]')).toHaveValue('合成工作地');
  expect(state.reads).toBe(1);
});

test('AC-FE-F153-11 读取暂存失败（403）提示未带出，表单为空白且仍可暂存', async ({ page }) => {
  const state = await backend(page, (route) =>
    route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN', message: '无权查看' } } }),
  );
  await stash(page);
  await pick(page);
  await expect(page.getByText('上次暂存信息读取失败，未带出，可直接填写', { exact: true })).toBeVisible();
  await expect(banner(page)).toHaveCount(0);
  await expect(page.locator('input[name="place"]')).toHaveValue('合成工作地');
  await expect(page.locator('input[name="effectiveDate"]')).toHaveValue('2026-10-12');
  await expect(page.getByRole('button', { name: '暂存', exact: true })).toBeEnabled();
  expect(state.reads).toBe(1);
});

test('AC-FE-F153-12 “调动”入口（直接调动）没有暂存，选同一人不带出暂存', async ({ page }) => {
  const state = await backend(page, (route) => route.fulfill({ json: business }));
  await stash(page);
  await pick(page, '调动');
  await expect(banner(page)).toHaveCount(0);
  await expect(page.locator('input[name="place"]')).toHaveValue('合成工作地');
  expect(state.reads).toBe(0);
});

// #350 第 1 轮 P2-1：多个异动类型共用一个表单（formId 相同），只看单据表单定不了类型。
const sharedTypes = [
  { code: 'place', name: '工作地调整', formId: 'hr' },
  { code: 'inner', name: '部门内调岗', formId: 'hr' },
];
async function sharedCatalog(page: Page) {
  await page.route('**/employment/transfers/catalog**', (route) =>
    route.fulfill({
      json: {
        today: '2026-10-12',
        types: sharedTypes,
        reasons: [],
        viewableFields: linkageFields,
        editableFields: linkageFields,
      },
    }),
  );
}
const typeSelect = (page: Page) => page.locator('select[name="transferTypeCode"]');
async function stashAs(page: Page, type: string) {
  await openTransfer(page);
  await pick(page);
  await typeSelect(page).selectOption(type);
  await expect(page.locator('input[name="place"]')).toBeVisible();
  await page.getByRole('button', { name: '暂存', exact: true }).click();
  await expect(page.getByText(/暂存成功/).first()).toBeVisible();
  await back(page);
}

test('AC-FE-F153-13 #350 P2-1 多类型共用表单：重选同一人按暂存时的类型带出，提交带同一类型', async ({ page }) => {
  await sharedCatalog(page);
  const state = await backend(page, (route) => route.fulfill({ json: business }));
  await stashAs(page, 'inner');
  expect(state.creates[0]).toMatchObject({ submit: false, transferTypeCode: 'inner' });
  await pick(page);
  await expect(banner(page)).toBeVisible();
  await expect(typeSelect(page)).toHaveValue('inner');
  await expect(page.locator('input[name="place"]')).toHaveValue('暂存工作地');
  await page.getByRole('button', { name: '提交', exact: true }).click();
  await expect.poll(() => state.creates.length).toBe(2);
  expect(state.creates[1]).toMatchObject({ submit: true, transferTypeCode: 'inner', fields: { place: '暂存工作地' } });
});

test('AC-FE-F153-14 #350 P2-1 取不到暂存类型时不默认第一项：留空提示重选，选定前不能暂存或提交', async ({ page }) => {
  await sharedCatalog(page);
  const state = await backend(page, (route) => route.fulfill({ json: business }));
  await stashAs(page, 'inner');
  // 只记单号的会话条目（F-153 第 1 版写入的形状）：没有类型可还原。
  await page.evaluate((id) => {
    const key = Object.keys(sessionStorage).find((item) => item.startsWith('italent.transfer.l2:'))!;
    const value = JSON.parse(sessionStorage.getItem(key)!) as { drafts: Record<string, unknown> };
    sessionStorage.setItem(key, JSON.stringify({ ...value, drafts: { [Object.keys(value.drafts)[0]!]: id } }));
  }, draftId);
  await page.getByRole('button', { name: button('他人调动申请') }).click();
  await page.locator('select[name="employeeId"]').selectOption(employee);
  await expect(page.getByText('无法确定上次暂存的异动类型，请重新选择异动类型后再暂存或提交')).toBeVisible();
  await expect(typeSelect(page)).toHaveValue('');
  await expect(page.getByRole('button', { name: '提交', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '暂存', exact: true })).toBeDisabled();
  await typeSelect(page).selectOption('inner');
  await expect(page.getByText('无法确定上次暂存的异动类型', { exact: false })).toHaveCount(0);
  await expect(page.locator('input[name="place"]')).toHaveValue('暂存工作地');
  await page.getByRole('button', { name: '提交', exact: true }).click();
  await expect.poll(() => state.creates.length).toBe(2);
  expect(state.creates[1]).toMatchObject({ submit: true, transferTypeCode: 'inner', fields: { place: '暂存工作地' } });
});

test('AC-FE-F153-15 #350 P2-2 提交遇 409：锁定、重读核对差异后保留带出字段，按最新版本重提', async ({ page }) => {
  const state = await backend(page, (route) => route.fulfill({ json: business }));
  await stash(page);
  let revision = 4;
  await page.route('**/transfers/employees/*/preview', (route) =>
    route.fulfill({
      json: {
        employeeRevision: revision,
        allowDirectTransfer: true,
        allowedActions: { application: true, directList: true },
        form: {
          id: 'hr',
          name: '调动申请',
          isStandard: true,
          excludedAutofillFields: [],
          fieldModes: { 'preset:place': 'editable' },
          customFields: [],
        },
        fields: { place: '合成工作地' },
        customFields: {},
        before: { fields: { place: revision === 4 ? '原工作地' : '他人改后工作地' }, customFields: {} },
      },
    }),
  );
  const sent: { ifMatch?: string; body: Record<string, unknown> }[] = [];
  await page.route('**/transfers/employees/' + employee, (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push({ ifMatch: route.request().headers()['if-match'], body });
    // 第一次提交时他人已改任职（版本 4 → 5）：服务端回 409，之后的预览即为最新版本。
    if (sent.length === 1) {
      revision = 5;
      return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT', message: '版本冲突' } } });
    }
    return route.fulfill({ json: { ...receipt, revision: 2, employeeRevision: 7, status: 'in_review' } });
  });
  await pick(page);
  await expect(page.locator('input[name="place"]')).toHaveValue('暂存工作地');
  await page.getByRole('button', { name: '提交', exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]!.ifMatch).toBe('4');
  await expect(page.getByText('版本冲突：输入已保留，请重读最新版本并核对差异后重提。')).toBeVisible();
  await expect(page.getByRole('button', { name: '提交', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '重读最新版本', exact: true }).click();
  await expect(page.getByText('他人改后工作地').first()).toBeVisible();
  await page.getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
  await expect(page.locator('input[name="place"]')).toHaveValue('暂存工作地');
  await page.getByRole('button', { name: '提交', exact: true }).click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]!.ifMatch).toBe('5');
  expect(sent[1]!.body).toMatchObject({ submit: true, fields: { place: '暂存工作地' } });
  expect(state.creates).toHaveLength(1);
});

test('AC-FE-F153-16 #350 P2-2 “重新读取表单”换上最新预览，不丢带出的暂存字段', async ({ page }) => {
  await backend(page, (route) => route.fulfill({ json: business }));
  await stash(page);
  await pick(page);
  await expect(page.locator('input[name="place"]')).toHaveValue('暂存工作地');
  await page.getByRole('button', { name: '重新读取表单', exact: true }).click();
  await expect(page.locator('input[name="place"]')).toHaveValue('暂存工作地');
  await expect(banner(page)).toBeVisible();
});

// #350 第 2 轮：按真实接口行为的任职服务端——If-Match 与当前员工版本不符回 409；新建并提交推进两次员工版本。
interface Server {
  revision: number;
  /** 下一次写入到达前他人改到的版本（在写入时推进，避免预览重取先拿到新版本）。 */
  changedBeforeWrite?: number;
  sent: { ifMatch?: string; body: Record<string, unknown> }[];
}
async function employmentServer(page: Page) {
  const server: Server = { revision: 4, sent: [] };
  await page.route('**/transfers/employees/*/preview', (route) =>
    route.fulfill({
      json: {
        employeeRevision: server.revision,
        allowDirectTransfer: true,
        allowedActions: { application: true, directList: true },
        form: {
          id: 'hr',
          name: '调动申请',
          isStandard: true,
          excludedAutofillFields: [],
          fieldModes: { 'preset:place': 'editable' },
          customFields: [],
        },
        fields: { place: '合成工作地' },
        customFields: {},
        before: { fields: { place: `第 ${server.revision} 版工作地` }, customFields: {} },
      },
    }),
  );
  await page.route('**/transfers/employees/' + employee, (route) => {
    const ifMatch = route.request().headers()['if-match'];
    server.sent.push({ ifMatch, body: route.request().postDataJSON() as Record<string, unknown> });
    server.revision = server.changedBeforeWrite ?? server.revision;
    server.changedBeforeWrite = undefined;
    if (ifMatch !== String(server.revision))
      return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT', message: '版本冲突' } } });
    server.revision += 2;
    return route.fulfill({ json: { ...submittedReceipt, employeeRevision: server.revision } });
  });
  return server;
}
/** 他人先把任职改到 5：带出后提交遇 409，重读到 5 并确认；之后他人又改到 6。 */
async function confirmConflict(page: Page, server: Server) {
  await pick(page);
  await expect(page.locator('input[name="place"]')).toHaveValue('暂存工作地');
  server.changedBeforeWrite = 5;
  await page.getByRole('button', { name: '提交', exact: true }).click();
  await expect(page.getByText('版本冲突：输入已保留，请重读最新版本并核对差异后重提。')).toBeVisible();
  await page.getByRole('button', { name: '重读最新版本', exact: true }).click();
  await expect(page.getByText('第 5 版工作地').first()).toBeVisible();
  await page.getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
  await expect(page.locator('input[name="place"]')).toHaveValue('暂存工作地');
  expect(server.sent.map((item) => item.ifMatch)).toEqual(['4']);
  server.revision = 6;
}

test('AC-FE-F153-17 #350 第 2 轮 P2-1 已确认冲突后点击清除重填：按清除后新预览的版本提交', async ({ page }) => {
  await backend(page, (route) => route.fulfill({ json: business }));
  await stash(page);
  const server = await employmentServer(page);
  await confirmConflict(page, server);
  await page.getByRole('button', { name: '点击清除', exact: true }).click();
  await expect(page.locator('input[name="effectiveDate"]')).toHaveValue('2026-10-12');
  await expect(page.locator('input[name="place"]')).toHaveValue('合成工作地');
  await page.locator('input[name="place"]').fill('重填工作地');
  await page.getByRole('button', { name: '提交', exact: true }).click();
  await expect.poll(() => server.sent.length).toBe(2);
  expect(server.sent[1]!.ifMatch).toBe('6');
  expect(server.sent[1]!.body).toMatchObject({ submit: true, fields: { place: '重填工作地' } });
  await expect(page.getByText('调动申请已提交审批。')).toBeVisible();
});

test('AC-FE-F153-18 #350 第 2 轮 P2-1 已确认冲突后换人再换回：按换回后新预览的版本提交', async ({ page }) => {
  const other = '30000000-0000-4000-8000-000000000002';
  await page.route('**/employment/employees?**', (route) =>
    route.fulfill({
      json: {
        items: [
          { id: employee, name: '合成员工', code: 'DEMO-001', revision: 3 },
          { id: other, name: '合成员工乙', code: 'DEMO-002', revision: 1 },
        ],
      },
    }),
  );
  await backend(page, (route) => route.fulfill({ json: business }));
  await stash(page);
  const server = await employmentServer(page);
  await confirmConflict(page, server);
  const reselected = page.waitForResponse((response) => response.url().includes(`/employees/${employee}/preview`));
  await page.locator('select[name="employeeId"]').selectOption(other);
  await expect(banner(page)).toHaveCount(0);
  await page.locator('select[name="employeeId"]').selectOption(employee);
  await reselected;
  await expect(banner(page)).toBeVisible();
  await expect(page.locator('input[name="place"]')).toHaveValue('暂存工作地');
  await page.getByRole('button', { name: '提交', exact: true }).click();
  await expect.poll(() => server.sent.length).toBe(2);
  expect(server.sent[1]!.ifMatch).toBe('6');
  await expect(page.getByText('调动申请已提交审批。')).toBeVisible();
});

test('AC-FE-F153-19 #350 第 2 轮 P2-2 回执员工版本未推进：按结果未知锁定，不报成功、不清暂存索引', async ({ page }) => {
  await backend(page, (route) => route.fulfill({ json: business }));
  await stash(page);
  const sent: (string | undefined)[] = [];
  await page.route('**/transfers/employees/' + employee, (route) => {
    sent.push(route.request().headers()['if-match']);
    // 陈旧回执：业务单 revision 2，员工版本仍是发出的 4，不是本次写入的结果。
    return route.fulfill({ json: { ...receipt, revision: 2, employeeRevision: 4, status: 'in_review' } });
  });
  await pick(page);
  await page.getByRole('button', { name: '提交', exact: true }).click();
  await expect.poll(() => sent).toEqual(['4']);
  await expect(page.getByRole('status').filter({ hasText: '处理中，请在我的申请中查看' })).toBeVisible();
  await expect(page.getByText('调动申请已提交审批。')).toHaveCount(0);
  const drafts = await page.evaluate(() => {
    const key = Object.keys(sessionStorage).find((item) => item.startsWith('italent.transfer.l2:'))!;
    return (JSON.parse(sessionStorage.getItem(key)!) as { drafts: Record<string, unknown> }).drafts;
  });
  expect(Object.values(drafts)).toEqual([expect.objectContaining({ id: draftId })]);
});
