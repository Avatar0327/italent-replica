import { actionButton } from './action-button.js';
import {
  test,
  expect,
  user,
  employee,
  demoRoutes,
  insecureContext,
  seedDemoUser,
  snapshotFixture,
} from './fixtures.js';
import type { Page } from '@playwright/test';

test.use({ viewport: { width: 1440, height: 900 } });

const instance = '40000000-0000-4000-8000-000000000001';
const task = '50000000-0000-4000-8000-000000000001';
test.beforeEach(async ({ page }) => approvalFixtures(page));
/** 审批中心与调动的固定夹具；F-110 双标签页用例在同一上下文另开的页面上也装这一套。 */
async function approvalFixtures(page: Page) {
  await page.route('**/permission/me/objects/TenantBase.EmploymentRecord', (route) =>
    route.fulfill({
      json: {
        objectCode: 'TenantBase.EmploymentRecord',
        // HR 新建调动要 create 与可编辑字段（#333 第 1 轮 P2-2）；Transfer.Hr 只决定入口。
        dataOperations: { read: true, create: true },
        viewableFields: ['name', 'place'],
        editableFields: ['place'],
        buttons: [{ buttonCode: 'Transfer.Hr', level: 'detail' }],
      },
    }),
  );
  let currentView = 'pending';
  await page.route('**/api/tenant/approval/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/todos')) {
      currentView = new URL(route.request().url()).searchParams.get('view') ?? 'pending';
      return route.fulfill({
        json: {
          total: 1,
          categories: [{ key: 'employment', label: '人事变动', count: 1 }],
          items: [
            {
              id: instance,
              status: currentView === 'completed' ? 'approved' : 'running',
              initiatorName: '合成发起人',
              summary: [{ key: 'effectiveDate', label: '调动日期', value: '2026-11-01' }],
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
    }
    if (path.endsWith('/instances'))
      return route.fulfill({ json: { items: [applicationRow('running')], total: 1, page: 1, pageSize: 15 } });
    return route.fulfill({ json: currentView === 'completed' ? detail(5, 'approved') : detail() });
  });
  await transferFixtures(page);
}
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
    // 操作记录取 logs 而非 tasks（#333 第 1 轮 P2-4）：1 个待办任务 + 3 条日志，页签计数应为 3。
    logs: [
      { event: 'start', nodeKey: null, taskId: null, createdAt: '2026-10-12T01:00:00Z' },
      { event: 'transfer', nodeKey: 'leader', taskId: task, createdAt: '2026-10-12T02:00:00Z' },
      { event: 'urge', nodeKey: 'leader', taskId: task, createdAt: '2026-10-12T03:00:00Z' },
    ],
  };
}
// 与 GET /approval/instances?view=applications 同形（AC-APV-F474-3b-applications 固定的键）
const applicationRow = (status: string) => ({
  id: instance,
  title: '合成员工的调动申请',
  status,
  approvalType: 'transfer',
  approvalTypeName: '调动',
  initiatorName: '合成发起人',
  currentHandlers: status === 'running' ? ['合成审批人'] : [],
  createdAt: '2026-10-12T01:00:00Z',
});
const applications = (status: string) => ({ items: [applicationRow(status)], total: 1, page: 1, pageSize: 15 });
const button = (label: string) => new RegExp(`^${label.split('').join('\\s*')}$`);
test('AC-FE-F248 系统撤销详情显示操作人和理由，空 actions 仅可查看', async ({ page }) => {
  const cancelled = {
    ...detail(5, 'cancelled'),
    tasks: [{ id: task, nodeName: '部门负责人审批', status: 'cancelled' }],
    logs: [
      {
        event: 'system_revoke',
        actorUserId: null,
        detail: { comment: '离职业务终止在途审批流程' },
        createdAt: '2026-10-19T10:00:00Z',
      },
    ],
  };
  await page.route(`**/api/tenant/approval/instances/${instance}`, (route) => route.fulfill({ json: cancelled }));
  await page.route('**/api/tenant/approval/instances?**', (route) =>
    route.fulfill({ json: applications('cancelled') }),
  );
  await switchIdentity(page, '/approval/applications');
  await openTodo(page);
  const entry = page.locator('.approval-log');
  await expect(entry.getByText('系统', { exact: true })).toBeVisible();
  await expect(entry.getByText('撤销', { exact: true })).toBeVisible();
  await expect(entry.getByText('离职业务终止在途审批流程', { exact: true })).toBeVisible();
  const header = page.locator('.approval-detail-head');
  for (const label of ['同意', '不同意', '驳回', '催办', '撤回', '撤销', '编辑', '转交'])
    await expect(header.getByRole('button', { name: button(label) })).toHaveCount(0);
  await expect(header).toContainText('当前没有可办理操作');
});

test('AC-FE-F264FE 已处理审批详情显示审批人姓名和系统，旧日志不显示 ID', async ({ page }, testInfo) => {
  const processed = {
    ...detail(5, 'cancelled'),
    tasks: [{ id: task, nodeName: '部门负责人审批', status: 'approved' }],
    logs: [
      {
        event: 'approve',
        taskId: task,
        actorUserId: user,
        actorName: '合成审批人林晓',
        detail: { comment: '合成审批意见' },
        createdAt: '2026-10-19T09:00:00Z',
      },
      {
        event: 'system_revoke',
        actorUserId: null,
        actorName: null,
        detail: { comment: '离职业务终止在途审批流程' },
        createdAt: '2026-10-19T10:00:00Z',
      },
      { event: 'urge', actorUserId: 'synthetic-legacy-actor', createdAt: '2026-10-19T08:00:00Z' },
    ],
  };
  await page.route(`**/api/tenant/approval/instances/${instance}`, (route) => route.fulfill({ json: processed }));
  await page.route('**/api/tenant/approval/instances?**', (route) =>
    route.fulfill({ json: applications('cancelled') }),
  );
  await switchIdentity(page, '/approval/applications');
  await openTodo(page);
  const entries = page.locator('.approval-log');
  await expect(entries).toHaveCount(3);
  await expect(entries.nth(0)).toContainText('合成审批人林晓');
  await expect(entries.nth(0).getByText('同意', { exact: true })).toBeVisible();
  await expect(entries.nth(0)).toContainText('合成审批意见');
  await expect(entries.nth(0)).not.toContainText(user);
  await expect(entries.nth(1).getByText('系统', { exact: true })).toBeVisible();
  await expect(entries.nth(1)).toContainText('撤销');
  await expect(entries.nth(2)).not.toContainText('synthetic-legacy-actor');
  await expect(entries.nth(2)).not.toContainText('系统');
  await page.screenshot({ path: testInfo.outputPath('approval-log-actors.png'), fullPage: true });
});

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
  for (const name of ['标题', '类别', '发起人', '当前处理人', '审批状态', '申请理由', '申请时间'])
    await expect(page.getByRole('columnheader', { name })).toBeVisible();
  await expect(page.getByText('共1条')).toBeVisible();
  await page.getByRole('button', { name: '合成员工的调动申请', exact: true }).click();
  await expect(page.getByText('合成工作地', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: button('返回') }).click();
  await expect(page.getByRole('heading', { name: '我的申请', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

// #333 第 1 轮 P2-1 / P2-5：HR 表单四区块、锚点、是否单选；两个入口的按钮不同。
const linkageCatalog = ['adjustSalary', 'isChangeContract', 'contractChange', 'withEstablishment'];
async function hrCatalog(page: Page) {
  const fields = ['effectiveDate', 'transferTypeCode', 'reasonCode', ...linkageCatalog];
  await page.route('**/employment/transfers/catalog**', (route) =>
    route.fulfill({
      json: {
        today: '2026-10-12',
        types: [{ code: 'transfer', name: '部门间调动', formId: 'hr' }],
        reasons: [],
        viewableFields: fields,
        editableFields: fields,
      },
    }),
  );
}
const hrButtons = (page: Page) => page.locator('.hr-transfer-actions button');
async function openEntry(page: Page, entry: string) {
  await switchIdentity(page, '/transfer');
  await page.getByRole('button', { name: button(entry) }).click();
  await page.locator('select[name="employeeId"]').selectOption(employee);
  await expect(page.locator('input[name="place"]')).toBeVisible();
}

test('AC-FE-R1c-03b 他人调动申请：四区块、锚点导航、是否单选，按钮为取消 / 暂存 / 提交', async ({ page }) => {
  await hrCatalog(page);
  await openEntry(page, '他人调动申请');
  await expect(page.locator('.hr-transfer-section > legend')).toHaveText([
    '调动信息',
    '任职调整',
    '薪资调整',
    '合同变更',
  ]);
  const anchors = page.getByRole('navigation', { name: '表单导航' }).getByRole('button');
  await expect(anchors).toHaveText(['调动信息', '任职调整', '薪资调整', '合同变更']);
  const info = page.locator('#hr-transfer-info');
  await expect(info.locator('output[name="jobNumber"]')).toHaveText('DEMO-001');
  for (const label of ['是否调整薪资', '是否变更合同', '是否带编制调动']) {
    const group = info.getByRole('radiogroup', { name: label });
    await expect(group.getByRole('radio', { name: '否' })).toBeChecked();
  }
  const contract = page.locator('#hr-transfer-contract');
  await expect(contract).toContainText('未选择变更合同。');
  await info.getByRole('radiogroup', { name: '是否变更合同' }).getByRole('radio', { name: '是' }).check();
  await expect(contract).not.toContainText('未选择变更合同。');
  // 薪资调整组始终显示社保原值（F-474-8c-3）；本桩 catalog 未授调整值字段，调整值按字段权限不显示。
  await expect(page.locator('#hr-transfer-salary')).toContainText('社保缴交地--');
  await expect(hrButtons(page)).toHaveText(['取消', '暂存', '提交']);
  await expect(page.getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '直接调动', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '提交', exact: true })).toBeEnabled();
});

test('AC-FE-R1c-03c 调动入口按钮为取消 / 保存；无直接调动权限时保存不可用', async ({ page }) => {
  let writes = 0;
  await page.route(`**/transfers/employees/${employee}`, (route) => {
    writes += 1;
    return route.fulfill({ json: draftResult });
  });
  await openEntry(page, '调动');
  await expect(hrButtons(page)).toHaveText(['取消', '保存']);
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await expect(page.getByRole('note')).toHaveText('当前账号或该员工不允许直接调动，请改用“他人调动申请”。');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('button', { name: '调动中员工', exact: true, pressed: true })).toBeVisible();
  expect(writes).toBe(0);
});

// #333 第 1 轮 P2-2：Transfer.Hr 只决定入口；没有新建权限或可编辑字段时不能写。
for (const [name, operations, editable] of [
  ['无新建权限', { read: true }, ['place']],
  ['无可编辑字段', { read: true, create: true }, []],
] as const) {
  test(`AC-FE-R1c-03d ${name}：两个入口的写按钮都不可用且不发命令`, async ({ page }) => {
    await page.route('**/permission/me/objects/TenantBase.EmploymentRecord', (route) =>
      route.fulfill({
        json: {
          objectCode: 'TenantBase.EmploymentRecord',
          dataOperations: operations,
          viewableFields: ['name', 'place'],
          editableFields: editable,
          buttons: [{ buttonCode: 'Transfer.Hr', level: 'detail' }],
        },
      }),
    );
    let writes = 0;
    await page.route(`**/transfers/employees/${employee}`, (route) => {
      writes += 1;
      return route.fulfill({ json: draftResult });
    });
    const hint = '当前账号没有新增任职记录的权限或可编辑字段，不能保存调动。';
    await openEntry(page, '他人调动申请');
    await expect(page.getByRole('note')).toHaveText(hint);
    await expect(page.getByRole('button', { name: '暂存', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '提交', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: button('调动') }).click();
    await page.locator('select[name="employeeId"]').selectOption(employee);
    await expect(page.getByRole('note')).toHaveText(hint);
    await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    expect(writes).toBe(0);
  });
}

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
  await expect(page.getByRole('tab', { name: '操作记录(3)' })).toBeVisible();
  const records = page.locator('.approval-detail-collab .approval-log');
  await expect(records).toHaveCount(3);
  await expect(records.nth(0)).toContainText('发起申请');
  await expect(records.nth(1)).toContainText('转交');
  await expect(records.nth(1)).toContainText('部门负责人审批');
  await expect(records.nth(2)).toContainText('催办');
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
  await expect(page.locator('.approval-todo-main')).not.toContainText('演示数据');
  await page.getByRole('button', { name: '合成员工的调动申请', exact: true }).click();
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

test('AC-FE-R1c-04b 切换审批分类回到第 1 页，不带上一分类的页码', async ({ page }) => {
  // #333 第 1 轮 P2-3：待处理 16 条翻到第 2 页后切到已申请，应请求第 1 页并显示卡片。
  await page.route('**/api/tenant/approval/todos?**', (route) => {
    if (new URL(route.request().url()).searchParams.get('view') === 'initiated') return route.fallback();
    const current = Number(new URL(route.request().url()).searchParams.get('page'));
    const count = current === 1 ? 15 : 1;
    const items = Array.from({ length: count }, (_, index) => ({
      taskId: `50000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`,
      id: instance,
      instanceId: instance,
      title: `合成待办 ${current}-${index + 1}`,
      nodeName: '部门负责人审批',
      approvalType: 'transfer',
      createdAt: '2026-10-12T01:00:00Z',
    }));
    return route.fulfill({
      json: { items, total: 16, categories: [{ key: 'employment', label: '人事变动', count: 16 }] },
    });
  });
  const pages: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/approval/todos') && url.searchParams.get('view') === 'initiated')
      pages.push(url.searchParams.get('page') ?? '');
  });
  await switchIdentity(page, '/approval');
  await expect(page.locator('.approval-card')).toHaveCount(15);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.getByText('第 2 页', { exact: true })).toBeVisible();
  await expect(page.locator('.approval-card')).toHaveCount(1);
  await page.getByRole('button', { name: '已申请', exact: true }).click();
  await expect(page.getByRole('button', { name: '合成员工的调动申请', exact: true })).toBeVisible();
  expect(pages).toEqual(['1']);
  // 切回原分类也从第 1 页开始。
  await page.getByRole('button', { name: '待处理', exact: true }).click();
  await expect(page.locator('.approval-card')).toHaveCount(15);
  await expect(page.getByText('第 1 页', { exact: true })).toBeVisible();
});

// #333 第 2 轮 P2：转交日志的 taskId 指向接收人的新任务，转交人意见只在日志自身 detail.comment（actions.ts delegate）。
const receiver = '50000000-0000-4000-8000-000000000002';
function transferredDetail(receiverDone: boolean) {
  const transfer = { fromUserId: user, toUserId: '70000000-0000-4000-8000-000000000002', comment: '转交者意见甲' };
  return {
    ...detail(),
    tasks: [
      { id: task, nodeName: '部门负责人审批', status: 'transferred', comment: '转交者意见甲' },
      receiverDone
        ? { id: receiver, nodeName: '部门负责人审批', status: 'approved', comment: '接收人审批意见乙' }
        : { id: receiver, nodeName: '部门负责人审批', status: 'pending', comment: null },
    ],
    logs: [
      { event: 'start', taskId: null, detail: { processCode: 'transfer' }, createdAt: '2026-10-12T01:00:00Z' },
      { event: 'transfer', nodeKey: 'leader', taskId: receiver, detail: transfer, createdAt: '2026-10-12T02:00:00Z' },
      ...(receiverDone
        ? [
            {
              event: 'approve',
              nodeKey: 'leader',
              taskId: receiver,
              detail: { comment: '接收人审批意见乙' },
              createdAt: '2026-10-12T03:00:00Z',
            },
          ]
        : []),
    ],
  };
}
for (const receiverDone of [false, true]) {
  test(`AC-FE-R1c-04c 转交记录显示转交人意见（接收人${receiverDone ? '已同意' : '未处理'}）`, async ({ page }) => {
    await page.route(`**/approval/instances/${instance}`, (route) =>
      route.fulfill({ json: transferredDetail(receiverDone) }),
    );
    await switchIdentity(page, '/approval');
    await openTodo(page);
    const records = page.locator('.approval-detail-collab .approval-log');
    await expect(records).toHaveCount(receiverDone ? 3 : 2);
    await expect(records.nth(0)).not.toContainText('意见');
    await expect(records.nth(1)).toContainText('转交');
    await expect(records.nth(1)).toContainText('转交者意见甲');
    await expect(records.nth(1)).not.toContainText('接收人审批意见乙');
    if (receiverDone) {
      await expect(records.nth(2)).toContainText('接收人审批意见乙');
      await expect(records.nth(2)).not.toContainText('转交者意见甲');
    }
  });
}

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
    await actionButton(page, '保存').click();
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
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/tenant/approval/tasks/*/approve', async (route) => {
    writes++;
    await pending;
    return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE' } } });
  });
  await switchIdentity(page, '/approval');
  await openTodo(page);
  await page.getByRole('button', { name: button('同意') }).click();
  await actionButton(page, '保存').click();
  // F-227：受控回执让加载态必然出现，定位不能依赖动画恰好结束。
  try {
    await expect.poll(() => writes).toBe(1);
    await expect(page.getByRole('dialog').getByRole('img', { name: 'loading', exact: true })).toBeVisible();
    await expect(actionButton(page, '保存')).toBeDisabled();
  } finally {
    release();
  }
  await expect(page.getByText('处理中 / 结果待确认。当前表单已锁定，请勿重新创建命令。')).toBeVisible();
  await expect(actionButton(page, '保存')).toBeDisabled();
  await page.getByRole('button', { name: button('取消') }).click();
  await expect(page.getByText('本单有未确认的“同意”操作，请打开核对结果；确认前不能发起其他操作。')).toBeVisible();
  for (const other of ['驳回', '转交', '撤销'])
    await expect(page.getByRole('button', { name: button(other) })).toBeDisabled();
  await page.getByRole('button', { name: button('返回') }).click();
  await openTodo(page);
  await page.getByRole('button', { name: button('同意') }).click();
  await expect(page.getByText('处理中 / 结果待确认。当前表单已锁定，请勿重新创建命令。')).toBeVisible();
  await actionButton(page, '回查原单').click();
  await expect(page.getByText('原单当前值（仅供核对，不能据此确认本次命令结果）')).toBeVisible();
  await expect(actionButton(page, '保存')).toBeDisabled();
  expect(writes).toBe(1);
});

test('AC-FE-F110-13 审批同意未知：整页刷新后仍锁定，查询结果成功读回详情并解锁', async ({ page }) => {
  let writes = 0;
  let command = '';
  let confirmed = false;
  await page.route('**/api/tenant/approval/tasks/*/approve', (route) => {
    writes++;
    command = route.request().headers()['idempotency-key']!;
    return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE' } } });
  });
  await page.route(`**/api/tenant/approval/instances/${instance}`, (route) =>
    route.fulfill({ json: confirmed ? detail(5, 'approved') : detail() }),
  );
  await page.route('**/api/tenant/commands/*/result', (route) => {
    confirmed = true;
    // F-120 审批命令的真实投影：台账响应体是 { instanceId }，摘要三项为 null（AC-FE-F110-14 实测）。
    return route.fulfill({
      json: {
        commandId: command,
        status: 'succeeded',
        commandType: 'POST /api/tenant/approval/tasks/:id/approve',
        businessType: null,
        businessId: null,
        revision: null,
        httpStatus: 200,
        completedAt: '2026-10-12T04:00:00.000Z',
      },
    });
  });
  await switchIdentity(page, '/approval');
  await openTodo(page);
  await page.getByRole('button', { name: button('同意') }).click();
  await actionButton(page, '保存').click();
  await expect(page.getByText('处理中 / 结果待确认。当前表单已锁定，请勿重新创建命令。')).toBeVisible();
  await page.reload();
  await openTodo(page);
  await expect(page.getByText('本单有未确认的“同意”操作，请打开核对结果；确认前不能发起其他操作。')).toBeVisible();
  await expect(
    page.getByText('刷新前或其他标签页提交的命令结果待确认；提交内容未在本页保存，请先查询结果。'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: button('驳回') })).toBeDisabled();
  await page.getByRole('button', { name: '查询结果', exact: true }).click();
  await expect(page.getByText('本单有未确认的“同意”操作，请打开核对结果；确认前不能发起其他操作。')).toHaveCount(0);
  await expect(
    page.getByText('刷新前或其他标签页提交的命令结果待确认；提交内容未在本页保存，请先查询结果。'),
  ).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('italent.commands.pending:approval'))).toBeNull();
  expect(writes).toBe(1);
});

test('AC-FE-F110-16 双标签页：A 页同意结果未知期间 B 页同一审批单锁定、不发出新命令；A 查到确定失败后 B 才放行', async ({
  page,
}) => {
  const locked = '本单有未确认的“同意”操作，请打开核对结果；确认前不能发起其他操作。';
  const keys: string[] = [];
  const other = await page.context().newPage();
  await demoRoutes(other);
  await approvalFixtures(other);
  for (const tab of [page, other]) {
    // 第一次（A 页）回执丢失；之后的同意按真实成功回执返回动作后的详情。
    await tab.route('**/api/tenant/approval/tasks/*/approve', (route) => {
      keys.push(route.request().headers()['idempotency-key']!);
      return keys.length === 1
        ? route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE' } } })
        : route.fulfill({ json: detail(5, 'approved') });
    });
    // F-120 审批命令确定失败的真实投影：摘要三项为 null。
    await tab.route('**/api/tenant/commands/*/result', (route) =>
      route.fulfill({
        json: {
          commandId: keys[0],
          status: 'failed',
          commandType: 'POST /api/tenant/approval/tasks/:id/approve',
          businessType: null,
          businessId: null,
          revision: null,
          httpStatus: 409,
          completedAt: '2026-10-12T04:00:00.000Z',
        },
      }),
    );
  }
  // B 页先打开同一审批单，A 页随后同意、回执丢失。
  await switchIdentity(other, '/approval');
  await openTodo(other);
  await switchIdentity(page, '/approval');
  await openTodo(page);
  await page.getByRole('button', { name: button('同意') }).click();
  await actionButton(page, '保存').click();
  await expect(page.getByText('处理中 / 结果待确认。当前表单已锁定，请勿重新创建命令。')).toBeVisible();

  await expect(other.getByText(locked)).toBeVisible();
  await expect(other.getByRole('button', { name: button('驳回') })).toBeDisabled();
  expect(keys).toHaveLength(1);

  await page.getByRole('button', { name: button('取消') }).click();
  await page.getByRole('button', { name: '查询结果', exact: true }).click();
  await expect(page.getByText(locked)).toHaveCount(0);
  await expect(other.getByText(locked)).toHaveCount(0);
  await other.getByRole('button', { name: button('同意') }).click();
  await actionButton(other, '保存').click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).not.toBe(keys[0]);
  expect(await other.evaluate(() => localStorage.getItem('italent.commands.pending:approval'))).toBeNull();
  await other.close();
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
  await actionButton(page, '保存').click();
  await expect(page.getByText('处理中 / 结果待确认。当前表单已锁定，请勿重新创建命令。')).toBeVisible();
  await expect(actionButton(page, '保存')).toBeDisabled();
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
  await actionButton(page, '保存').click();
  await expect(page.getByText('版本冲突：输入已保留，请重读最新版本并核对差异后重提。')).toBeVisible();
  await expect(page.getByText('处理中 / 结果待确认。当前表单已锁定，请勿重新创建命令。')).toHaveCount(0);
  await actionButton(page, '重读最新版本').click();
  await page.getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
  await expect(page.getByLabel('审批意见')).toHaveValue('合成审批意见');
  await actionButton(page, '保存').click();
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

async function transferFixtures(page: Page, allowDirectTransfer = false) {
  await page.route('**/transfers/employees/*/draft', (route) => route.fulfill({ json: { draft: null } }));
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
        allowDirectTransfer,
        allowedActions: { application: true, ...(allowDirectTransfer ? { directList: true } : {}) },
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
  // 重负载下每次整页加载要数秒，原先 3 次（进页面、选人后跳 /staff、再进页面）合起来占了用例耗时的大半（F-311）。
  await seedDemoUser(page);
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
// GET /businesses/:id 与 GET /transfers/:id/linkage 的真实形状（read-model.ts / linkage 路由）。
const draftBusiness = {
  ...draftResult,
  employeeId: employee,
  kind: 'transfer',
  changeType: 'position_adjustment',
  mode: 'application',
  formId: 'hr',
  effectiveDate: '2026-10-12',
  fields: { place: '暂存工作地' },
  customFields: {},
  employeeStatus: 'employed',
  entryStatus: null,
  record: null,
  activation: null,
};
async function hrRecoveryFixture(page: Page) {
  const state = { saved: false };
  await page.route('**/transfers/employees/' + employee + '/draft', (route) =>
    route.fulfill({ json: { draft: state.saved ? { id: draftId, revision: 1, transferTypeCode: 'transfer' } : null } }),
  );
  await page.route('**/employment/businesses/' + draftId, (route) => route.fulfill({ json: draftBusiness }));
  await page.route('**/transfers/*/linkage', (route) =>
    route.fulfill({
      json: {
        businessId: draftId,
        revision: 1,
        // 该目录未开放调整薪资：带出时不得替用户重提（F-153 只带出可编辑的联动项）。
        options: { adjustSalary: true },
        executedAt: null,
        contract: null,
        salaryReminder: null,
      },
    }),
  );
  return state;
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

// F-153（DEC-511）：暂存按人一份，重选同一人自动带出；“我的申请”不再列暂存单。
async function reopenDraft(page: Page) {
  await openHr(page);
  await page.locator('select[name="employeeId"]').selectOption(employee);
  await expect(page.getByRole('status').filter({ hasText: '已带出上次暂存信息' })).toBeVisible();
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
  await expect(page.getByText('信息暂存成功，下次选择此人可自动带出')).toBeVisible();
  await closeHr(page);
}
const processing = '处理中，请在我的申请中查看';
async function expectReadonly(page: Page) {
  await expect(page.getByText(processing, { exact: true }).last()).toBeVisible();
  await expect(page.getByRole('button', { name: '恢复原命令', exact: true })).toHaveCount(0);
  await expect(page.locator('.r1c-transfer-form').locator('input, select, button[type="submit"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '暂存', exact: true })).toHaveCount(0);
}

test('AC-FE-R1c-11 DEC-511 刷新后重选同一人带出暂存，提交走新建提交（不经我的申请）', async ({ page }) => {
  const stored = await hrRecoveryFixture(page);
  const bodies: Record<string, unknown>[] = [];
  await page.route('**/transfers/employees/' + employee, (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ json: bodies.length === 1 ? draftResult : { ...draftResult, status: 'in_review' } });
  });
  await saveDraft(page);
  stored.saved = true;
  await page.reload();
  await reopenDraft(page);
  await expect(page.locator('input[name="place"]')).toHaveValue('暂存工作地');
  await page.getByRole('button', { name: '提交', exact: true }).click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]).toMatchObject({ submit: true, fields: { place: '暂存工作地' } });
  expect(bodies[1]!.linkage).toBeUndefined();
});

// F-110 取代原“不再保存命令编号”：共享恢复记录只存命令 ID 与对象（不存字段原文），刷新后仍只读，查询结果解锁。
test('AC-FE-R1c-12 AC-FE-F110-12 创建未知关闭刷新后仍只读，按原命令 ID 查询结果解锁', async ({ page }) => {
  let writes = 0;
  let command = '';
  const queries: string[] = [];
  await page.route('**/transfers/employees/' + employee, (route) => {
    writes++;
    command = route.request().headers()['idempotency-key']!;
    return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE' } } });
  });
  await page.route('**/api/tenant/commands/*/result', (route) => {
    queries.push(new URL(route.request().url()).pathname);
    if (queries.length === 1) return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND' } } });
    return route.fulfill({
      json: {
        commandId: command,
        status: 'succeeded',
        // 真实投影（AC-TRF-F120 ②）：commandType 用路由模板 :id，新建调动单 201。
        commandType: 'POST /api/tenant/employment/transfers/employees/:id',
        businessType: 'transfer',
        businessId: draftId,
        revision: 1,
        httpStatus: 201,
        completedAt: '2026-10-12T02:00:00.000Z',
      },
    });
  });
  await page.route('**/employment/businesses/' + draftId, (route) => route.fulfill({ json: draftBusiness }));
  await switchIdentity(page, '/transfer');
  await openHr(page);
  await page.locator('select[name="employeeId"]').selectOption(employee);
  await page.getByRole('button', { name: '暂存', exact: true }).click();
  await expectReadonly(page);
  await closeHr(page);
  await page.reload();
  await openHr(page);
  await expectReadonly(page);
  const record = await page.evaluate(() => localStorage.getItem('italent.commands.pending:transfer'));
  expect(record).toContain(command);
  expect(record).not.toContain('合成工作地');
  await page.getByRole('button', { name: '查询结果', exact: true }).click();
  await expect(page.getByText('暂未查到本次命令的结果，可能仍在处理中，请稍后再查询。')).toBeVisible();
  await expectReadonly(page);
  await page.getByRole('button', { name: '查询结果', exact: true }).click();
  await expect(page.getByText('信息暂存成功，下次选择此人可自动带出')).toBeVisible();
  await expect(page.getByText(processing, { exact: true })).toHaveCount(0);
  expect(queries).toEqual([`/api/tenant/commands/${command}/result`, `/api/tenant/commands/${command}/result`]);
  expect(writes).toBe(1);
});

async function establishmentWrites(page: Page, firstResponse?: Promise<void>) {
  await transferFixtures(page, true);
  const writes: string[] = [];
  await page.route(`**/transfers/employees/${employee}`, async (route) => {
    writes.push(route.request().headers()['idempotency-key']!);
    if (route.request().postDataJSON().confirmed === true) return route.abort('connectionreset');
    await firstResponse;
    return route.fulfill({
      status: 409,
      json: { error: { code: 'CONFLICT', message: '已超出设定编制', details: { reason: 'CONFIRMATION_REQUIRED' } } },
    });
  });
  return writes;
}

const resultPath = (id: string) => `/api/tenant/commands/${id}/result`;
const transferRecoveryKey = 'italent.commands.pending:transfer';

async function establishmentResults(page: Page, writes: string[]) {
  const queries: string[] = [];
  const ready = { result: false, business: false };
  await page.route('**/api/tenant/commands/*/result', (route) => {
    const path = new URL(route.request().url()).pathname;
    queries.push(path);
    if (queries.length === 1) return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND' } } });
    if (path === resultPath(writes[0]!) || !ready.result) {
      // B 的查询也收到一份迟到的 A 失败摘要，必须按命令 ID 拒绝这份回执。
      return route.fulfill({
        json: {
          commandId: writes[0],
          status: 'failed',
          businessType: null,
          businessId: null,
          revision: null,
          httpStatus: 409,
        },
      });
    }
    return route.fulfill({
      json: {
        commandId: writes[1],
        status: 'succeeded',
        commandType: 'POST /api/tenant/employment/transfers/employees/:id',
        businessType: 'transfer',
        businessId: draftId,
        revision: 1,
        httpStatus: 201,
        completedAt: '2026-10-12T02:00:00.000Z',
      },
    });
  });
  await page.route(`**/employment/businesses/${draftId}`, (route) =>
    ready.business
      ? route.fulfill({ json: { ...draftBusiness, mode: 'direct', status: 'effective' } })
      : route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND' } } }),
  );
  return { queries, ready };
}

const pendingTransferIds = (page: Page) =>
  page.evaluate((key) => {
    const records = JSON.parse(localStorage.getItem(key) ?? '[]') as { commandId: string }[];
    return records.map(({ commandId }) => commandId);
  }, transferRecoveryKey);

const establishmentDialog = (page: Page) => page.getByRole('dialog').filter({ hasText: '已超出设定编制' });

test('AC-FE-F110-18 HR 超编确认重提断线：刷新后仍按第二条命令查询，读回调动单才解锁', async ({ page }) => {
  const writes = await establishmentWrites(page);
  const { queries, ready } = await establishmentResults(page, writes);
  const query = page.getByRole('button', { name: '查询结果', exact: true });

  await openEntry(page, '调动');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const confirm = establishmentDialog(page);
  await expect(confirm).toBeVisible();
  expect(writes).toHaveLength(1);
  await confirm.getByRole('button', { name: button('继续保存') }).click();
  await expect(query).toBeVisible();
  expect(writes).toHaveLength(2);
  const [first, retry] = writes as [string, string];
  expect(retry).not.toBe(first);
  expect.soft(await pendingTransferIds(page), '响应丢失时只登记确认重提的命令 B').toEqual([retry]);
  await query.click();
  await expect.poll(() => queries).toHaveLength(1);
  expect.soft(queries, '刷新前按 B 查询').toEqual([resultPath(retry)]);
  await expect(page.getByText('暂未查到本次命令的结果，可能仍在处理中，请稍后再查询。')).toBeVisible();

  await closeHr(page);
  await page.reload();
  await page.getByRole('button', { name: button('调动') }).click();
  await expect(query).toBeVisible();
  expect.soft(await pendingTransferIds(page), '整页刷新后仍只登记 B').toEqual([retry]);
  await query.click();
  await expect.poll(() => queries).toEqual([resultPath(retry), resultPath(retry)]);
  await expect(query).toBeEnabled();
  await expectReadonly(page);
  expect(await pendingTransferIds(page)).toEqual([retry]);

  ready.result = true;
  await query.click();
  await expect.poll(() => queries).toHaveLength(3);
  await expect(query).toBeEnabled();
  await expectReadonly(page);
  expect(await pendingTransferIds(page)).toEqual([retry]);

  ready.business = true;
  const readBack = page.waitForResponse((response) => response.url().endsWith(`/employment/businesses/${draftId}`));
  await query.click();
  expect((await readBack).status()).toBe(200);
  await expect.poll(() => pendingTransferIds(page)).toEqual([]);
  await expect(query).toHaveCount(0);
  expect(queries).toEqual(Array<string>(4).fill(resultPath(retry)));
  expect(writes).toHaveLength(2);
});

test('AC-FE-F110-20 HR 确认重提：他页持锁时 B 排队，A 已落定的记录不会挡住 B', async ({ page, context }) => {
  let respond = () => {};
  const firstResponse = new Promise<void>((resolve) => (respond = resolve));
  const writes = await establishmentWrites(page, firstResponse);
  await openEntry(page, '调动');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => writes).toHaveLength(1);

  const other = await context.newPage();
  try {
    await other.route('**/lock-holder', (route) => route.fulfill({ body: '', contentType: 'text/html' }));
    await other.goto('/lock-holder');
    await other.evaluate(
      (key) =>
        new Promise<void>((held) => {
          void navigator.locks.request(key, { mode: 'exclusive' }, () => {
            held();
            // 保持独占，关闭这个页面时浏览器释放。
            return new Promise<void>(() => {});
          });
        }),
      transferRecoveryKey,
    );
    respond();
    await establishmentDialog(page)
      .getByRole('button', { name: button('继续保存') })
      .click();
    await expect
      .poll(
        () =>
          page.evaluate(async (key) => {
            const { pending } = await navigator.locks.query();
            return pending?.filter((lock) => lock.name === key && lock.mode === 'exclusive').length;
          }, transferRecoveryKey),
        { message: 'A 的删除与 B 的登记都在等待他页释放互斥锁' },
      )
      .toBe(2);
    expect(writes).toHaveLength(1);
  } finally {
    respond();
    await other.close();
  }
  await expect(page.getByRole('button', { name: '查询结果', exact: true })).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[1]).not.toBe(writes[0]);
  expect(await pendingTransferIds(page)).toEqual([writes[1]]);
});

const LOCK_BUSY = '检测到你在另一个标签页打开了此单据，请关闭后重试。';
const LOCKS_UNSUPPORTED = '当前浏览器环境不支持安全保存（需 https 访问），命令未发出。';

/** 同源另开一个真实标签页，一直占着恢复记录的互斥锁；关闭该页时浏览器释放。 */
async function holdLockInOtherTab(page: Page, key: string) {
  const other = await page.context().newPage();
  await other.route('**/lock-holder', (route) => route.fulfill({ body: '', contentType: 'text/html' }));
  await other.goto('/lock-holder');
  await other.evaluate(
    (name) =>
      new Promise<void>((held) => {
        void navigator.locks.request(name, { mode: 'exclusive' }, () => {
          held();
          return new Promise<void>(() => {});
        });
      }),
    key,
  );
  return other;
}
// http 非安全上下文与老浏览器没有 navigator.locks（DEC-955）。
const withoutWebLocks = (page: Page) =>
  page.addInitScript(() =>
    Object.defineProperty(Navigator.prototype, 'locks', { configurable: true, get: () => undefined }),
  );

test('AC-FE-F110-21 DEC-954 他页持锁：本页暂存提示另一个标签页打开、零请求、输入保留；他页关闭后照常暂存', async ({
  page,
}) => {
  test.setTimeout(60_000);
  let writes = 0;
  await page.route('**/transfers/employees/' + employee, (route) => {
    writes++;
    return route.fulfill({ json: draftResult });
  });
  await switchIdentity(page, '/transfer');
  await openHr(page);
  await page.locator('select[name="employeeId"]').selectOption(employee);
  await page.locator('input[name="place"]').fill('合成新工作地');
  const other = await holdLockInOtherTab(page, transferRecoveryKey);
  try {
    await page.getByRole('button', { name: '暂存', exact: true }).click();
    await expect(page.getByText(LOCK_BUSY)).toBeVisible({ timeout: 10_000 });
    expect(writes).toBe(0);
    await expect(page.locator('input[name="place"]')).toHaveValue('合成新工作地');
    expect(await pendingTransferIds(page)).toEqual([]);
  } finally {
    await other.close();
  }
  await page.getByRole('button', { name: '暂存', exact: true }).click();
  await expect(page.getByText('信息暂存成功，下次选择此人可自动带出')).toBeVisible();
  expect(writes).toBe(1);
});

test('AC-FE-F110-22 DEC-955 浏览器无 Web Locks：调动暂存提示需 https、零请求，不降级', async ({ page }) => {
  await withoutWebLocks(page);
  let writes = 0;
  await page.route('**/transfers/employees/' + employee, (route) => {
    writes++;
    return route.fulfill({ json: draftResult });
  });
  await switchIdentity(page, '/transfer');
  await openHr(page);
  await page.locator('select[name="employeeId"]').selectOption(employee);
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByRole('button', { name: '暂存', exact: true }).click();
    await expect(page.getByText(LOCKS_UNSUPPORTED)).toBeVisible();
  }
  expect(writes).toBe(0);
  expect(await pendingTransferIds(page)).toEqual([]);
});

test('AC-FE-F110-22 DEC-955 浏览器无 Web Locks：审批同意提示需 https、零请求', async ({ page }) => {
  await withoutWebLocks(page);
  let writes = 0;
  await page.route('**/api/tenant/approval/tasks/*/approve', (route) => {
    writes++;
    return route.fulfill({ json: detail(5, 'approved') });
  });
  await switchIdentity(page, '/approval');
  await openTodo(page);
  await page.getByRole('button', { name: button('同意') }).click();
  await actionButton(page, '保存').click();
  await expect(page.getByText(LOCKS_UNSUPPORTED)).toBeVisible();
  expect(writes).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('italent.commands.pending:approval'))).toBeNull();
});

const OTHER_TAB = '其他标签页有该对象未确认的命令，本次命令未发出；请等待结果或先查询结果。';
const pendingLocks = (page: Page) =>
  page.evaluate(async (key) => {
    const { pending } = await navigator.locks.query();
    return pending?.filter((lock) => lock.name === key).length;
  }, transferRecoveryKey);

// 第 2 轮 P2-1：http 非安全上下文同时没有 navigator.locks 与 crypto.randomUUID，须在生成命令 ID 之前拒绝。
for (const action of ['暂存', '提交']) {
  test(`AC-FE-F110-24 DEC-955 非安全上下文：HR 调动${action}提示需 https、零请求、输入保留`, async ({ page }) => {
    await insecureContext(page);
    let writes = 0;
    await page.route('**/transfers/employees/' + employee, (route) => {
      writes++;
      return route.fulfill({ json: draftResult });
    });
    await switchIdentity(page, '/transfer');
    await openHr(page);
    await page.locator('select[name="employeeId"]').selectOption(employee);
    // 读调动预览本身不受 DEC-955 限制（非写入），非安全上下文里也必须读得出来。
    await expect(page.locator('input[name="place"]')).toBeEditable();
    await page.locator('input[name="place"]').fill('合成新工作地');
    await page.getByRole('button', { name: action, exact: true }).click();
    await expect(page.getByText(LOCKS_UNSUPPORTED)).toBeVisible();
    await expect(page.getByRole('button', { name: action, exact: true })).toBeEnabled();
    await expect(page.locator('input[name="place"]')).toHaveValue('合成新工作地');
    expect(writes).toBe(0);
    expect(await pendingTransferIds(page)).toEqual([]);
  });
}

for (const decision of [
  { label: '同意', path: 'approve', status: 'approved' },
  { label: '驳回', path: 'reject', status: 'returned' },
]) {
  test(`AC-FE-F110-24 DEC-955 非安全上下文：审批${decision.label}提示需 https、零请求`, async ({ page }) => {
    await insecureContext(page);
    let writes = 0;
    await page.route(`**/api/tenant/approval/tasks/*/${decision.path}`, (route) => {
      writes++;
      return route.fulfill({ json: detail(5, decision.status) });
    });
    await switchIdentity(page, '/approval');
    await openTodo(page);
    await page.getByRole('button', { name: button(decision.label) }).click();
    await actionButton(page, '保存').click();
    await expect(page.getByText(LOCKS_UNSUPPORTED)).toBeVisible();
    expect(writes).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('italent.commands.pending:approval'))).toBeNull();
  });
}

// 第 2 轮 P2-3：两页同时暂存同一员工，A 先拿到锁登记；B 排在后面，读到 A 的记录被拒。
test('AC-FE-F110-26 同一员工两页同时登记：后登记的一页提示其他标签页、零请求，并锁到先登记那页的命令', async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  const writes: string[] = [];
  let respond = () => {};
  const answered = new Promise<void>((resolve) => (respond = resolve));
  const pageB = await context.newPage();
  await demoRoutes(pageB);
  await approvalFixtures(pageB);
  for (const target of [page, pageB]) {
    await target.route('**/transfers/employees/' + employee, async (route) => {
      writes.push(route.request().headers()['idempotency-key']!);
      await answered;
      return route.fulfill({ json: draftResult }).catch(() => {});
    });
    await switchIdentity(target, '/transfer');
    await openHr(target);
    await target.locator('select[name="employeeId"]').selectOption(employee);
  }
  const holder = await holdLockInOtherTab(page, transferRecoveryKey);
  try {
    await page.getByRole('button', { name: '暂存', exact: true }).click();
    await pageB.getByRole('button', { name: '暂存', exact: true }).click();
  } finally {
    await holder.close();
  }
  await expect.poll(() => writes).toHaveLength(1);
  await expect(pageB.getByText(OTHER_TAB)).toBeVisible();
  await expect(pageB.getByText(processing)).toBeVisible();
  expect(await pendingTransferIds(pageB)).toEqual([writes[0]]);
  expect(writes).toHaveLength(1);
  respond();
  await pageB.close();
});

const DRAFT_DELETE_FORBIDDEN = '没有删除权限，无法清除暂存';
const STRICT_ESTABLISHMENT = '已超出设定编制，不可继续操作';
/** 同一员工的两页：A 的调动写入挂起到 respond；B 的写入交给 answerB（未给时同样挂起），各自计数。 */
async function racePages(page: Page, answerB?: () => { status: number; json: unknown }) {
  const writes: string[] = [];
  const writesB: string[] = [];
  let respond = () => {};
  const answered = new Promise<void>((resolve) => (respond = resolve));
  const pageB = await page.context().newPage();
  await demoRoutes(pageB);
  await approvalFixtures(pageB);
  for (const target of [page, pageB]) {
    await target.route('**/transfers/employees/' + employee, async (route) => {
      writes.push(route.request().headers()['idempotency-key']!);
      if (target === pageB) writesB.push(route.request().method());
      const reply = target === pageB ? answerB?.() : undefined;
      if (reply) return route.fulfill(reply);
      await answered;
      return route.fulfill({ json: draftResult }).catch(() => {});
    });
  }
  return { pageB, writes, writesB, respond };
}
async function openEmployee(target: Page) {
  await switchIdentity(target, '/transfer');
  await openHr(target);
  await target.locator('select[name="employeeId"]').selectOption(employee);
}
/** B 带出暂存后点击清除，服务端 403：拒绝原因留在表单原位置。 */
async function clearForbidden(pageB: Page) {
  const stored = await hrRecoveryFixture(pageB);
  stored.saved = true;
  const deletes: string[] = [];
  await pageB.route('**/transfers/employees/*/draft/*', (route) => {
    deletes.push(route.request().method());
    return route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN', message: '无权删除' } } });
  });
  await openEmployee(pageB);
  await expect(pageB.getByRole('status').filter({ hasText: '已带出上次暂存信息' })).toBeVisible();
  await pageB.getByRole('button', { name: '点击清除', exact: true }).click();
  await expect(pageB.locator('.transfer-content').getByText(DRAFT_DELETE_FORBIDDEN, { exact: true })).toBeVisible();
  return deletes;
}

// 第 3 轮 P2-3：“处理中”只显示本次竞争、且与当前恢复命令关联的“其他标签页”，不被先前清除失败的提示盖住。
test('AC-FE-F110-26b 先清除失败再两页竞争：B 显示其他标签页、零写入，锁到 A 的命令且保留 A 的恢复槽', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const { pageB, writes, writesB, respond } = await racePages(page);
  const deletes = await clearForbidden(pageB);
  await openEmployee(page);
  const holder = await holdLockInOtherTab(page, transferRecoveryKey);
  try {
    await page.getByRole('button', { name: '暂存', exact: true }).click();
    await pageB.getByRole('button', { name: '暂存', exact: true }).click();
  } finally {
    await holder.close();
  }
  await expect.poll(() => writes).toHaveLength(1);
  await expect(pageB.getByText(processing)).toBeVisible();
  await expect(pageB.getByRole('alert').filter({ hasText: OTHER_TAB })).toBeVisible();
  await expect(pageB.getByText(DRAFT_DELETE_FORBIDDEN)).toHaveCount(0);
  expect(await pendingTransferIds(pageB)).toEqual([writes[0]]);
  expect(writesB).toEqual([]);
  expect(deletes).toEqual(['DELETE']);
  respond();
  await pageB.close();
});

test('AC-FE-F110-26c B 上一笔被严格控编拒绝后只同步到 A 的命令：处理中不显示 B 的旧保存错误', async ({ page }) => {
  test.setTimeout(60_000);
  const strict = {
    error: { code: 'CONFLICT', message: STRICT_ESTABLISHMENT, details: { reason: 'ESTABLISHMENT_EXCEEDED' } },
  };
  const { pageB, writes, writesB, respond } = await racePages(page, () => ({ status: 409, json: strict }));
  await openEmployee(pageB);
  await pageB.getByRole('button', { name: '暂存', exact: true }).click();
  await expect(pageB.getByText(STRICT_ESTABLISHMENT)).toBeVisible();
  await openEmployee(page);
  await page.getByRole('button', { name: '暂存', exact: true }).click();
  await expect.poll(() => writes).toHaveLength(2);
  // B 没有再点：只经存储同步锁到 A 的命令，处理中不带任何本页旧错误，也没有本次竞争提示。
  await expect(pageB.getByText(processing)).toBeVisible();
  await expect(pageB.getByText(STRICT_ESTABLISHMENT)).toHaveCount(0);
  await expect(pageB.getByText(OTHER_TAB)).toHaveCount(0);
  expect(await pendingTransferIds(pageB)).toEqual([writes[1]]);
  expect(writesB).toEqual(['POST']);
  respond();
  await pageB.close();
});

// 正例（修前合法路径）：没有竞争时，清除失败仍在表单原位置提示，随后照常暂存。
test('AC-FE-F110-26d 无竞争时清除失败提示留在表单原位置，之后暂存照常成功', async ({ page }) => {
  test.setTimeout(60_000);
  const { pageB, writesB, respond } = await racePages(page, () => ({ status: 200, json: draftResult }));
  await clearForbidden(pageB);
  await expect(pageB.getByRole('button', { name: '暂存', exact: true })).toBeEnabled();
  await pageB.getByRole('button', { name: '暂存', exact: true }).click();
  await expect(pageB.getByText('信息暂存成功，下次选择此人可自动带出')).toBeVisible();
  expect(writesB).toHaveLength(1);
  respond();
  await pageB.close();
});

// 第 2 轮 P3：登记等锁超时被拒的命令没有登记过，不再为它排一个无超时的清理锁请求。
test('AC-FE-F110-28 他页持锁时暂存超时被拒：不残留本次尝试的排队锁请求，他页关闭后照常暂存', async ({ page }) => {
  test.setTimeout(60_000);
  let writes = 0;
  await page.route('**/transfers/employees/' + employee, (route) => {
    writes++;
    return route.fulfill({ json: draftResult });
  });
  await switchIdentity(page, '/transfer');
  await openHr(page);
  await page.locator('select[name="employeeId"]').selectOption(employee);
  const other = await holdLockInOtherTab(page, transferRecoveryKey);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.getByRole('button', { name: '暂存', exact: true }).click();
      await expect(page.getByText(LOCK_BUSY)).toBeVisible({ timeout: 10_000 });
      expect(await pendingLocks(page), `第 ${attempt + 1} 次被拒后`).toBe(0);
    }
    expect(writes).toBe(0);
  } finally {
    await other.close();
  }
  await page.getByRole('button', { name: '暂存', exact: true }).click();
  await expect(page.getByText('信息暂存成功，下次选择此人可自动带出')).toBeVisible();
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

// 原 R1c-14（我的申请暂存单读取失败）随暂存单列表撤掉；读取失败见 AC-FE-F153-11。
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

test('AC-FE-R1c-16 DEC-464 带出暂存后提交未知，重开只读不能再次发命令', async ({ page }) => {
  const stored = await hrRecoveryFixture(page);
  let submits = 0;
  await page.route('**/transfers/employees/' + employee, (route) => {
    if (!route.request().postDataJSON().submit) return route.fulfill({ json: draftResult });
    submits++;
    return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE' } } });
  });
  await saveDraft(page);
  stored.saved = true;
  await reopenDraft(page);
  await page.getByRole('button', { name: '提交', exact: true }).click();
  await expectReadonly(page);
  await closeHr(page);
  await openHr(page);
  await expectReadonly(page);
  expect(submits).toBe(1);
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
    let body: unknown;
    await page.route('**/transfers/employees/' + employee, (route) => {
      body = route.request().postDataJSON();
      return route.fulfill({ json: { ...draftResult, status } });
    });
    await switchIdentity(page, '/transfer');
    // 直接调动走“调动”入口的“保存”（#333 第 1 轮 P2-1）。
    await page.getByRole('button', { name: button('调动') }).click();
    await page.locator('select[name="employeeId"]').selectOption(employee);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByText(message!, { exact: true })).toBeVisible();
    expect(body).toMatchObject({ mode: 'direct', submit: false });
  });
}

// 原 R1c-19（暂存详情显示异动类型）随暂存单列表撤掉；带出时的类型推断见 AC-FE-F153-04。

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
    await expect(page.getByText('信息暂存成功，下次选择此人可自动带出')).toBeVisible();
    expect(commands).toHaveLength(2);
    expect(commands[1]).not.toBe(commands[0]);
    expect(bodies[1]).toMatchObject({ fields: { place: '合成改正工作地' } });
  });
}

test('AC-FE-F267 延长兼职待办同意编辑新结束日期和备注，提交字段与意见', async ({ page }) => {
  const current = {
    ...detail(),
    approvalType: 'part_time_extend',
    form: {
      values: { endDate: '2026-12-01', originalEndDate: '2026-11-01' },
      edit: {
        taskId: task,
        mode: 'with_approve',
        fields: [
          { key: 'endDate', required: true, value: '2026-12-01' },
          { key: 'requestRemark', required: false, value: null },
        ],
      },
    },
  };
  await page.route(`**/api/tenant/approval/instances/${instance}`, (route) => route.fulfill({ json: current }));
  const bodies: unknown[] = [];
  await page.route(`**/api/tenant/approval/tasks/${task}/approve`, async (route) => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({ json: { ...current, revision: 5 } });
  });
  await switchIdentity(page, '/approval');
  await openTodo(page);
  await page.getByRole('button', { name: button('同意') }).click();
  const form = page.getByRole('dialog');
  await expect(form.getByLabel('新结束日期')).toHaveValue('2026-12-01');
  await expect(form.locator('label').filter({ hasText: '新结束日期' })).toHaveClass(/ant-form-item-required/);
  // 审批编辑后的日期参与既有缩短提示；取消确认不能发送命令。
  await form.getByLabel('新结束日期').fill('2026-10-01');
  await form.getByRole('button', { name: button('保存') }).click();
  const confirmation = page.getByRole('dialog').filter({ hasText: '请确认以下信息' });
  await expect(confirmation).toContainText('2026-10-01');
  await confirmation.getByRole('button', { name: button('取消') }).click();
  await expect(confirmation).toBeHidden();
  expect(bodies).toHaveLength(0);
  await expect(form.getByLabel('新结束日期')).toHaveValue('2026-10-01');
  await form.getByLabel('新结束日期').fill('2026-12-31');
  await form.getByLabel('延长备注').fill('合成延长备注');
  await form.getByLabel('审批意见').fill('合成审批意见');
  await form.getByRole('button', { name: button('保存') }).click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toEqual({
    fields: { endDate: '2026-12-31', requestRemark: '合成延长备注' },
    comment: '合成审批意见',
  });
});

test('AC-APV-F474-3 待办完整日志分页弹窗', async ({ page }) => {
  await page.route(`**/api/tenant/approval/instances/${instance}/logs?**`, (route) => {
    const current = Number(new URL(route.request().url()).searchParams.get('page'));
    return route.fulfill({
      json: {
        page: current,
        pageSize: 20,
        recordsHidden: false,
        items: Array.from({ length: current === 1 ? 20 : 1 }, (_, i) => ({
          event: 'approve',
          actorUserId: user,
          actorName: '合成操作人',
          detail: { comment: `日志分页 ${current}-${i}` },
          createdAt: '2026-11-01T01:00:00Z',
        })),
      },
    });
  });
  await switchIdentity(page, '/approval');
  await expect(page.locator('.approval-card-title')).toContainText('合成发起人');
  await expect(page.locator('.approval-record-meta')).toContainText('调动日期：2026-11-01');
  await openTodo(page);
  await page.getByRole('button', { name: '查看流程日志', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('日志分页 1-19');
  await expect(dialog).not.toContainText('最近 200');
  await dialog.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(dialog).toContainText('日志分页 2-0');
  await expect(dialog.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
});
