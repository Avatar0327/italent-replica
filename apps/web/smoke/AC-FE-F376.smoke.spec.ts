import type { Page, Request } from '@playwright/test';
import { test, expect, employee } from './fixtures.js';
import { applicationId, business, employeeRevision, openDetail, rows, setup } from './intern-fixtures.js';
import {
  company,
  editor,
  fillCreate,
  openCreate,
  receipt as createReceipt,
  saveCreate,
  sent,
  setupCreate,
} from './intern-create-fixtures.js';

// F-376（F-285 R3 P2-R3-F1）：已发出的写命令照常确认，但离页 / 期间发生导航后，迟到回调不得再导航。
const dialog = (page: Page) => page.getByRole('dialog', { name: '实习转正申请', exact: true });
const heading = (page: Page) => page.getByRole('heading', { name: '实习生', exact: true });
const posted = (request: Request) => ({ body: request.postDataJSON() as Record<string, unknown> });

/** 与站内进入等价的同文档历史：先在 /staff，再 PUSH 进入 entry（History API + router popstate）。 */
async function enterFrom(page: Page, from: string, entry = '/interns') {
  await page.evaluate((path) => {
    history.replaceState({ ...history.state, key: 'f376-from' }, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  }, from);
  await page.evaluate((path) => {
    const old = history.state as { idx?: number } | null;
    history.pushState({ ...old, key: 'f376-entry', idx: (old?.idx ?? 0) + 1 }, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  }, entry);
  await expect(heading(page)).toBeVisible();
}

/** 实习转正申请两步真实回执（POST 创建 → submit），提交后的本单 GET 回读可受控挂起。 */
async function application(page: Page, from = '/staff') {
  const fixture = await setup(page);
  const created: ReturnType<typeof posted>[] = [];
  const submitted: ReturnType<typeof posted>[] = [];
  const state = { submitted: false, hold: false, release: undefined as (() => void) | undefined };
  const receipt = (status: string, revision: number) =>
    business('intern_regularization', {
      id: applicationId,
      status,
      revision,
      mode: 'application',
      probation: false,
      probationMonths: null,
      probationEndDate: null,
      ...created.at(-1)?.body,
    });
  await page.route(`**/employment/employees/${employee}/businesses`, (route) => {
    created.push(posted(route.request()));
    fixture.server.employeeRevision = employeeRevision + 1;
    return route.fulfill({ status: 201, json: receipt('draft', 1) });
  });
  await page.route(`**/employment/businesses/${applicationId}`, async (route) => {
    if (state.submitted && state.hold) await new Promise<void>((resolve) => (state.release = resolve));
    await route.fulfill({ json: state.submitted ? receipt('in_review', 2) : receipt('draft', 1) });
  });
  await page.route(`**/employment/businesses/${applicationId}/submit`, (route) => {
    submitted.push(posted(route.request()));
    state.submitted = true;
    return route.fulfill({ json: receipt('in_review', 2) });
  });
  await page.route('**/employment/interns?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    const view = query.get('view') ?? 'interning';
    // 提交后只有实习转正中有本单（revision 2）；提交前各视图按夹具一行
    const converting = view === 'converting' ? [{ ...rows.converting, revision: 2 }] : [];
    const items = state.submitted ? converting : [rows[view as keyof typeof rows]];
    return route.fulfill({ json: { items, page: Number(query.get('page')), pageSize: 30, hasDataPermission: true } });
  });
  await enterFrom(page, from);
  await openDetail(page, 'interning');
  await page.getByRole('button', { name: '实习转正申请', exact: true }).click();
  const input = dialog(page).locator('.ant-form-item').filter({ hasText: '实习转正日期' }).locator('input');
  await input.fill('2026-10-16');
  await input.press('Enter');
  await dialog(page).locator('.ant-modal-title').click();
  await dialog(page).getByRole('radio', { name: '否', exact: true }).check();
  return { created, submitted, state };
}

/** 提交后等到本单回读确实在途（挂起中）。 */
async function submitAndHold(page: Page, state: { hold: boolean; release?: () => void }) {
  state.hold = true;
  await dialog(page)
    .getByRole('button', { name: /提\s*交$/ })
    .click();
  await expect.poll(() => !!state.release).toBe(true);
}

test('AC-FE-F376-01 本单回读在途时后退离开，迟到成功不把用户拉回实习转正中', async ({ page }) => {
  const { created, submitted, state } = await application(page);
  await submitAndHold(page, state);
  await page.goBack();
  await expect(heading(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/staff$/);
  state.release!();
  await expect(page.getByText('实习转正申请提交成功')).toBeVisible();
  await expect(page).toHaveURL(/\/staff$/);
  await expect(heading(page)).toHaveCount(0);
  expect(created).toHaveLength(1);
  expect(submitted).toHaveLength(1);
});

test('AC-FE-F376-02 回读在途时页内后退换了视图，迟到成功不再切回实习转正中', async ({ page }) => {
  const { created, submitted, state } = await application(page, '/interns?view=converted');
  await submitAndHold(page, state);
  await page.goBack();
  await expect(page).toHaveURL(/\/interns\?view=converted$/);
  await expect(page.getByRole('button', { name: '已转正', exact: true })).toHaveAttribute('aria-pressed', 'true');
  state.release!();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByText('实习转正申请提交成功')).toBeVisible();
  await expect(page).toHaveURL(/\/interns\?view=converted$/);
  await expect(page.getByRole('button', { name: '已转正', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(created).toHaveLength(1);
  expect(submitted).toHaveLength(1);
});

test('AC-FE-F376-03 正向：页面仍在时回读返回，照常切到实习转正中并定位', async ({ page }) => {
  const { created, submitted, state } = await application(page);
  await submitAndHold(page, state);
  state.release!();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/interns\?view=converting$/);
  await expect(page.getByRole('button', { name: '实习转正中', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('cell', { name: '审批中', exact: true })).toBeVisible();
  expect(created).toHaveLength(1);
  expect(submitted).toHaveLength(1);
});

test('AC-FE-F376-04 新增实习生保存在途时后退离开，迟到回执不跳到待入职', async ({ page }) => {
  const state = await setupCreate(page);
  let release: (() => void) | undefined;
  await page.route('**/employment/interns', async (route) => {
    state.requests.push(sent(route.request()));
    await new Promise<void>((resolve) => (release = resolve));
    await route.fulfill({
      status: 201,
      json: createReceipt({
        view: 'pendingEntry',
        contract: { stage: 'pending', id: null, startDate: '2026-11-01', endDate: '2027-10-11', companyId: company },
      }),
    });
  });
  await enterFrom(page, '/staff');
  await openCreate(page);
  await fillCreate(page, true);
  await saveCreate(page).click();
  await expect.poll(() => !!release).toBe(true);
  await page.goBack();
  await expect(heading(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/staff$/);
  release!();
  await expect(page.getByText('新增实习生成功')).toBeVisible();
  await expect(page).toHaveURL(/\/staff$/);
  await expect(editor(page)).toHaveCount(0);
  expect(state.requests).toHaveLength(1);
});
