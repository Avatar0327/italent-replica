import { test, expect, snapshotFixture, tenant, user } from './fixtures.js';
import type { Page } from '@playwright/test';
import { listFixture, offerFields, offerPermission, offerRow } from './offer-list-fixture.js';

const named = (name: string) => ({ name, exact: true });
const failures = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page, baseURL }) => {
  const unexpected: string[] = [];
  failures.set(page, unexpected);
  page.on('pageerror', (error) => unexpected.push(error.message));
  page.on('request', (request) => {
    if (request.url().includes('/api/') && request.method() !== 'GET') unexpected.push(request.url());
  });
  await page.context().addCookies([
    { name: 'italent_demo_tenant', value: tenant, url: baseURL! },
    { name: 'italent_demo_user', value: user, url: baseURL! },
  ]);
  await page.route('**/permission/me/objects/**', (route) => route.fulfill({ json: offerPermission }));
  await page.route('**/api/tenant/offers**', (route) => {
    const url = new URL(route.request().url());
    const view = url.searchParams.get('view') ?? 'pending';
    const row = {
      ...Object.fromEntries(offerFields.map((field) => [field, null])),
      ...offerRow,
      status: ['unsubmitted', 'approving', 'approved', 'all'].includes(view) ? 'pending' : view,
    };
    if (url.pathname.endsWith(offerRow.id)) return route.fulfill({ json: offerRow });
    const count = url.searchParams.get('pageSize') === '1';
    const second = url.searchParams.get('page') === '2';
    const filtered = url.searchParams.has('name');
    const items = Array.from({ length: count || filtered ? 1 : second ? 2 : 15 }, (_, index) => ({
      ...row,
      id: index ? `40000000-0000-4000-8000-${String(index).padStart(12, '0')}` : offerRow.id,
      name: index ? `合成分页候选人${index}` : offerRow.name,
    }));
    return route.fulfill({ json: { ...listFixture(items), total: filtered ? 1 : 17 } });
  });
});
test.afterEach(async ({ page }) => {
  expect(failures.get(page)).toEqual([]);
});
async function open(page: Page) {
  await page.goto('/offers');
  await expect(page.getByRole('heading', named('Offer管理'))).toBeVisible();
  await expect(page.getByRole('button', named(offerRow.name))).toBeVisible();
}
async function view(page: Page, name: string) {
  if (['未发起审批', '审批中', '审批通过'].includes(name)) {
    await page.getByRole('button', named('待发二级视图')).click();
    await page.getByRole('menuitem', named(name)).click();
  } else await page.getByRole('button', named(name)).click();
  await expect(page.getByRole('button', named(offerRow.name))).toBeVisible();
}
async function menu(page: Page) {
  await page.getByRole('row').filter({ hasText: offerRow.name }).getByRole('button', named('行操作')).click();
  return page.getByRole('menu').last();
}

test('AC-FE-R2b1-01 十视图与列宽保留，列表不再标演示数据', async ({ page }) => {
  await open(page);
  expect(Math.round((await page.getByRole('columnheader', named('个人邮箱')).boundingBox())!.width)).toBe(140);
  await expect(page.locator('.offers-page').getByText('演示数据', { exact: true })).toHaveCount(0);
  for (const [name, column] of [
    ['待发Offer', '当前审批人'],
    ['未发起审批', '批量发起审批结果'],
    ['审批中', '当前审批节点'],
    ['审批通过', '面试评价'],
    ['已发Offer', 'Offer发送日期'],
    ['已接受Offer', '接受offer日期'],
    ['已拒绝Offer', '拒绝原因备注'],
    ['已入职Offer', '入职日期'],
    ['全部Offer', 'offer状态'],
    ['失效Offer', '失效时间'],
  ]) {
    await view(page, name!);
    await expect(page.getByRole('columnheader', named(column!))).toHaveCount(1);
  }
});
test('AC-FE-R2b1-02 转移和失效服从服务端行操作且只读，不再开放演示提交', async ({ page }) => {
  await open(page);
  const items = await menu(page);
  await expect(items.getByRole('menuitem', named('转移状态'))).toHaveAttribute('aria-disabled', 'true');
  await expect(items.getByRole('menuitem', named('失效Offer'))).toHaveAttribute('aria-disabled', 'true');
});
test('AC-FE-R2b1-03 工具栏写操作禁用，不创建写请求', async ({ page }) => {
  await open(page);
  await view(page, '已发Offer');
  await expect(page.locator('.page-heading').getByRole('button', named('转移状态'))).toBeDisabled();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
test('AC-FE-R2b1-04 详情独立读取，保留分区与拒绝历史隐藏边界', async ({ page }) => {
  await open(page);
  await page.getByRole('button', named(offerRow.name)).click();
  const detail = page.getByRole('dialog');
  await expect(detail).toContainText('合同信息');
  await expect(detail).not.toContainText('拒绝offer时间');
  await expect(detail).not.toContainText('拒绝原因');
});
test('AC-FE-R2b1-05 查看行操作打开真实详情，关闭后列表仍在', async ({ page }) => {
  await open(page);
  await (await menu(page)).getByRole('menuitem', named('查看Offer')).click();
  await expect(page.getByRole('dialog')).toContainText(offerRow.departmentFullName);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', named(offerRow.name))).toBeVisible();
});
test('AC-FE-R2b1-06 设置21项没有可编辑控件或写入口', async ({ page }) => {
  await open(page);
  await page.getByRole('link', named('入职设置')).click();
  const nav = page.getByRole('navigation', named('设置目录'));
  await expect(nav.getByRole('button')).toHaveCount(21);
  await page.screenshot({ animations: 'disabled', path: '../../.demo/fer2b1-settings.png' });
  for (const button of await nav.getByRole('button').all()) {
    await button.click();
    const content = page.getByRole('region', named('设置摘要'));
    await expect(
      content.locator('input:not([disabled]), textarea:not([disabled]), select:not([disabled])'),
    ).toHaveCount(0);
    await expect(content.getByRole('button', { name: /新建|编辑|删除|保存|启用|停用/ })).toHaveCount(0);
  }
  await nav.getByRole('button', named('Offer管理授权模式')).click();
  await expect(page.getByRole('region', named('设置摘要'))).toContainText('仅按管理单元授权');
});

test('AC-FE-R2b1-07 入口遵守服务端快照，不能直达绕过', async ({ page }) => {
  await page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        apps: snapshotFixture.apps.map((app) => (app.app === 'transfer' ? { ...app, entryObjects: [] } : app)),
      },
    }),
  );
  await page.goto('/offers/settings');
  await expect(page.getByRole('menuitem', named('Offer管理'))).toHaveCount(0);
  await expect(page.getByText('暂无访问权限', { exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', named('设置目录'))).toHaveCount(0);
});

test('AC-FE-R2b1-08 已拒绝只开放读取，不再提供假的拒绝确认表单', async ({ page }) => {
  await open(page);
  await view(page, '已拒绝Offer');
  await expect((await menu(page)).getByRole('menuitem', named('转移状态'))).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
test('AC-FE-R2b1-09 每页15条、服务端筛选、筛选与视图切换复位分页', async ({ page }) => {
  await open(page);
  await expect(page.locator('tbody tr[data-row-key]')).toHaveCount(15);
  await page.getByRole('listitem', named('下一页')).click();
  await expect(page.locator('tbody tr[data-row-key]')).toHaveCount(2);
  await page.getByRole('button', named('姓名 ▾')).click();
  const request = page.waitForRequest((r) => new URL(r.url()).searchParams.get('name') === offerRow.name);
  await page.getByRole('textbox', named('姓名')).fill(offerRow.name);
  expect(new URL((await request).url()).searchParams.get('page')).toBe('1');
  await expect(page.locator('tbody tr[data-row-key]')).toHaveCount(1);
  await page.getByRole('heading', named('Offer管理')).click();
  await view(page, '已接受Offer');
  await expect(page.locator('tbody tr[data-row-key]')).toHaveCount(15);
});
test('AC-FE-R2b1-10 待发数量与二级视图下拉同行，切换后仍保持同行', async ({ page }) => {
  await open(page);
  for (const name of ['待发Offer', '未发起审批', '审批中', '审批通过']) {
    await view(page, name);
    const card = page.locator('.offer-view').first();
    const count = (await card.locator('strong').boundingBox())!;
    const dropdown = (await card.getByRole('button', named('待发二级视图')).boundingBox())!;
    expect(Math.abs(count.y + count.height / 2 - dropdown.y - dropdown.height / 2)).toBeLessThan(2);
    expect(dropdown.x).toBeGreaterThanOrEqual(count.x + count.width);
  }
  await page.screenshot({ animations: 'disabled', path: '../../.demo/fer2b1-r2-card.png' });
});

test('AC-FE-R2b1-11 全部视图齿轮始终固定右侧，操作列仍随横向滚动', async ({ page }) => {
  await open(page);
  await view(page, '全部Offer');
  const scroller = page.locator('.offers-page .ant-table-content');
  const gear = page.getByRole('columnheader', named('列设置'));
  const actions = page.getByRole('columnheader', named('操作'));
  const container = (await scroller.boundingBox())!;
  const actionStart = (await actions.boundingBox())!.x;
  for (const left of [0, 300, 10000]) {
    await scroller.evaluate((element, value) => {
      element.scrollLeft = value;
    }, left);
    await expect
      .poll(async () => {
        const box = (await gear.boundingBox())!;
        return Math.abs(box.x + box.width - container.x - container.width);
      })
      .toBeLessThan(2);
  }
  expect((await actions.boundingBox())!.x).toBeLessThan(actionStart - 100);
  await expect(actions).not.toHaveCSS('position', 'sticky');
  await page.screenshot({ animations: 'disabled', path: '../../.demo/fer2b1-r2-all-right.png' });
});
