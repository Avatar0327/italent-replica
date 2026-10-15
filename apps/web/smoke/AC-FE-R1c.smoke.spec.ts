import { test, expect, user, employee, snapshotFixture } from './fixtures.js';
import type { Page } from '@playwright/test';

test.use({ viewport: { width: 1440, height: 900 } });

const instance = '40000000-0000-4000-8000-000000000001';
const task = '50000000-0000-4000-8000-000000000001';
test.beforeEach(async ({ page }) => {
  await page.route('**/permission/me/objects/TenantBase.EmploymentRecord', (route) =>
    route.fulfill({
      json: {
        objectCode: 'TenantBase.EmploymentRecord',
        dataOperations: { read: true },
        viewableFields: ['name'],
        editableFields: [],
        buttons: [{ buttonCode: 'Transfer.Hr', level: 'detail' }],
      },
    }),
  );
  await page.route('**/api/tenant/approval/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/todos'))
      return route.fulfill({
        json: {
          items: [
            {
              taskId: task,
              instanceId: instance,
              title: '合成员工的调动申请',
              nodeName: '部门负责人审批',
              approvalType: 'transfer',
              createdAt: '2026-10-12T01:00:00Z',
            },
          ],
        },
      });
    if (path.endsWith('/instances'))
      return route.fulfill({
        json: {
          items: [
            {
              id: instance,
              title: '合成员工的调动申请',
              status: 'running',
              approvalType: 'transfer',
              revision: 4,
            },
          ],
        },
      });
    return route.fulfill({ json: detail() });
  });
  await transferFixtures(page);
});
// 与 GET /approval/instances/:id 同形；动作接口成功时也返回这份详情（routes.ts respondOutcome → respondDetail）。
function detail(revision = 4, status = 'running') {
  return {
    id: instance,
    title: '合成员工的调动申请',
    revision,
    status,
    approvalType: 'transfer',
    actions: status === 'running' ? ['approve', 'reject', 'transfer', 'withdraw'] : [],
    recordsHidden: false,
    form: { values: { effectiveDate: '2026-11-01', place: '合成工作地' }, originals: { place: '原工作地' } },
    tasks: [{ id: task, nodeName: '部门负责人审批', status: 'pending', assigneeUserId: user }],
    logs: [],
  };
}
const button = (label: string) => new RegExp(`^${label.split('').join('\\s*')}$`);
async function openTodo(page: Page) {
  await page.getByRole('button', { name: '合成员工的调动申请', exact: true }).click();
  await expect(page.getByRole('heading', { name: '合成员工的调动申请', exact: true })).toBeVisible();
}

test('AC-FE-R1c-03 调动列表、表单、我的申请与注释', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await switchIdentity(page, '/transfer');
  await expect(page.getByRole('button', { name: '调动中员工', exact: true, pressed: true })).toBeVisible();
  await expect(page.locator('.r1c-reference').getByText('演示数据', { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('transfer-list.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '林晓（合成）', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('企业服务事业部');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '他人调动申请', exact: true }).click();
  await page.locator('select[name="employeeId"]').selectOption(employee);
  await expect(page.locator('input[name="place"]')).toBeVisible();
  await expect(page.getByRole('button', { name: /提\s*交/, exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('transfer-form.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '返回调动管理', exact: true }).click();
  await expect(page.getByRole('button', { name: '调动中员工', exact: true, pressed: true })).toBeVisible();
  await openSection(page, '我的申请');
  await page.getByRole('button', { name: '合成员工的调动申请', exact: true }).click();
  await expect(page.getByText('合成工作地', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: button('返回') }).click();
  await expect(page.getByRole('heading', { name: '我的申请', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('AC-FE-R1c-04 我的待办三个分类、卡片、当前页详情与操作弹窗', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await switchIdentity(page, '/approval');
  await expect(page.getByRole('heading', { name: '待处理', exact: true })).toBeVisible();
  await expect(page.locator('.ant-spin-blur')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '审批分类' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '我的委托', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '流程管理', exact: true })).toHaveCount(0);
  await expect(page.locator('.approval-card').getByRole('checkbox')).toBeDisabled();
  await expect(page.getByRole('button', { name: '去处理', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('approval-list.png'), fullPage: true, animations: 'disabled' });
  await openTodo(page);
  await expect(page.getByText('原：原工作地', { exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: '操作记录(1)' })).toBeVisible();
  await expect(page.getByRole('button', { name: '流程管理', exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('approval-detail.png'), fullPage: true, animations: 'disabled' });
  for (const action of ['同意', '驳回', '转交', '撤销']) {
    await page
      .getByRole('button', { name: button(action) })
      .first()
      .click();
    await expect(page.getByRole('dialog').last()).toBeVisible();
    await page.getByRole('button', { name: button('取消') }).click();
  }
  await expect(page.getByRole('button', { name: button('不同意') })).toHaveCount(0);
  await page.getByRole('button', { name: button('返回') }).click();
  await page.getByRole('button', { name: '已处理', exact: true }).click();
  await expect(page.getByRole('heading', { name: '已处理', exact: true })).toBeVisible();
  await expect(page.locator('.r1c-reference').getByText('演示数据', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '合成员工林晓的调动申请', exact: true }).click();
  await expect(page.getByText('审批已通过，业务是否生效以业务申请单为准。')).toBeVisible();
  await expect(page.getByRole('button', { name: button('同意') })).toHaveCount(0);
  await page.getByRole('button', { name: button('返回') }).click();
  await page.getByRole('button', { name: '已申请', exact: true }).click();
  await expect(page.getByRole('button', { name: '合成员工的调动申请', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '查看详情', exact: true })).toBeVisible();
  await page.getByRole('switch', { name: '注释' }).click();
  await expect(page.getByText('DEC-057', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

for (const [label, action] of [
  ['同意', 'approve'],
  ['驳回', 'reject'],
  ['转交', 'transfer'],
  ['撤销', 'withdraw'],
]) {
  test(`AC-FE-R1c-06 ${label} 使用真实命令协议并重新读取列表`, async ({ page }) => {
    const requests: { path: string; body: unknown; revision?: string; command?: string }[] = [];
    await page.route(`**/api/tenant/approval/**/${action}`, (route) => {
      requests.push({
        path: new URL(route.request().url()).pathname,
        body: route.request().postDataJSON(),
        revision: route.request().headers()['if-match'],
        command: route.request().headers()['idempotency-key'],
      });
      return route.fulfill({ json: detail(5, action === 'withdraw' ? 'withdrawn' : 'approved') });
    });
    const reloads = page.waitForRequest((request) => request.url().includes('/approval/todos?'));
    await switchIdentity(page, '/approval');
    await reloads;
    await openTodo(page);
    await page.getByRole('button', { name: button(label!) }).click();
    if (action === 'transfer') await page.getByLabel('转交给（账号编号）').fill(user);
    const listed = page.waitForRequest((request) => request.url().includes('/approval/todos?'));
    await page.getByRole('button', { name: button('保存') }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await listed;
    await expect(page.getByRole('heading', { name: '待处理', exact: true })).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.revision).toBe('4');
    expect(requests[0]?.command).toMatch(/^[\da-f-]{36}$/);
    expect(requests[0]?.path).toBe(
      `/api/tenant/approval/${action === 'withdraw' ? `instances/${instance}` : `tasks/${task}`}/${action}`,
    );
    expect(requests[0]?.body).toEqual(
      action === 'withdraw' ? {} : { comment: null, ...(action === 'transfer' ? { toUserId: user } : {}) },
    );
  });
}

test('AC-FE-R1c-07 结果未知锁定：不能重提或换动作，关闭重开与回查原单后仍锁定', async ({ page }) => {
  let writes = 0;
  await page.route('**/api/tenant/approval/tasks/*/approve', (route) => {
    writes++;
    return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE' } } });
  });
  await switchIdentity(page, '/approval');
  await openTodo(page);
  await page.getByRole('button', { name: button('同意') }).click();
  await page.getByRole('button', { name: button('保存') }).click();
  await expect(page.getByText('处理中 / 结果待确认。当前表单已锁定，请勿重新创建命令。')).toBeVisible();
  await expect(page.getByRole('button', { name: button('保存') })).toBeDisabled();
  await page.getByRole('button', { name: button('取消') }).click();
  await expect(page.getByText('本单有未确认的“同意”操作，请打开核对结果；确认前不能发起其他操作。')).toBeVisible();
  for (const other of ['驳回', '转交', '撤销'])
    await expect(page.getByRole('button', { name: button(other) })).toBeDisabled();
  await page.getByRole('button', { name: button('返回') }).click();
  await openTodo(page);
  await page.getByRole('button', { name: button('同意') }).click();
  await expect(page.getByText('处理中 / 结果待确认。当前表单已锁定，请勿重新创建命令。')).toBeVisible();
  await page.getByRole('button', { name: '回查原单', exact: true }).click();
  await expect(page.getByText('原单当前值（仅供核对，不能据此确认本次命令结果）')).toBeVisible();
  await expect(page.getByRole('button', { name: button('保存') })).toBeDisabled();
  expect(writes).toBe(1);
});

test('AC-FE-R1c-07c DEC-502①(a) 回执 revision 未超过本次提交按结果未知锁定，不提示成功', async ({ page }) => {
  let writes = 0;
  await page.route(`**/api/tenant/approval/instances/${instance}`, (route) => route.fulfill({ json: detail() }));
  await page.route('**/api/tenant/approval/tasks/*/approve', (route) => {
    writes++;
    return route.fulfill({ json: detail(4, 'approved') });
  });
  await switchIdentity(page, '/approval');
  await openTodo(page);
  await page.getByRole('button', { name: button('同意') }).click();
  await page.getByRole('button', { name: button('保存') }).click();
  await expect(page.getByText('处理中 / 结果待确认。当前表单已锁定，请勿重新创建命令。')).toBeVisible();
  await expect(page.getByRole('button', { name: button('保存') })).toBeDisabled();
  expect(writes).toBe(1);
});

test('AC-FE-R1c-07b 版本冲突与结果未知分开：重读最新版本后按新 revision 重提', async ({ page }) => {
  const revisions: (string | undefined)[] = [];
  let revision = 4;
  await page.route(`**/api/tenant/approval/instances/${instance}`, (route) =>
    route.fulfill({ json: detail(revision) }),
  );
  await page.route('**/api/tenant/approval/tasks/*/approve', (route) => {
    revisions.push(route.request().headers()['if-match']);
    if (revisions.length === 1) {
      revision = 5;
      return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT', message: '已被他人修改' } } });
    }
    return route.fulfill({ json: detail(6, 'approved') });
  });
  await switchIdentity(page, '/approval');
  await openTodo(page);
  await page.getByRole('button', { name: button('同意') }).click();
  await page.getByLabel('审批意见').fill('合成审批意见');
  await page.getByRole('button', { name: button('保存') }).click();
  await expect(page.getByText('版本冲突：输入已保留，请重读最新版本并核对差异后重提。')).toBeVisible();
  await expect(page.getByText('处理中 / 结果待确认。当前表单已锁定，请勿重新创建命令。')).toHaveCount(0);
  await page.getByRole('button', { name: '重读最新版本', exact: true }).click();
  await page.getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
  await expect(page.getByLabel('审批意见')).toHaveValue('合成审批意见');
  await page.getByRole('button', { name: button('保存') }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(revisions).toEqual(['4', '5']);
});

test('AC-FE-R1c-08 撤权隐藏发起按钮，审批字段与记录按返回值裁剪', async ({ page }) => {
  await page.route('**/permission/me/objects/TenantBase.EmploymentRecord', (route) =>
    route.fulfill({
      json: {
        objectCode: 'TenantBase.EmploymentRecord',
        dataOperations: { read: true },
        viewableFields: [],
        editableFields: [],
        buttons: [],
      },
    }),
  );
  await switchIdentity(page, '/transfer');
  await expect(page.getByRole('button', { name: '调动中员工', exact: true, pressed: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '他人调动申请', exact: true })).toHaveCount(0);
  await page.route(`**/approval/instances/${instance}`, (route) =>
    route.fulfill({
      json: {
        id: instance,
        title: '裁剪后的申请',
        revision: 1,
        status: 'running',
        approvalType: 'transfer',
        actions: ['transfer'],
        recordsHidden: true,
        form: { values: {} },
        tasks: [],
        logs: [],
      },
    }),
  );
  await page.goto('/approval');
  await page.getByRole('button', { name: '合成员工的调动申请', exact: true }).click();
  await expect(page.getByRole('heading', { name: '裁剪后的申请', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: button('同意') })).toHaveCount(0);
  await expect(page.getByRole('button', { name: button('转交') })).toBeVisible();
  await expect(page.getByText('合成工作地', { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: /^操作记录/ }).click();
  await expect(page.getByText('根据流程设置，当前查看人不可查看审批记录。')).toBeVisible();
});

async function transferFixtures(page: Page) {
  await page.route('**/employment/transfers/catalog**', (route) =>
    route.fulfill({
      json: {
        today: '2026-10-12',
        types: [{ code: 'transfer', name: '部门间调动', formId: 'hr' }],
        reasons: [],
        viewableFields: ['effectiveDate', 'transferTypeCode', 'reasonCode'],
        editableFields: ['effectiveDate', 'transferTypeCode', 'reasonCode'],
      },
    }),
  );
  await page.route('**/employment/employees?**', (route) =>
    route.fulfill({ json: { items: [{ id: employee, name: '合成员工', code: 'DEMO-001', revision: 3 }] } }),
  );
  await page.route('**/transfers/employees/*/preview', (route) =>
    route.fulfill({
      json: {
        employeeRevision: 3,
        allowDirectTransfer: false,
        allowedActions: { application: true },
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
}

async function switchIdentity(page: Page, path: string) {
  await page.goto(path);
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.waitForURL('**/staff');
  await page.goto(path);
  // 列表标题行按原站隐藏（标题位是横向视图 / 分类栏），改等页面根节点。
  await expect(page.locator('.hr-transfer-page, .approval-page').first()).toBeVisible({ timeout: 15_000 });
}

test('AC-FE-R1c-10 横向视图、浅蓝提示、主题密度与当前页审批分类', async ({ page }) => {
  // 管理员子页（流程管理 / 管理员委托）只在审批中心入口对象含流程实例时出现。
  await page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        apps: snapshotFixture.apps.map((app) =>
          app.app === 'approval' ? { ...app, entryObjects: ['TenantBase.ApprovalInstance'] } : app,
        ),
      },
    }),
  );
  await switchIdentity(page, '/transfer');
  await expect(page.locator('.ant-breadcrumb')).toBeHidden();
  const views = page.getByRole('navigation', { name: '调动管理视图' });
  await views.getByRole('button', { name: '全部调动记录', exact: true }).click();
  await expect(page).toHaveURL(/view=all/);
  await expect(views.getByRole('button', { name: '全部调动记录', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(views.getByRole('button', { name: '全部调动记录', exact: true })).toHaveCSS(
    'color',
    'rgb(20, 110, 255)',
  );
  await page.getByRole('button', { name: '关闭提示' }).click();
  await expect(page.locator('.transfer-banner')).toHaveCount(0);
  const launch = page.getByRole('button', { name: '他人调动申请', exact: true });
  await expect(launch).toHaveCSS('background-color', 'rgb(20, 110, 255)');
  await expect(launch).toHaveCSS('height', '32px');
  await expect(page.locator('.ant-table-thead > tr')).toHaveCSS('height', '40px');
  await expect(page.locator('.ant-pagination-options')).toContainText('15');
  await page.getByRole('button', { name: '林晓（合成）', exact: true }).click();
  await expect(page.locator('.ant-drawer-right')).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  const pending = page.waitForRequest(
    (request) =>
      request.url().includes('/approval/todos?') && new URL(request.url()).searchParams.get('pageSize') !== '1',
  );
  await page.goto('/approval');
  expect(new URL((await pending).url()).searchParams.get('pageSize')).toBe('15');
  await expect(page.locator('.ant-breadcrumb')).toBeHidden();
  const categories = page.getByRole('navigation', { name: '审批分类' });
  await categories.getByRole('button', { name: '已处理', exact: true }).click();
  await expect(page).toHaveURL(/view=completed/);
  await expect(page.getByRole('heading', { name: '已处理', exact: true })).toBeVisible();
  for (const section of ['我的委托', '流程管理', '管理员委托']) {
    await page.getByRole('menuitem', { name: section, exact: true }).click();
    await expect(page.getByText('接口待补齐').first()).toBeVisible();
  }
});

const draftId = '60000000-0000-4000-8000-000000000001';
const draftResult = { id: draftId, revision: 1, employeeRevision: 4, status: 'draft' };
async function hrRecoveryFixture(page: Page) {
  await page.route('**/employment/businesses/' + draftId, (route) =>
    route.fulfill({
      json: {
        ...draftResult,
        effectiveDate: '2026-10-12',
        fields: { place: '暂存工作地' },
        customFields: {},
      },
    }),
  );
  await page.route('**/transfers/*/linkage', (route) =>
    route.fulfill({
      json: {
        businessId: draftId,
        executedAt: null,
        contract: null,
        onTrial: null,
        handover: null,
        salaryReminder: null,
        dutyTransfer: null,
        partTimes: [],
      },
    }),
  );
}
async function openHr(page: Page) {
  await page.getByRole('button', { name: '他人调动申请', exact: true }).click();
}

// 左侧只列当前应用菜单，跨应用经顶栏全部菜单面板进入（同 AC-FE-0）；页面内状态不因整页刷新丢失。
async function openApp(page: Page, label: string) {
  await page.getByRole('button', { name: '应用导航' }).click();
  await page.getByRole('dialog', { name: '全部菜单' }).getByRole('link', { name: label, exact: true }).click();
}
async function openSection(page: Page, label: string) {
  await openApp(page, '审批中心');
  const title = page.locator('.shell-sidebar .ant-menu-submenu-title', { hasText: '审批中心' });
  if ((await title.getAttribute('aria-expanded')) !== 'true') await title.click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
  await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
}

// DEC-464 取消原命令恢复；保留原有防重与同单提交断言，改从“我的申请”进入。
async function openMyDraft(page: Page) {
  await openSection(page, '我的申请');
  await page.getByRole('button', { name: '查看暂存申请 1', exact: true }).click();
}
// 表单为当前页全页；返回列表即卸载表单（原先是关闭抽屉）。
async function closeHr(page: Page) {
  await page.getByRole('button', { name: '返回调动管理', exact: true }).click();
}
async function saveDraft(page: Page) {
  await switchIdentity(page, '/transfer');
  await openHr(page);
  await page.locator('select[name="employeeId"]').selectOption(employee);
  await page.getByRole('button', { name: '暂存', exact: true }).click();
  await expect(page.getByText('暂存成功，请在我的申请中查看')).toBeVisible();
  await closeHr(page);
}
const processing = '处理中，请在我的申请中查看';
async function expectReadonly(page: Page) {
  await expect(page.getByText(processing, { exact: true }).last()).toBeVisible();
  await expect(page.getByRole('button', { name: '恢复原命令', exact: true })).toHaveCount(0);
  await expect(page.locator('.r1c-transfer-form').locator('input, select, button[type="submit"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '暂存', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '提交暂存申请', exact: true })).toHaveCount(0);
}

test('AC-FE-R1c-11 DEC-464 我的申请打开暂存单，读取完整选项后提交同单', async ({ page }) => {
  await hrRecoveryFixture(page);
  await page.route('**/employment/businesses/' + draftId, (route) =>
    route.fulfill({
      json: {
        ...draftResult,
        withEstablishment: true,
        fields: { place: '暂存工作地' },
        customFields: {},
      },
    }),
  );
  await page.route('**/transfers/*/linkage', (route) =>
    route.fulfill({
      json: {
        businessId: draftId,
        revision: 1,
        options: { adjustSalary: true, contract: null, onTrial: { months: 3 } },
      },
    }),
  );
  let creates = 0;
  const submitted: { path: string; body: unknown; revision?: string }[] = [];
  await page.route('**/transfers/employees/' + employee, (route) => {
    creates++;
    return route.fulfill({ json: draftResult });
  });
  await page.route('**/employment/businesses/*/submit', (route) => {
    submitted.push({
      path: new URL(route.request().url()).pathname,
      body: route.request().postDataJSON(),
      revision: route.request().headers()['if-match'],
    });
    return route.fulfill({ json: { ...draftResult, revision: 2, status: 'in_review' } });
  });
  await saveDraft(page);
  await page.reload();
  await openMyDraft(page);
  await expect(page.getByTestId('draft-field-withEstablishment')).toContainText('是');
  await expect(page.getByTestId('draft-field-adjustSalary')).toContainText('是');
  await expect(page.getByTestId('draft-field-onTrial.startDate')).toContainText('未读取');
  await expect(page.getByText('暂存工作地', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '提交暂存申请', exact: true }).click();
  await expect.poll(() => submitted.length).toBe(1);
  expect(submitted[0]).toEqual({
    path: '/api/tenant/employment/businesses/' + draftId + '/submit',
    body: {},
    revision: '1',
  });
  expect(creates).toBe(1);
});

test('AC-FE-R1c-12 DEC-464 创建未知关闭刷新后只读，不再保存命令编号', async ({ page }) => {
  let writes = 0;
  let command = '';
  await page.route('**/transfers/employees/' + employee, (route) => {
    writes++;
    command = route.request().headers()['idempotency-key']!;
    return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE' } } });
  });
  await switchIdentity(page, '/transfer');
  await openHr(page);
  await page.locator('select[name="employeeId"]').selectOption(employee);
  await page.getByRole('button', { name: '暂存', exact: true }).click();
  await expectReadonly(page);
  await closeHr(page);
  await page.reload();
  await openHr(page);
  await expectReadonly(page);
  expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain(command);
  expect(writes).toBe(1);
});

for (const status of [400, 422]) {
  test(`AC-FE-R1c-13 驳回 ${status} 字段错误修正后可直接提交`, async ({ page }) => {
    let writes = 0;
    await page.route('**/approval/tasks/*/reject', (route) => {
      writes++;
      return writes === 1
        ? route.fulfill({ status, json: { error: { code: 'VALIDATION_FAILED', message: '请补充驳回意见' } } })
        : route.fulfill({ json: detail(5, 'returned') });
    });
    await switchIdentity(page, '/approval');
    await page.getByRole('button', { name: '合成员工的调动申请', exact: true }).click();
    await page.getByRole('button', { name: /驳\s*回/, exact: true }).click();
    await page.getByRole('button', { name: /保\s*存/, exact: true }).click();
    await expect.poll(() => writes).toBe(1);
    await page.getByLabel('审批意见').fill('合成驳回说明');
    await page.getByRole('button', { name: /保\s*存/, exact: true }).click();
    await expect.poll(() => writes).toBe(2);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
}

test('AC-FE-R1c-14 DEC-464 暂存读取失败不能提交，缺失选项显示未读取而非否', async ({ page }) => {
  await hrRecoveryFixture(page);
  let readsFail = true;
  await page.route('**/employment/businesses/' + draftId, (route) =>
    readsFail
      ? route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN' } } })
      : route.fulfill({ json: { ...draftResult, fields: { place: '当前权限值' } } }),
  );
  await page.route('**/transfers/employees/' + employee, (route) => route.fulfill({ json: draftResult }));
  await saveDraft(page);
  await openMyDraft(page);
  await expect(page.getByRole('alert').last()).toBeVisible();
  await expect(page.getByRole('button', { name: '提交暂存申请', exact: true })).toHaveCount(0);
  readsFail = false;
  await page.getByRole('button', { name: '重新读取已暂存申请', exact: true }).click();
  await expect(page.getByTestId('draft-field-withEstablishment')).toContainText('未读取');
  await expect(page.getByTestId('draft-field-adjustSalary')).toContainText('未读取');
  await expect(page.getByText('当前权限值', { exact: true })).toBeVisible();
});

test('AC-FE-R1c-15 DEC-464 在途关闭后迟到成功回执不能解除只读保护', async ({ page }) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  await page.route('**/transfers/employees/' + employee, async (route) => {
    writes++;
    await gate;
    await route.fulfill({ json: draftResult });
  });
  await switchIdentity(page, '/transfer');
  await openHr(page);
  await page.locator('select[name="employeeId"]').selectOption(employee);
  await page.getByRole('button', { name: '暂存', exact: true }).click();
  await expect.poll(() => writes).toBe(1);
  try {
    await closeHr(page);
    await openHr(page);
    await expectReadonly(page);
    const response = page.waitForResponse((item) => item.url().endsWith('/transfers/employees/' + employee));
    release();
    await response;
    await closeHr(page);
    await openHr(page);
    await expectReadonly(page);
    expect(writes).toBe(1);
  } finally {
    release();
  }
});

test('AC-FE-R1c-16 DEC-464 暂存提交未知，重开与我的申请均不能再次发命令', async ({ page }) => {
  await hrRecoveryFixture(page);
  await page.route('**/transfers/employees/' + employee, (route) => route.fulfill({ json: draftResult }));
  let writes = 0;
  await page.route('**/employment/businesses/*/submit', (route) => {
    writes++;
    return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE' } } });
  });
  await saveDraft(page);
  await openMyDraft(page);
  await page.getByRole('button', { name: '提交暂存申请', exact: true }).click();
  await expect(page.getByText(processing, { exact: true }).last()).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await openApp(page, '调动管理');
  await openHr(page);
  await expectReadonly(page);
  await closeHr(page);
  await openMyDraft(page);
  await expect(page.getByText(processing, { exact: true }).last()).toBeVisible();
  await expect(page.getByRole('button', { name: '提交暂存申请', exact: true })).toHaveCount(0);
  expect(writes).toBe(1);
});

for (const [status, message] of [
  ['effective', '直接调动已保存并生效。'],
  ['approved', '直接调动已保存，将按调动日期生效。'],
]) {
  test(`AC-FE-R1c-18 DEC-464 简化不改变直接调动 ${status} 回执`, async ({ page }) => {
    await page.route('**/transfers/employees/*/preview', async (route) => {
      const original = {
        employeeRevision: 3,
        form: {
          id: 'hr',
          isStandard: true,
          excludedAutofillFields: [],
          fieldModes: { 'preset:place': 'editable' },
          customFields: [],
        },
        fields: { place: '合成工作地' },
        customFields: {},
        before: null,
      };
      await route.fulfill({
        json: { ...original, allowDirectTransfer: true, allowedActions: { application: true, directList: true } },
      });
    });
    await page.route('**/transfers/employees/' + employee, (route) =>
      route.fulfill({ json: { ...draftResult, status } }),
    );
    await switchIdentity(page, '/transfer');
    await openHr(page);
    await page.locator('select[name="employeeId"]').selectOption(employee);
    await page.getByRole('button', { name: '直接调动', exact: true }).click();
    await expect(page.getByText(message!, { exact: true })).toBeVisible();
  });
}

for (const returned of [true, false]) {
  test(`AC-FE-R1c-19 DEC-467 部门间调动暂存详情${returned ? '显示返回的异动类型' : '字段缺失显示未读取'}`, async ({
    page,
  }) => {
    await hrRecoveryFixture(page);
    let savedType: unknown;
    await page.route('**/transfers/employees/' + employee, (route) => {
      savedType = route.request().postDataJSON().transferTypeCode;
      return route.fulfill({ json: draftResult });
    });
    await page.route('**/employment/businesses/' + draftId, (route) =>
      route.fulfill({
        json: { ...draftResult, changeType: null, ...(returned ? { transferTypeCode: savedType } : {}) },
      }),
    );
    await saveDraft(page);
    expect(savedType).toBe('transfer'); // catalog 中“部门间调动”的编码。
    await openMyDraft(page);
    const row = page.getByRole('row').filter({ has: page.getByText('异动类型', { exact: true }) });
    await expect(row).toContainText(returned ? 'transfer' : '未读取');
    await expect(row).not.toContainText('无');
  });
}

for (const status of [409, 422]) {
  test(`AC-FE-R1c-21 HR ${status} 拒绝显示原原因、保留输入并允许改正重提`, async ({ page }) => {
    const commands: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    const reason = '该调动日期没有可用流程，请修改后重提';
    await page.route(`**/transfers/employees/${employee}`, (route) => {
      commands.push(route.request().headers()['idempotency-key']!);
      bodies.push(route.request().postDataJSON());
      return commands.length === 1
        ? route.fulfill({ status, json: { error: { code: 'VALIDATION_FAILED', message: reason } } })
        : route.fulfill({ json: draftResult });
    });
    await switchIdentity(page, '/transfer');
    await openHr(page);
    await page.locator('select[name="employeeId"]').selectOption(employee);
    await page.locator('input[name="place"]').fill('合成原工作地');
    await page.getByRole('button', { name: '暂存', exact: true }).click();
    // 他人调动申请为当前页全页表单（原站），拒绝原因显示在表单内。
    await expect(page.locator('.r1c-transfer-form p[role="alert"]')).toContainText(reason);
    await expect(page.locator('input[name="place"]')).toHaveValue('合成原工作地');
    await expect(page.locator('select[name="employeeId"]')).toHaveValue(employee);
    await page.locator('input[name="place"]').fill('合成改正工作地');
    await page.getByRole('button', { name: '暂存', exact: true }).click();
    await expect(page.getByText('暂存成功，请在我的申请中查看')).toBeVisible();
    expect(commands).toHaveLength(2);
    expect(commands[1]).not.toBe(commands[0]);
    expect(bodies[1]).toMatchObject({ fields: { place: '合成改正工作地' } });
  });
}
