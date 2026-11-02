import type { Page, Request } from '@playwright/test';
import { test, expect, employee } from './fixtures.js';
import { applicationId, business, employeeRevision, openDetail, rows, setup } from './intern-fixtures.js';

// F-436（F-376 审查 P3）：实习转正申请写确认成功后，HR 所在的列表随之重读，不论迟到回调是否还能导航。
const dialog = (page: Page) => page.getByRole('dialog', { name: '实习转正申请', exact: true });
const heading = (page: Page) => page.getByRole('heading', { name: '实习生', exact: true });
const viewButton = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const pending = (page: Page) => page.getByRole('cell', { name: '审批中', exact: true });
const posted = (request: Request) => ({ body: request.postDataJSON() as Record<string, unknown> });

/** 与站内进入等价的同文档历史：先在 from，再 PUSH 进入实习生列表（History API + router popstate）。 */
async function enterFrom(page: Page, from: string) {
  await page.evaluate((path) => {
    history.replaceState({ ...history.state, key: 'f436-from' }, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  }, from);
  await page.evaluate(() => {
    const old = history.state as { idx?: number } | null;
    history.pushState({ ...old, key: 'f436-entry', idx: (old?.idx ?? 0) + 1 }, '', '/interns');
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  });
  await expect(heading(page)).toBeVisible();
}

/**
 * 实习转正申请两步真实回执（POST 创建草稿 → submit）。第二步 submit 可受控挂起，放行时服务端才落库：
 * 落库前“实习转正中”没有本单、“实习中”有此人；落库后本单进“实习转正中”（审批中，revision 2），“实习中”不再有此人。
 * 形态同 intern-fixtures（intern-routes.ts trimInternItems / types.ts EmploymentBusiness）。
 */
async function application(page: Page, from: string) {
  const fixture = await setup(page);
  const created: ReturnType<typeof posted>[] = [];
  const submitted: ReturnType<typeof posted>[] = [];
  const lists: string[] = [];
  const state = { committed: false, hold: false, release: undefined as (() => void) | undefined };
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
  await page.route(`**/employment/businesses/${applicationId}`, (route) =>
    route.fulfill({ json: state.committed ? receipt('in_review', 2) : receipt('draft', 1) }),
  );
  await page.route(`**/employment/businesses/${applicationId}/submit`, async (route) => {
    submitted.push(posted(route.request()));
    if (state.hold) await new Promise<void>((resolve) => (state.release = resolve));
    state.committed = true;
    return route.fulfill({ json: receipt('in_review', 2) });
  });
  await page.route('**/employment/interns?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    const view = (query.get('view') ?? 'interning') as keyof typeof rows;
    lists.push(view);
    const items =
      view === 'converting'
        ? state.committed
          ? [{ ...rows.converting, revision: 2 }]
          : []
        : view === 'interning' && state.committed
          ? []
          : [rows[view]];
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
  return { created, submitted, lists, state };
}

/** 提交后等到第二步 submit 确实在途（挂起中，服务端尚未落库）。 */
async function submitAndHold(page: Page, state: { hold: boolean; release?: () => void }) {
  state.hold = true;
  await dialog(page)
    .getByRole('button', { name: /提\s*交$/ })
    .click();
  await expect.poll(() => !!state.release).toBe(true);
}

test('AC-FE-F436-01 提交在途时后退回到实习转正中列表，确认成功后列表出现本单，无需手动刷新', async ({ page }) => {
  const { created, submitted, lists, state } = await application(page, '/interns?view=converting');
  await submitAndHold(page, state);
  const stale = page.waitForResponse((response) => response.url().includes('view=converting'));
  await page.goBack();
  await stale;
  await expect(page).toHaveURL(/\/interns\?view=converting$/);
  await expect(viewButton(page, '实习转正中')).toHaveAttribute('aria-pressed', 'true');
  // 落库前读到的列表：还没有本单
  await expect(page.locator('.intern-table')).toContainText('暂无实习生');
  await expect(pending(page)).toHaveCount(0);
  const before = lists.length;
  state.release!();
  await expect(page.getByText('实习转正申请提交成功')).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
  await expect(pending(page)).toBeVisible();
  await expect(page).toHaveURL(/\/interns\?view=converting$/);
  expect(lists.slice(before)).toContain('converting');
  expect(created).toHaveLength(1);
  expect(submitted).toHaveLength(1);
});

test('AC-FE-F436-02 正常路径：页面仍在、确认后导航到实习转正中，列表就是落库后的新数据', async ({ page }) => {
  const { created, submitted, state } = await application(page, '/staff');
  await submitAndHold(page, state);
  await expect(pending(page)).toHaveCount(0);
  state.release!();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/interns\?view=converting$/);
  await expect(viewButton(page, '实习转正中')).toHaveAttribute('aria-pressed', 'true');
  await expect(pending(page)).toBeVisible();
  expect(created).toHaveLength(1);
  expect(submitted).toHaveLength(1);
});
