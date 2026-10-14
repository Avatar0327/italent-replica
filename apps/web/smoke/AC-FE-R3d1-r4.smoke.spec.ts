import type { Locator, Request } from '@playwright/test';
import { test, expect } from './fixtures.js';
import {
  button,
  cancel,
  choose,
  ids,
  mockSuccession,
  openMenu,
  positionRecord,
  preferences,
  save,
  watchErrors,
} from './r3d1-fixtures.js';

// FE-R3d-1 第 4 轮：结果未知（写入其实已成功、回执丢失）后关闭重开，版本变了也不能换新命令再写一次（F-123）。
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeEach(async ({ page }) => mockSuccession(page));

const writes = (request: Request) => ['POST', 'PUT', 'DELETE'].includes(request.method());
// 回执丢失用 abort 模拟，浏览器会把它记成资源加载失败；其余控制台错误照常判失败。
const unexpected = (errors: string[]) => errors.filter((error) => !error.includes('net::ERR_FAILED'));
/** 结果未知：保存按钮被锁住，提示待确认。 */
async function settledUnknown(scope: Locator) {
  await expect(scope.getByText('处理中 / 结果待确认')).toBeVisible();
  await expect(save(scope)).not.toHaveClass(/(^|\s)ant-btn-loading(\s|$)/);
  await expect(save(scope)).toBeDisabled();
}

test('AC-FE-R3d1-24 偏好保存结果未知：关闭重读拿到新版本，重开仍锁定，不发第二个 PUT', async ({ page }) => {
  const errors = watchErrors(page);
  let server = { ...preferences, revision: 3 };
  const puts: Request[] = [];
  await page.route('**/succession/maps/position/preferences', (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: server });
    puts.push(request);
    // 服务端已写入（3 → 4），回执在路上丢了。
    server = { ...server, ...request.postDataJSON(), revision: 4 };
    return route.abort('failed');
  });
  await openMenu(page, '继任地图与列表');
  await page.getByRole('tab', { name: '职位继任地图', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '高级筛选', exact: true });
  await page.getByRole('button', { name: '高级筛选', exact: true }).click();
  await choose(page, drawer, '展示职位层级', '二级');
  await save(drawer).click();
  await settledUnknown(drawer);
  await cancel(page);
  await expect(drawer).toBeHidden();
  // 关闭会重读偏好：左侧显示读回的二级，说明页面已拿到新版本 4，再打开。
  await expect(page.locator('.succession-page')).toContainText('展示职位层级：二级');
  await page.getByRole('button', { name: '高级筛选', exact: true }).click();
  await settledUnknown(drawer);
  expect(puts).toHaveLength(1);
  expect(unexpected(errors)).toEqual([]);
});

test('AC-FE-R3d1-25 编辑继任结果未知：关闭刷新后行带新版本，重开仍锁定，不发第二个 PUT', async ({ page }) => {
  const errors = watchErrors(page);
  const second = { id: '54000000-0000-4000-8000-000000000002', name: '合成准备度二', color: '#146EFF' };
  await page.route('**/succession/readiness', (route) =>
    route.fulfill({ json: { items: [positionRecord.readiness, second] } }),
  );
  let server: Record<string, unknown> = { ...positionRecord };
  await page.route(/\/succession\/records(\?|$)/, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { page: 1, pageSize: 15, total: 1, hasDataPermission: true, items: [server] } })
      : route.fallback(),
  );
  await page.route(`**/succession/records/${ids.record}`, (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: server });
    // 服务端已写入（2 → 3），回执在路上丢了。
    server = { ...server, ...request.postDataJSON(), readiness: second, revision: 3 };
    return route.abort('failed');
  });
  const sent: Request[] = [];
  page.on('request', (request) => {
    if (writes(request) && request.url().includes('/succession/records')) sent.push(request);
  });
  await openMenu(page, '继任地图与列表');
  const list = page.locator('.succession-records');
  await page.getByRole('checkbox').last().check();
  await button(page, '编辑').click();
  const dialog = page.getByRole('dialog', { name: '编辑继任', exact: true });
  await choose(page, dialog, '准备度', '合成准备度二');
  await save(dialog).click();
  await settledUnknown(dialog);
  await cancel(page);
  await expect(dialog).toBeHidden();
  // 关闭会刷新列表：行带上版本 3 后再勾选、打开。
  await expect(list.getByRole('row', { name: /合成准备度二/ })).toBeVisible();
  await page.getByRole('checkbox').last().check();
  await button(page, '编辑').click();
  await settledUnknown(dialog);
  expect(sent).toHaveLength(1);
  expect(unexpected(errors)).toEqual([]);
});
