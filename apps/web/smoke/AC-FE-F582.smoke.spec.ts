import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { id, setupR3b } from './r3b-fixtures.js';

/**
 * F-582：antd 按钮 loading 结束后，离场中的 loading 图标不进入可访问名（真实 Chromium 的 accname）。
 * 关掉过渡后 rc-motion 等不到 transitionend，图标确定性地留在 DOM 里（F-579 查明的复现方式）。
 * 夹具：门户登录失败照 apps/api survey360/portal.ts（401 UNAUTHENTICATED）；评价表冲突照 AC-EV-F475。
 */
const PORTAL_TENANT = '10000000-0000-4000-8000-000000000001';
const LOGIN_FAILED = '您输入的密码和序列号不匹配，请重新输入';
const noTransition = (page: Page) => page.addStyleTag({ content: '* { transition: none !important; }' });

async function expectSettled(button: Locator, label: string) {
  await expect(button).not.toHaveClass(/(^|\s)ant-btn-loading(\s|$)/);
  // 图标仍在（离场未结束），但可访问名只剩按钮文字。
  await expect(button.locator('.ant-btn-loading-icon')).toHaveCount(1);
  await expect(button).toHaveAccessibleName(label);
}

test('AC-FE-F582 门户登录失败后按钮可访问名为「登 录」，加载中仍带 loading 且不重复提交', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let logins = 0;
  await page.route('**/api/survey360/portal/login', async (route) => {
    logins++;
    await held;
    await route.fulfill({ status: 401, json: { error: { code: 'UNAUTHENTICATED', message: LOGIN_FAILED } } });
  });
  await page.goto(`/survey360/portal/${PORTAL_TENANT}`);
  await noTransition(page);
  await page.getByLabel('序列号', { exact: true }).fill('合成序列号');
  await page.getByLabel('密码', { exact: true }).fill('合成口令');
  const login = page.locator('button[type="submit"]');
  await login.click();
  try {
    await expect.poll(() => logins).toBe(1);
    await expect(login.getByRole('img', { name: 'loading', exact: true })).toBeVisible();
    await expect(login).toHaveAccessibleName('loading 登 录');
    await login.click();
    expect(logins).toBe(1);
  } finally {
    release();
  }
  await expect(page.getByText(LOGIN_FAILED)).toBeVisible();
  await expectSettled(login, '登 录');
  await expect(login).toBeEnabled();
});

test('AC-FE-F582 评价表保存遇 409 后「确 定」按钮可访问名不带 loading', async ({ page }) => {
  const formRow = {
    id,
    revision: 1,
    name: '合成评价表',
    ownerOrgId: id,
    enabled: true,
    createdBy: id,
    scoreMode: 'by_indicator',
    fullScore: 100,
    passScore: 60,
    totalRule: 'average',
    votePassRatio: null,
    indicatorReference: false,
    weightWarning: null,
    items: [{ kind: 'general', generalItemId: id, name: '合成通用项', weight: 100 }],
  };
  await setupR3b(page, '/evaluation');
  await page.route('**/evaluation/evaluation-forms?*', (route) =>
    route.fulfill({ json: { items: [formRow], total: 1 } }),
  );
  await page.route(`**/evaluation/evaluation-forms/${id}`, (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: formRow });
    return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT' } } });
  });
  await page.locator('.evaluation-layout > .ant-menu').getByRole('menuitem', { name: '评价表', exact: true }).click();
  await page.getByRole('button', { name: /编\s*辑/, exact: true }).click();
  const form = page.locator('.evaluation-full-page');
  await noTransition(page);
  await form.getByLabel('评价表名称', { exact: true }).fill('合成草稿');
  const confirm = form.locator('button.ant-btn-primary').filter({ hasText: /确\s*定/ });
  await confirm.click();
  await expect(form).toContainText('版本冲突');
  await expectSettled(confirm, '确 定');
  // 冲突后内核锁定提交直到重读（现行设计）；核对差异后按钮可点，名称仍只是按钮文字。
  await form.getByRole('button', { name: '重读最新版本', exact: true }).click();
  await form.getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
  await expect(confirm).toBeEnabled();
  await expect(confirm).toHaveAccessibleName('确 定');
});
