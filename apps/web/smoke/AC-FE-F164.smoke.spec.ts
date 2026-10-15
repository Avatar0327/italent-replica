// F-164（DEC-518 / DEC-523）与 F-155b：发展计划查看权限、我辅导的发展计划、中期回顾填写。
// 夹具照后端真实形态（r3d2-fixtures：tutor-plans 行、403 IDP_PLAN_NO_VISIBLE_MODULE、PUT 模块内容回完整详情）。
import type { Page } from '@playwright/test';
import { test, expect, user } from './fixtures.js';
import { basicOnlyId, mockIdp, planId, reviewTaskId, type IdpCall } from './r3d2-fixtures.js';
test.use({ viewport: { width: 1440, height: 1000 } });

const CONTENT = /^\/plans\/[^/]+\/modules\/[^/]+\/content$/;
const puts = (calls: IdpCall[]) => calls.filter((call) => call.method === 'PUT' && CONTENT.test(call.path));
const approves = (calls: IdpCall[]) => calls.filter((call) => call.path === `/approval/tasks/${reviewTaskId}/approve`);

/** 浏览器把 4xx / 5xx 响应记成控制台错误；只放过本例预期的状态码。 */
function watchErrors(page: Page, expected: string[] = []) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !expected.some((status) => m.text().includes(status))) errors.push(m.text());
  });
  return errors;
}
async function asUser(page: Page) {
  await page.goto('/idp');
  await page.getByLabel('切换演示身份').selectOption(user);
  await expect(page).toHaveURL(/\/staff$/);
}
const reviewForm = (page: Page) => page.getByRole('region', { name: '总体回顾' });
/** 侧栏 员工自助 > 我的发展计划 下的两个同级入口（DEC-523）；目录收起时先展开。 */
async function sideNav(page: Page, label: '个人发展计划' | '我辅导的发展计划') {
  const sidebar = page.locator('.shell-sidebar');
  const item = sidebar.getByRole('menuitem', { name: label, exact: true });
  if (!(await item.isVisible())) await sidebar.getByRole('menuitem', { name: '我的发展计划', exact: true }).click();
  await item.click();
}

test('AC-FE-F164-01 本人打开无可见模块的计划：原站空状态，链接回个人发展计划，不给重试', async ({ page }) => {
  const errors = watchErrors(page, ['403']);
  await mockIdp(page);
  await asUser(page);
  await page.goto('/self/idp');
  await expect(page.getByRole('heading', { name: '个人发展计划' })).toBeVisible();
  // 列表照常列出（原站列表可见，打开才提示）
  await page.getByRole('button', { name: '合成基本信息计划', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/self/idp\\?plan=${basicOnlyId}$`));
  await expect(page.getByText('无权限查看当前发展计划~')).toBeVisible();
  await expect(page.getByRole('button', { name: /重\s*试/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /返\s*回/ })).toHaveCount(0);
  const link = page.getByRole('link', { name: '查看其它发展计划', exact: true });
  await expect(link).toHaveAttribute('href', '/self/idp');
  await link.click();
  await expect(page).toHaveURL(/\/self\/idp$/);
  await expect(page.getByRole('heading', { name: '个人发展计划' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('AC-FE-F164-02 我辅导的发展计划：侧栏同级入口、姓名与辅导员工分类筛选；无可见模块时链接回本页', async ({
  page,
}) => {
  const errors = watchErrors(page, ['403']);
  await mockIdp(page);
  await asUser(page);
  await page.goto('/self/idp');
  await sideNav(page, '我辅导的发展计划');
  await expect(page).toHaveURL(/\/self\/idp\/tutoring$/);
  await expect(page.getByRole('heading', { name: '我辅导的发展计划' })).toBeVisible();
  for (const name of ['名称', '姓名', '指导人', '状态', '当前步骤'])
    await expect(page.getByRole('columnheader', { name, exact: true })).toBeVisible();
  await expect(page.getByText('共3条')).toBeVisible();
  // 指导人就是本人（tutor-plans 返回指导人）
  await expect(page.getByRole('row', { name: /合成辅导计划/ }).getByRole('cell', { name: '合成员工甲' })).toBeVisible();
  await expect(page.locator('#idp-my-category').locator('..').locator('..')).toContainText('辅导对象');

  await page.locator('#idp-my-employee').click();
  await page.locator('.ant-select-item-option[title="合成员工丙"]').click();
  await expect(page.getByText('共2条')).toBeVisible();
  await expect(page.getByRole('button', { name: '合成参与计划', exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: '合成基本信息计划', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/self/idp/tutoring\\?plan=${basicOnlyId}$`));
  const link = page.getByRole('link', { name: '查看其它我辅导的发展计划', exact: true });
  await expect(page.getByText('无权限查看当前发展计划~')).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/self\/idp\/tutoring$/);

  await sideNav(page, '个人发展计划');
  await expect(page).toHaveURL(/\/self\/idp$/);
  expect(errors).toEqual([]);
});

test('AC-FE-F164-03 HR 打开无可见模块的计划：提示查看其它我辅导的发展计划', async ({ page }) => {
  const errors = watchErrors(page, ['403']);
  await mockIdp(page);
  await asUser(page);
  await page.goto(`/idp/plans?plan=${basicOnlyId}`);
  await expect(page.getByText('无权限查看当前发展计划~')).toBeVisible();
  await expect(page.getByRole('link', { name: '查看其它我辅导的发展计划', exact: true })).toHaveAttribute(
    'href',
    '/self/idp/tutoring',
  );
  await expect(page.getByRole('button', { name: /重\s*试/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('AC-FE-F164-04 中期回顾填写：两项必填、按码点计数，保存只发改过的字段并带版本，保存后显示新内容', async ({
  page,
}) => {
  const errors = watchErrors(page);
  const calls = await mockIdp(page, { reviewButtons: ['EditModuleContent'] });
  await asUser(page);
  await page.goto(`/self/idp?plan=${planId}`);
  const form = reviewForm(page);
  await expect(form.getByRole('heading', { name: '总体回顾' })).toBeVisible();
  await expect(form.locator('.ant-form-item-required')).toHaveCount(2);
  const summary = form.getByLabel('总结');
  await expect(summary).toHaveValue('合成阶段总结');
  await expect(form.getByLabel('改进方法')).toHaveValue('合成改进方法');
  await summary.fill('😀😀合成');
  await expect(form.getByText('4 / 1000')).toBeVisible();

  await summary.fill('合成新总结');
  await form.getByRole('button', { name: /保\s*存/ }).click();
  await expect.poll(() => puts(calls).length).toBe(1);
  expect(puts(calls)[0]).toMatchObject({ body: { summary: '合成新总结' }, revision: '3' });
  expect(puts(calls)[0]!.body).not.toHaveProperty('improvement');
  expect(puts(calls)[0]!.key).toBeTruthy();
  await expect(form.getByLabel('总结')).toHaveValue('合成新总结');
  await expect(form.getByRole('alert')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('AC-FE-F164-05 回顾超长：前端按码点拦下、提示最多 1000 字且不发请求；1000 个表情不算超长', async ({ page }) => {
  const errors = watchErrors(page);
  const calls = await mockIdp(page, { reviewButtons: ['EditModuleContent'] });
  await asUser(page);
  await page.goto(`/self/idp?plan=${planId}`);
  const form = reviewForm(page);
  await form.getByLabel('改进方法').fill('法'.repeat(1001));
  await form.getByRole('button', { name: /保\s*存/ }).click();
  await expect(form.getByText('最多 1000 字')).toBeVisible();
  expect(puts(calls)).toHaveLength(0);

  // 表情占两个 UTF-16 单元，按码点计 1000 个正好不超长（后端同口径）
  await form.getByLabel('改进方法').fill('😀'.repeat(1000));
  await expect(form.getByText('最多 1000 字')).toHaveCount(0);
  await form.getByRole('button', { name: /保\s*存/ }).click();
  await expect.poll(() => puts(calls).length).toBe(1);
  expect(puts(calls)[0]).toMatchObject({ body: { improvement: '😀'.repeat(1000) } });
  expect(errors).toEqual([]);
});

test('AC-FE-F164-06 回顾保存冲突：重读最新版本、核对差异后带新版本重提，保留我的输入', async ({ page }) => {
  const errors = watchErrors(page, ['409']);
  const calls = await mockIdp(page, { reviewButtons: ['EditModuleContent'], conflictTimes: 1 });
  await asUser(page);
  await page.goto(`/self/idp?plan=${planId}`);
  const form = reviewForm(page);
  await form.getByLabel('总结').fill('合成我的总结');
  await form.getByRole('button', { name: /保\s*存/ }).click();
  await expect(form.getByText(/版本冲突/)).toBeVisible();
  await expect(form.getByLabel('总结')).toBeDisabled();
  await form.getByRole('button', { name: '重读最新版本' }).click();
  // 差异表：别人保存的总结与我的输入并列
  await expect(form.getByRole('cell', { name: '"合成他人保存的总结"' })).toBeVisible();
  await expect(form.getByRole('cell', { name: '"合成我的总结"' })).toBeVisible();
  await form.getByRole('button', { name: '已核对差异，继续编辑' }).click();
  await expect(form.getByLabel('总结')).toHaveValue('合成我的总结');
  await form.getByRole('button', { name: /保\s*存/ }).click();
  await expect.poll(() => puts(calls).length).toBe(2);
  expect(puts(calls)[1]).toMatchObject({ body: { summary: '合成我的总结' }, revision: '4' });
  expect(puts(calls)[1]!.key).not.toBe(puts(calls)[0]!.key);
  // 重提的回执版本前进（4 → 5）：按已保存解锁
  await expect(form.getByLabel('总结')).toBeEnabled();
  await expect(form.getByText(/结果待确认|版本冲突/)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('AC-FE-F164-07 回顾保存结果未知：表单与同一计划的任务入口一并锁定，回查原单后仍锁定，不发第二次 PUT', async ({
  page,
}) => {
  const errors = watchErrors(page, ['500']);
  const calls = await mockIdp(page, { reviewButtons: ['EditModuleContent'], writeStatus: 500 });
  await asUser(page);
  await page.goto(`/self/idp?plan=${planId}`);
  const form = reviewForm(page);
  await form.getByLabel('总结').fill('合成未知总结');
  await form.getByRole('button', { name: /保\s*存/ }).click();
  await expect(form.getByText(/结果待确认/)).toBeVisible();
  await expect(form.getByLabel('总结')).toBeDisabled();
  await expect(form.getByRole('button', { name: /保\s*存/ })).toBeDisabled();
  // F-147：回顾命令在计划的恢复槽，同一计划上的制定任务一并锁定并提示（表单外）
  await expect(page.getByText('本对象有未确认的其他操作，确认结果前不能发起新操作。')).toBeVisible();
  await expect(page.getByRole('button', { name: '添加任务' })).toBeDisabled();
  await form.getByRole('button', { name: '回查原单' }).click();
  await expect(form.getByText('原单当前值（仅供核对，不能据此确认本次命令结果）')).toBeVisible();
  await expect(form.getByLabel('总结')).toBeDisabled();
  await form.getByRole('button', { name: /保\s*存/ }).click({ force: true });
  expect(puts(calls)).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('AC-FE-F164-08 从正常菜单进入：全部菜单 > 员工自助，侧栏我的发展计划下两个同级入口', async ({ page }) => {
  const errors = watchErrors(page);
  await mockIdp(page);
  await asUser(page);
  await page.getByRole('button', { name: '应用导航' }).click();
  await page.getByRole('dialog', { name: '全部菜单' }).getByRole('link', { name: '员工自助', exact: true }).click();
  await expect(page).toHaveURL(/\/self$/);
  const sidebar = page.locator('.shell-sidebar');
  // 侧栏只在首次加载时展开当前应用；从全部菜单跳过来时先展开员工自助（底座原有行为）
  await sidebar.getByRole('menuitem', { name: '员工自助', exact: true }).click();
  await sidebar.getByRole('menuitem', { name: '我的发展计划', exact: true }).click();
  const own = sidebar.getByRole('menuitem', { name: '个人发展计划', exact: true });
  const tutoring = sidebar.getByRole('menuitem', { name: '我辅导的发展计划', exact: true });
  await expect(own).toBeVisible();
  await expect(tutoring).toBeVisible();
  await own.click();
  await expect(page).toHaveURL(/\/self\/idp$/);
  await expect(page.getByRole('heading', { name: '个人发展计划' })).toBeVisible();
  await tutoring.click();
  await expect(page).toHaveURL(/\/self\/idp\/tutoring$/);
  await expect(page.getByRole('heading', { name: '我辅导的发展计划' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('AC-FE-F164-09 回顾结果未知后切换入口再回来：仍锁定，不能以新命令重发', async ({ page }) => {
  const errors = watchErrors(page, ['500']);
  const calls = await mockIdp(page, { reviewButtons: ['EditModuleContent'], writeStatus: 500 });
  await asUser(page);
  await page.goto(`/self/idp?plan=${planId}`);
  await reviewForm(page).getByLabel('总结').fill('合成未知总结');
  await reviewForm(page)
    .getByRole('button', { name: /保\s*存/ })
    .click();
  await expect(reviewForm(page).getByText(/结果待确认/)).toBeVisible();
  await page.getByRole('button', { name: /返\s*回/ }).click();
  // 切到同级入口再切回：页面按路径重建，命令仍在模块级存储里
  await sideNav(page, '我辅导的发展计划');
  await expect(page.getByRole('heading', { name: '我辅导的发展计划' })).toBeVisible();
  await sideNav(page, '个人发展计划');
  await page.getByRole('button', { name: '合成发展计划', exact: true }).click();
  const form = reviewForm(page);
  await expect(form.getByText(/结果待确认/)).toBeVisible();
  await expect(form.getByLabel('总结')).toBeDisabled();
  await expect(form.getByRole('button', { name: /保\s*存/ })).toBeDisabled();
  await form.getByRole('button', { name: /保\s*存/ }).click({ force: true });
  expect(puts(calls)).toHaveLength(1);
  expect(errors).toEqual([]);
});

const BAD_RECEIPTS = [
  ['10', 'without-revision', '缺 revision'],
  ['11', 'stale-revision', 'revision 没前进'],
] as const;
for (const [no, receipt, what] of BAD_RECEIPTS)
  test(`AC-FE-F164-${no} 回顾保存回执${what}：按结果未知锁定，不当成已保存`, async ({ page }) => {
    const errors = watchErrors(page);
    const calls = await mockIdp(page, { reviewButtons: ['EditModuleContent'], reviewReceipt: receipt });
    await asUser(page);
    await page.goto(`/self/idp?plan=${planId}`);
    const form = reviewForm(page);
    await form.getByLabel('总结').fill('合成回执总结');
    await form.getByRole('button', { name: /保\s*存/ }).click();
    await expect.poll(() => puts(calls).length).toBe(1);
    await expect(form.getByText(/结果待确认/)).toBeVisible();
    await expect(form.getByLabel('总结')).toBeDisabled();
    await expect(form.getByRole('button', { name: /保\s*存/ })).toBeDisabled();
    await expect(page.getByRole('button', { name: '添加任务' })).toBeDisabled();
    expect(errors).toEqual([]);
  });

// 提交（送审）路径的前端必填（F-164 第 1 轮 P2-4）：两项去空白后非空才发请求，缺项定位到字段，口径同后端 IDP_REVIEW_REQUIRED。
const MISSING = [
  ['12', '改进方法', '', '缺项'],
  ['13', '总结', '  \n　 ', '纯空白'],
] as const;
for (const [no, field, value, what] of MISSING)
  test(`AC-FE-F164-${no} 回顾提交${what}：${field}报“还没有填写，不能提交”并定位，不保存也不提交`, async ({ page }) => {
    const errors = watchErrors(page);
    const calls = await mockIdp(page, { reviewButtons: ['EditModuleContent'], reviewApproval: 'mine' });
    await asUser(page);
    await page.goto(`/self/idp?plan=${planId}`);
    const form = reviewForm(page);
    await form.getByLabel(field).fill(value);
    await form.getByRole('button', { name: /提\s*交/ }).click();
    await expect(form.getByText(`${field}还没有填写，不能提交`)).toBeVisible();
    await expect(form.getByLabel(field)).toBeFocused();
    await page.waitForTimeout(300);
    expect(calls).toHaveLength(0);
    expect(errors).toEqual([]);
  });

test('AC-FE-F164-14 回顾保存草稿可空；填齐后提交：先保存改动，再同意本人待办（带幂等键与实例版本）', async ({
  page,
}) => {
  const errors = watchErrors(page);
  const calls = await mockIdp(page, { reviewButtons: ['EditModuleContent'], reviewApproval: 'mine' });
  await asUser(page);
  await page.goto(`/self/idp?plan=${planId}`);
  const form = reviewForm(page);
  await form.getByLabel('总结').fill('');
  await form.getByRole('button', { name: /保\s*存/ }).click();
  await expect.poll(() => puts(calls).length).toBe(1);
  await expect(form.getByText(/还没有填写/)).toHaveCount(0);
  expect(approves(calls)).toHaveLength(0);

  await form.getByLabel('总结').fill('合成提交总结');
  await form.getByRole('button', { name: /提\s*交/ }).click();
  await expect.poll(() => approves(calls).length).toBe(1);
  expect(puts(calls)).toHaveLength(2);
  expect(puts(calls)[1]).toMatchObject({ body: { summary: '合成提交总结' } });
  expect(calls.indexOf(puts(calls)[1]!)).toBeLessThan(calls.indexOf(approves(calls)[0]!));
  expect(approves(calls)[0]).toMatchObject({ method: 'POST', revision: '7', body: { comment: null } });
  expect(approves(calls)[0]!.key).toBeTruthy();
  await expect(form.getByText(/结果待确认|版本冲突/)).toHaveCount(0);
  // 已提交：本人不再有在办待办，提交入口收起
  await expect(form.getByRole('button', { name: /提\s*交/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('AC-FE-F164-15 在办待办是别人的（本人无同意动作）：不给提交入口，不发同意请求', async ({ page }) => {
  const errors = watchErrors(page);
  const calls = await mockIdp(page, { reviewButtons: ['EditModuleContent'], reviewApproval: 'others' });
  await asUser(page);
  await page.goto(`/self/idp?plan=${planId}`);
  const form = reviewForm(page);
  await expect(form.getByRole('button', { name: /保\s*存/ })).toBeEnabled();
  await page.waitForTimeout(300);
  await expect(form.getByRole('button', { name: /提\s*交/ })).toHaveCount(0);
  expect(approves(calls)).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('AC-FE-F164-16 提交前的保存结果未知：不发同意，表单与提交一并锁定', async ({ page }) => {
  const errors = watchErrors(page, ['500']);
  const calls = await mockIdp(page, {
    reviewButtons: ['EditModuleContent'],
    reviewApproval: 'mine',
    writeStatus: 500,
  });
  await asUser(page);
  await page.goto(`/self/idp?plan=${planId}`);
  const form = reviewForm(page);
  await form.getByLabel('总结').fill('合成提交总结');
  await form.getByRole('button', { name: /提\s*交/ }).click();
  await expect(form.getByText(/结果待确认/)).toBeVisible();
  await expect(form.getByRole('button', { name: /提\s*交/ })).toBeDisabled();
  await form.getByRole('button', { name: /提\s*交/ }).click({ force: true });
  await page.waitForTimeout(300);
  expect(puts(calls)).toHaveLength(1);
  expect(approves(calls)).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('AC-FE-F164-17 同意回执 revision 没前进：按结果未知锁定，不当成已提交、不发第二次同意', async ({ page }) => {
  const errors = watchErrors(page);
  const calls = await mockIdp(page, {
    reviewButtons: ['EditModuleContent'],
    reviewApproval: 'mine',
    approveReceipt: 'stale-revision',
  });
  await asUser(page);
  await page.goto(`/self/idp?plan=${planId}`);
  const form = reviewForm(page);
  await form.getByLabel('总结').fill('合成提交总结');
  await form.getByRole('button', { name: /提\s*交/ }).click();
  await expect.poll(() => approves(calls).length).toBe(1);
  await expect(form.getByText(/结果待确认/)).toBeVisible();
  await expect(form.getByLabel('总结')).toBeDisabled();
  // 待办在服务端已办结，但命令未确认：入口保留并锁定，不因待办消失而收起
  await expect(form.getByRole('button', { name: /提\s*交/ })).toBeDisabled();
  await form.getByRole('button', { name: /提\s*交/ }).click({ force: true });
  await page.waitForTimeout(300);
  expect(approves(calls)).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('AC-FE-F155b-01 被跳过的阶段在流程条上显示“已终止”，不显示“已结束”', async ({ page }) => {
  const errors = watchErrors(page);
  await mockIdp(page, { skippedFirstStage: true });
  await asUser(page);
  await page.goto(`/self/idp?plan=${planId}`);
  const steps = page.locator('.idp-stage-steps .ant-steps-item');
  await expect(steps.filter({ hasText: '制定计划' })).toContainText('已终止');
  await expect(steps.filter({ hasText: '制定计划' })).not.toContainText('已结束');
  await expect(steps.filter({ hasText: '中期回顾' })).toContainText('进行中');
  expect(errors).toEqual([]);
});
