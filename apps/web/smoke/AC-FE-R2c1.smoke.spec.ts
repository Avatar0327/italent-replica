import type { Page } from '@playwright/test';
import { test, expect, employee, user } from './fixtures.js';
import { businessId, openDetail, peer, person, setup, switchView } from './probation-fixtures.js';

const named = (name: string) => ({ name: new RegExp(`^${name.split('').join('\\s*')}$`) });
const dialog = (page: Page, title: string) => page.getByRole('dialog', { name: title, exact: true });
async function pickResult(page: Page, form: ReturnType<typeof dialog>) {
  await form
    .getByRole('combobox', { name: '试用结果', exact: true })
    .locator('xpath=ancestor::div[contains(@class,"ant-select-selector")]')
    .click();
  await page.locator('.ant-select-dropdown:visible').getByText('合成通过', { exact: true }).click();
}
const rowCount = (page: Page) => page.locator('.probation-table tr.ant-table-row');
// antd 收起加载图标有动画，可访问名可能仍带“loading”前缀；点击会等到按钮可用
const save = (form: ReturnType<typeof dialog>) => form.getByRole('button', { name: /保\s*存$/ });
async function openBatch(page: Page, count: number) {
  await page.getByRole('button', { name: '批量转正', exact: true }).click();
  const form = dialog(page, `批量转正（已选 ${count} 人）`);
  await pickResult(page, form);
  return form;
}

test('AC-FE-R2c1-01 五视图切换：按视图请求、每页 15 条、空状态原文、不串数据', async ({ page }) => {
  const { queries } = await setup(page);
  await expect(page.getByRole('button', { name: '即将试用到期', exact: true, pressed: true })).toBeVisible();
  await expect(rowCount(page)).toHaveCount(1);
  // 演示身份切换前的首屏也会请求一次，只核对切换后的请求序列
  const start = queries.length;
  for (const view of ['assessing', 'in_review', 'all', 'regularized', 'expiring']) await switchView(page, view);
  expect(queries.slice(start - 1).map((query) => query.get('view'))).toEqual([
    'expiring',
    'assessing',
    'in_review',
    'all',
    'regularized',
    'expiring',
  ]);
  expect(queries.every((query) => query.get('pageSize') === '15' && query.get('page') === '1')).toBe(true);
  await switchView(page, 'in_review');
  await expect(rowCount(page)).toHaveCount(0);
  await expect(page.locator('.probation-table')).toContainText('这里什么都没有...');
  // 考核中视图的行只读打开考核详情，不给编辑 / 转正入口
  await switchView(page, 'assessing');
  await openDetail(page);
  await expect(page.getByRole('button', named('转正'))).toHaveCount(0);
  await page.getByRole('button', named('查看考核')).click();
  await expect(dialog(page, '考核详情')).toContainText('合成试用中考核');
  await expect(dialog(page, '考核详情')).toContainText('正常转正');
});

test('AC-FE-R2c1-02 编辑试用期：改月数推算预计结束日，PUT 带员工 revision 与整份试用信息', async ({ page }) => {
  const { server } = await setup(page);
  await openDetail(page);
  await page.getByRole('button', named('试用信息')).click();
  await expect(dialog(page, '试用信息')).toContainText('2026-10-31');
  await dialog(page, '试用信息')
    .getByRole('button', { name: /Close|关闭/ })
    .click();
  await page.getByRole('button', named('编辑试用期')).click();
  const form = dialog(page, '编辑试用期');
  await expect(form.getByLabel('预计试用结束日期', { exact: true })).toHaveValue('2026-10-31');
  await form
    .getByRole('combobox', { name: '试用期(月)', exact: true })
    .locator('xpath=ancestor::div[contains(@class,"ant-select-selector")]')
    .click();
  await page.locator('.ant-select-dropdown:visible').getByText('2个月', { exact: true }).click();
  await expect(form.getByLabel('预计试用结束日期', { exact: true })).toHaveValue('2026-09-30');
  await form.getByRole('button', named('保存')).click();
  await expect(form).toHaveCount(0);
  expect(server.writes).toEqual([
    {
      method: 'PUT',
      path: `/api/tenant/employment/employees/${employee}/probation`,
      ifMatch: '4',
      body: {
        hasProbation: true,
        startDate: '2026-08-01',
        months: 2,
        expectedEndDate: '2026-09-30',
        regularizationDate: null,
      },
    },
  ]);
});

test('AC-FE-R2c1-03 直接转正：试用结果必填，默认预计结束日次日，转正后人员在“已转正”', async ({ page }) => {
  const { server } = await setup(page);
  await openDetail(page);
  await page.getByRole('button', named('转正')).click();
  const form = dialog(page, '转正');
  await expect(form.getByLabel('转正日期', { exact: true })).toHaveValue('2026-11-01');
  await form.getByRole('button', named('保存')).click();
  expect(server.writes).toHaveLength(0);
  await pickResult(page, form);
  await form.getByRole('button', named('保存')).click();
  await expect(form).toHaveCount(0);
  expect(server.writes).toHaveLength(1);
  expect(server.writes[0]).toMatchObject({
    path: '/api/tenant/employment/regularizations',
    ifMatch: undefined,
    body: {
      mode: 'direct',
      effectiveDate: '2026-11-01',
      probationResult: 'pass',
      items: [{ employeeId: employee, revision: 4 }],
    },
  });
  await expect(page.getByRole('button', { name: '已转正', exact: true, pressed: true })).toBeVisible();
  await expect(rowCount(page)).toHaveCount(1);
  await expect(rowCount(page)).toContainText(person.name);
  await expect(rowCount(page)).toContainText('审批通过');
  await switchView(page, 'expiring');
  await expect(rowCount(page)).toHaveCount(0);
});

test('AC-FE-R2c1-04 转正申请：建草稿后提交同一张单，人员进入“转正审批中”', async ({ page }) => {
  const { server } = await setup(page);
  await openDetail(page);
  await page.getByRole('button', named('转正申请')).click();
  const form = dialog(page, '转正申请');
  await pickResult(page, form);
  await form.getByRole('button', named('提交')).click();
  await expect(form).toHaveCount(0);
  expect(server.writes.map(({ path, ifMatch }) => [path, ifMatch])).toEqual([
    [`/api/tenant/employment/employees/${employee}/businesses`, '4'],
    [`/api/tenant/employment/businesses/${businessId}/submit`, '1'],
  ]);
  expect(server.writes[0]!.body).toEqual({
    kind: 'regularization',
    mode: 'application',
    effectiveDate: '2026-11-01',
    probationResult: 'pass',
  });
  expect(server.writes[1]!.body).toEqual({});
  await expect(page.getByRole('button', { name: '转正审批中', exact: true, pressed: true })).toBeVisible();
  await expect(rowCount(page)).toContainText('审批中');
  // 审批中的申请只给撤回 / 撤销，不再给转正
  await openDetail(page);
  await expect(page.getByRole('button', named('撤回'))).toBeEnabled();
  await expect(page.getByRole('button', named('撤销'))).toBeEnabled();
  await expect(page.getByRole('button', named('转正'))).toHaveCount(0);
});

test('AC-FE-R2c1-07 直接转正版本冲突：重读核对后重提带最新员工 revision 并转正成功（P2-1）', async ({ page }) => {
  const { server } = await setup(page);
  await openDetail(page);
  await page.getByRole('button', named('转正')).click();
  const form = dialog(page, '转正');
  await expect(form.getByLabel('转正日期', { exact: true })).toHaveValue('2026-11-01');
  // 打开后别人改了这名员工（4 → 5）
  server.employeeRevision = 5;
  await pickResult(page, form);
  await form.getByRole('button', named('保存')).click();
  await expect(form.getByText('版本冲突：输入已保留，请重读最新版本并核对差异后重提。')).toBeVisible();
  // 冲突后自动重读最新版本；读完（重读按钮不再转圈）才可确认
  await expect(form.getByRole('button', { name: /重读最新版本$/ })).not.toHaveClass(/ant-btn-loading/);
  await form.getByRole('button', { name: '已核对差异，继续编辑' }).click();
  await save(form).click();
  await expect.poll(() => server.writes.length).toBe(2);
  expect(server.writes.map((write) => (write.body.items as { revision: number }[])[0]!.revision)).toEqual([4, 5]);
  await expect(form).toHaveCount(0);
  await expect(page.getByRole('button', { name: '已转正', exact: true, pressed: true })).toBeVisible();
  await expect(rowCount(page)).toContainText('审批通过');
});

test('AC-FE-R2c1-08 批量转正部分失败：回执按打开时的人员快照列出姓名，人数不变（P2-3）', async ({ page }) => {
  const { server } = await setup(page, { peer: true });
  await expect(rowCount(page)).toHaveCount(2);
  await page.getByRole('checkbox', { name: 'Select all' }).check();
  const form = await openBatch(page, 2);
  await save(form).click();
  await expect(page.getByText('1 人转正成功')).toBeVisible();
  // 成功后列表已刷新、勾选已清空；弹窗仍按打开时的两人显示
  await expect(form).toContainText(`${peer.name}：没有预计试用结束日期，请填写转正日期`);
  expect(server.writes).toHaveLength(1);
  expect(server.writes[0]!.body.items).toEqual(
    expect.arrayContaining([
      { employeeId: employee, revision: 4 },
      { employeeId: peer.employeeId, revision: 7 },
    ]),
  );
  await form.getByRole('button', named('取消')).click();
  await expect(form).toHaveCount(0);
  await expect(rowCount(page)).toHaveCount(1);
  await expect(rowCount(page)).toContainText(peer.name);
});

test('AC-FE-R2c1-05 无编辑 / 创建按钮权不显示对应入口', async ({ page }) => {
  await setup(page, { buttons: ['Employment.Submit'] });
  await openDetail(page);
  await expect(page.getByRole('button', named('试用信息'))).toBeVisible();
  for (const name of ['编辑试用期', '转正', '转正申请'])
    await expect(page.getByRole('button', named(name))).toHaveCount(0);
  await page
    .getByRole('button', { name: /Close|关闭/ })
    .first()
    .click();
  await expect(page.getByRole('button', named('批量转正'))).toHaveCount(0);
});

const instance = '70000000-0000-4000-8000-000000000297';
const task = '50000000-0000-4000-8000-000000000297';
// 形状照 assessment-approval-adapter.ts snapshot 与 presets.ts 经理评价节点（with_approve，可编辑三字段）
function assessment() {
  const values = {
    assessmentName: '合成试用中考核',
    assessmentDate: '2026-10-20',
    selfEvaluation: '合成自评',
    managerRating: null,
    regularizationOpinion: null,
    regularizationDate: null,
  };
  return {
    id: instance,
    title: '合成试用中考核申请',
    revision: 3,
    status: 'running',
    approvalType: 'probation_assessment',
    actions: ['approve'],
    recordsHidden: false,
    form: {
      values,
      edit: {
        taskId: task,
        mode: 'with_approve',
        fields: ['managerRating', 'regularizationOpinion', 'regularizationDate'].map((key) => ({
          key,
          required: false,
          value: null,
        })),
      },
    },
    tasks: [{ id: task, nodeName: '经理评价', status: 'pending', assigneeUserId: user }],
    logs: [],
  };
}
test('AC-FE-R2c1-06 F-297 考核审批编辑：提前转正时转正日期必填，填了才提交', async ({ page }) => {
  const current = assessment();
  const bodies: unknown[] = [];
  await page.route('**/api/tenant/approval/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith(`/tasks/${task}/approve`)) {
      bodies.push(route.request().postDataJSON());
      return route.fulfill({ json: { ...current, revision: 4 } });
    }
    if (path.endsWith('/todos'))
      return route.fulfill({
        json: {
          items: [
            {
              taskId: task,
              instanceId: instance,
              title: current.title,
              nodeName: '经理评价',
              approvalType: 'probation_assessment',
              createdAt: '2026-10-20T01:00:00Z',
            },
          ],
        },
      });
    if (path.endsWith('/instances')) return route.fulfill({ json: { items: [] } });
    return route.fulfill({ json: current });
  });
  await page.goto('/approval');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.waitForURL('**/staff');
  await page.goto('/approval');
  await page.getByRole('button', { name: current.title, exact: true }).click();
  await page.getByRole('button', named('同意')).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('经理评价', { exact: true }).selectOption('exceeds');
  await form.getByLabel('转正意见', { exact: true }).selectOption('early');
  await expect(form.getByRole('note')).toContainText('提前转正 / 延期转正须填写转正日期');
  await expect(form.getByLabel('转正日期', { exact: true })).toHaveAttribute('aria-required', 'true');
  await form.getByRole('button', named('保存')).click();
  await expect(form.getByLabel('转正日期', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  expect(bodies).toHaveLength(0);
  await form.getByLabel('转正日期', { exact: true }).fill('2026-11-01');
  await form.getByRole('button', named('保存')).click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toMatchObject({
    fields: { managerRating: 'exceeds', regularizationOpinion: 'early', regularizationDate: '2026-11-01' },
  });
});
