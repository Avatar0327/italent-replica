// F-164（DEC-518 / DEC-523）与 F-155b：发展计划查看权限、我辅导的发展计划、中期回顾填写。
// 夹具照后端真实形态（r3d2-fixtures：tutor-plans 行、403 IDP_PLAN_NO_VISIBLE_MODULE、PUT 模块内容回完整详情）。
import type { Page } from '@playwright/test';
import { test, expect, user } from './fixtures.js';
import { basicOnlyId, mockIdp, planId, type IdpCall } from './r3d2-fixtures.js';
test.use({ viewport: { width: 1440, height: 1000 } });

const CONTENT = /^\/plans\/[^/]+\/modules\/[^/]+\/content$/;
const puts = (calls: IdpCall[]) => calls.filter((call) => call.method === 'PUT' && CONTENT.test(call.path));

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

test('AC-FE-F164-02 我辅导的发展计划：同级导航、姓名与辅导员工分类筛选；无可见模块时链接回本页', async ({ page }) => {
  const errors = watchErrors(page, ['403']);
  await mockIdp(page);
  await asUser(page);
  await page.goto('/self/idp');
  await page.getByRole('tab', { name: '我辅导的发展计划' }).click();
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

  await page.getByRole('tab', { name: '个人发展计划' }).click();
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
  expect(errors).toEqual([]);
});

test('AC-FE-F164-07 回顾保存结果未知：表单锁定，回查原单后仍锁定，不发第二次 PUT', async ({ page }) => {
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
  await form.getByRole('button', { name: '回查原单' }).click();
  await expect(form.getByText('原单当前值（仅供核对，不能据此确认本次命令结果）')).toBeVisible();
  await expect(form.getByLabel('总结')).toBeDisabled();
  await form.getByRole('button', { name: /保\s*存/ }).click({ force: true });
  expect(puts(calls)).toHaveLength(1);
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
