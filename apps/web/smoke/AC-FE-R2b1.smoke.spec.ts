import { test, expect, snapshotFixture, tenant, user } from './fixtures.js';
import type { Page } from '@playwright/test';

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
});

test.afterEach(async ({ page }) => {
  expect(failures.get(page)).toEqual([]);
});

const confirm = { name: /^确\s*定$/ };
async function open(page: Page) {
  await page.goto('/offers');
  await expect(page.getByRole('heading', named('Offer管理'))).toBeVisible();
}
async function view(page: Page, name: string) {
  if (['未发起审批', '审批中', '审批通过'].includes(name)) {
    await page.getByRole('button', named('待发二级视图')).click();
    await page.getByRole('menuitem', named(name)).click();
  } else await page.getByRole('button', named(name)).click();
}
async function menu(page: Page, person: string) {
  await page.getByRole('row').filter({ hasText: person }).getByRole('button', named('行操作')).click();
  return page.getByRole('menu').last();
}
async function target(page: Page, name: string) {
  await page.getByRole('dialog').getByLabel('offer状态', { exact: true }).click();
  await page
    .locator('.ant-select-dropdown:visible .ant-select-item-option-content')
    .filter({ hasText: new RegExp(`^${name}$`) })
    .click();
}

test('AC-FE-R2b1-01 菜单、十视图、列头与演示标识', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('menuitem', named('Offer管理'))).toBeVisible();
  expect(Math.round((await page.getByRole('columnheader', named('个人邮箱')).boundingBox())!.width)).toBe(140);
  await page.screenshot({ animations: 'disabled', path: '../../.demo/fer2b1-list.png' });
  await expect(page.locator('.offers-page').getByText('演示数据', { exact: true })).toBeVisible();
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

test('AC-FE-R2b1-02 AC-OF-16 拒绝主按钮与下拉、社招与实习失效边界', async ({ page }) => {
  await open(page);
  await expect(await menu(page, '合成社招甲')).toContainText('失效Offer');
  await page.keyboard.press('Escape');
  await expect(await menu(page, '合成实习乙')).not.toContainText('失效Offer');
  await page.keyboard.press('Escape');
  await view(page, '已拒绝Offer');
  const row = page.getByRole('row').filter({ hasText: '合成拒绝戊' });
  await expect(row.getByRole('button', named('转移状态'))).toBeEnabled();
  const items = await menu(page, '合成拒绝戊');
  await expect(items).not.toContainText('转移状态');
  await expect(items).not.toContainText('失效Offer');
});

test('AC-FE-R2b1-03 AC-OF-09 接受日期必填、超编确认、无写入', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/') && r.method() !== 'GET') requests.push(r.url());
  });
  await open(page);
  await view(page, '已发Offer');
  await (await menu(page, '合成超编丙')).getByRole('menuitem', named('转移状态')).click();
  await target(page, '已接受offer');
  const dialog = page.getByRole('dialog', named('转移状态'));
  await dialog.getByRole('button', confirm).click();
  await expect(dialog.getByText('必填', { exact: true })).toBeVisible();
  await dialog.getByLabel('接受offer时间', { exact: true }).fill('2026-11-02');
  await dialog.getByLabel('接受offer时间', { exact: true }).press('Tab');
  await dialog.getByRole('button', confirm).click();
  const capacity = page.getByRole('dialog').filter({ hasText: '已超出设定编制，是否继续操作？' });
  await expect(capacity).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: '../../.demo/fer2b1-capacity.png' });
  await capacity.getByRole('button', confirm).click();
  await expect(page.getByText('演示数据：未写入业务数据，状态不变', { exact: true })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: '合成超编丙' })).toBeVisible();
  expect(requests).toEqual([]);
});

test('AC-FE-R2b1-04 AC-OF-08 历史拒绝只在转移表单回显', async ({ page }) => {
  await open(page);
  await page.getByRole('button', named('合成退回己')).click();
  const detail = page.getByRole('dialog', named('合成退回己'));
  await expect(detail).toContainText('合同信息');
  await page.screenshot({ animations: 'disabled', path: '../../.demo/fer2b1-detail.png' });
  await expect(detail).not.toContainText('拒绝offer时间');
  await expect(detail).not.toContainText('拒绝原因');
  await expect(detail).not.toContainText('合成历史拒绝备注');
  await page.keyboard.press('Escape');
  await (await menu(page, '合成退回己')).getByRole('menuitem', named('转移状态')).click();
  await target(page, '已拒绝offer');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('拒绝offer时间', { exact: true })).toHaveValue('2026-09-08');
  await expect(dialog).toContainText('个人原因');
  await expect(dialog.getByLabel('备注', { exact: true })).toHaveValue('合成历史拒绝备注');
  await dialog.getByRole('button', confirm).click();
  await expect(page.getByRole('row').filter({ hasText: '合成退回己' })).toBeVisible();
});

test('AC-FE-R2b1-05 失效原因必填，确定直接关闭且状态不变', async ({ page }) => {
  await open(page);
  await (await menu(page, '合成社招甲')).getByRole('menuitem', named('失效Offer')).click();
  const dialog = page.getByRole('dialog', named('失效Offer'));
  await dialog.getByRole('button', confirm).click();
  await expect(dialog.getByText('必填', { exact: true })).toBeVisible();
  await dialog.getByLabel('失效原因', { exact: true }).click();
  await page
    .locator('.ant-select-dropdown:visible .ant-select-item-option-content')
    .filter({ hasText: /^候选人放弃$/ })
    .click();
  await dialog.getByRole('button', confirm).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('row').filter({ hasText: '合成社招甲' })).toBeVisible();
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

test('AC-FE-R2b1-08 拒绝日期与原因都必填，取消与确定均不改变列表', async ({ page }) => {
  await open(page);
  await (await menu(page, '合成社招甲')).getByRole('menuitem', named('转移状态')).click();
  await target(page, '已拒绝offer');
  const dialog = page.getByRole('dialog', named('转移状态'));
  await dialog.getByRole('button', confirm).click();
  await expect(dialog.getByText('必填', { exact: true })).toHaveCount(2);
  await dialog.getByLabel('拒绝offer时间', { exact: true }).fill('2026-11-03');
  await dialog.getByLabel('拒绝offer时间', { exact: true }).press('Tab');
  await dialog.getByRole('button', confirm).click();
  await expect(dialog.getByText('必填', { exact: true })).toHaveCount(1);
  await dialog.getByLabel('拒绝原因', { exact: true }).click();
  await page
    .locator('.ant-select-dropdown:visible .ant-select-item-option-content')
    .filter({ hasText: /^个人原因$/ })
    .click();
  await dialog.getByRole('button', confirm).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', named('合成社招甲'))).toBeVisible();
  await (await menu(page, '合成社招甲')).getByRole('menuitem', named('转移状态')).click();
  await target(page, '已拒绝offer');
  await expect(page.getByLabel('拒绝offer时间', { exact: true })).toHaveValue('');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^取\s*消$/ })
    .click();
  await expect(page.getByRole('button', named('合成社招甲'))).toBeVisible();
});

test('AC-FE-R2b1-09 每页15条、本地筛选、视图与分页清理选择', async ({ page }) => {
  await open(page);
  await expect(page.locator('tbody tr[data-row-key]')).toHaveCount(15);
  await page.getByRole('listitem', named('下一页')).click();
  await expect(page.locator('tbody tr[data-row-key]')).toHaveCount(2);
  await page.getByRole('button', named('姓名 ▾')).click();
  await page.getByRole('textbox', named('姓名')).fill('合成社招甲');
  await expect(page.locator('tbody tr[data-row-key]')).toHaveCount(1);
  await page.getByRole('heading', named('Offer管理')).click();
  await view(page, '已拒绝Offer');
  const toolbar = page.locator('.page-heading');
  await expect(toolbar.getByRole('button', named('转移状态'))).toBeDisabled();
  await page.getByRole('row').filter({ hasText: '合成拒绝戊' }).getByRole('checkbox').check();
  await expect(toolbar.getByRole('button', named('转移状态'))).toBeEnabled();
  await view(page, '已接受Offer');
  await expect(toolbar.getByRole('button', named('转移状态'))).toBeDisabled();
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
