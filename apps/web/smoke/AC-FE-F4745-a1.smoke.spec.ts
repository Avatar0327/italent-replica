import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { rows, settingsFixtures } from './settings-fixtures.js';

test.beforeEach(async ({ page }) => settingsFixtures(page, false));

test('AC-FE-F4745-A1 日志应用与精确 TraceID 筛选重置游标，取消不应用', async ({ page }) => {
  const queries: URLSearchParams[] = [];
  await page.route('**/audit/data-changes?*', (route) => {
    const q = new URL(route.request().url()).searchParams;
    queries.push(q);
    return route.fulfill({
      json: {
        items: [{ ...rows.audit, app: '企业设置', objectId: q.has('cursor') ? '合成第二页' : '合成第一页' }],
        apps: ['企业设置', '组织员工'],
        nextCursor: q.has('cursor') ? null : 'synthetic-cursor',
        window: { from: '2026-11-01', to: '2026-11-10' },
      },
    });
  });
  await page.goto('/settings/menu/audit.business');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.getByRole('button', { name: '合成第二页' })).toBeVisible();
  await selectControl(page, '应用').click();
  await page.locator('.ant-select-item-option').getByText('企业设置', { exact: true }).click();
  await expect.poll(() => queries.at(-1)?.get('app')).toBe('企业设置');
  expect(queries.at(-1)?.has('cursor')).toBe(false);
  await page.getByRole('button', { name: '高级筛选', exact: true }).click();
  await page.getByRole('textbox', { name: 'TraceID', exact: true }).fill('synthetic:trace-474');
  await page.getByRole('button', { name: /^确\s*定$/ }).click();
  await expect.poll(() => queries.at(-1)?.get('traceId')).toBe('synthetic:trace-474');
  expect(queries.at(-1)?.get('app')).toBe('企业设置');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.getByRole('button', { name: '合成第二页' })).toBeVisible();
  const before = queries.length;
  await page.getByRole('button', { name: '高级筛选', exact: true }).click();
  await page.getByRole('textbox', { name: 'TraceID', exact: true }).fill('cancelled');
  await page.getByRole('button', { name: /^取\s*消$/ }).click();
  expect(queries).toHaveLength(before);
  await selectControl(page, '每页条数').click();
  await page.getByText('30条/页', { exact: true }).last().click();
  await expect.poll(() => queries.at(-1)?.get('limit')).toBe('30');
  expect(queries.at(-1)?.has('cursor')).toBe(false);
  expect(queries.at(-1)?.get('traceId')).toBe('synthetic:trace-474');
});

test('AC-FE-F4745-A1 树查询保留祖先，特殊字符、停用、空集和错误可重试', async ({ page }) => {
  const queries: URLSearchParams[] = [];
  let failed = false;
  await page.route('**/permission/mous/tree?*', (route) => {
    const q = new URL(route.request().url()).searchParams;
    queries.push(q);
    if (failed) return route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN' } } });
    const child = {
      ...rows.mou,
      id: 'synthetic-child',
      name: '合成子单元',
      code: 'CHILD',
      parentId: rows.mou.id,
      status: 'disabled',
      matched: true,
      children: [],
    };
    return route.fulfill({
      json: {
        items: q.get('q') === 'empty' ? [] : [{ ...rows.mou, matched: false, children: [child] }],
        total: q.get('q') === 'empty' ? 0 : 2,
      },
    });
  });
  await page.goto('/settings/menu/permission.mous');
  await expect(page.getByRole('button', { name: '合成管理单元', exact: true })).toBeVisible();
  expect(queries.at(-1)?.get('status')).toBe('active');
  await page.getByRole('button', { name: '展开管理单元', exact: true }).click();
  await expect(page.getByRole('button', { name: '合成子单元', exact: true })).toBeVisible();
  const search = page.getByRole('searchbox', { name: '名称 / 编码', exact: true });
  await search.fill('A%_&合成');
  await search.press('Enter');
  await expect.poll(() => queries.at(-1)?.get('q')).toBe('A%_&合成');
  await expect(page.getByRole('button', { name: '合成管理单元', exact: true })).toBeVisible();
  await selectControl(page, '管理单元状态').click();
  await page.locator('.ant-select-item-option').getByText('停用', { exact: true }).click();
  await expect.poll(() => queries.at(-1)?.get('status')).toBe('disabled');
  expect(queries.at(-1)?.get('q')).toBe('A%_&合成');
  await search.fill('empty');
  await search.press('Enter');
  await expect(page.getByText('这里什么都没有…', { exact: true })).toBeVisible();
  failed = true;
  await page.getByRole('button', { name: /^刷\s*新$/ }).click();
  await expect(page.locator('.settings-mou-tree').getByRole('alert')).toContainText('暂无访问权限');
  expect(await page.getByRole('button', { name: '合成管理单元', exact: true }).count()).toBe(0);
  failed = false;
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(page.getByText('这里什么都没有…', { exact: true })).toBeVisible();
});

test('AC-FE-F4745-A1 TraceID 校验与清空不保留旧筛选', async ({ page }) => {
  const queries: URLSearchParams[] = [];
  await page.route('**/audit/data-changes?*', (route) => {
    queries.push(new URL(route.request().url()).searchParams);
    return route.fulfill({ json: { items: [rows.audit], nextCursor: null, apps: ['企业设置'] } });
  });
  await page.goto('/settings/menu/audit.business');
  await expect(page.getByRole('button', { name: 'DEMO-001', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '高级筛选', exact: true }).click();
  const trace = page.getByRole('textbox', { name: 'TraceID', exact: true });
  await expect(trace).toHaveAttribute('maxlength', '128');
  const before = queries.length;
  await trace.fill('a b/c');
  await page.getByRole('button', { name: /^确\s*定$/ }).click();
  await expect(page.getByText('TraceID 最多128个字符，仅支持字母、数字、下划线、点、冒号和连字符')).toBeVisible();
  expect(queries).toHaveLength(before);
  await trace.fill('a'.repeat(128));
  await page.getByRole('button', { name: /^确\s*定$/ }).click();
  await expect.poll(() => queries.at(-1)?.get('traceId')).toBe('a'.repeat(128));
  await page.getByRole('button', { name: '高级筛选', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '清空', exact: true }).click();
  await expect(trace).toHaveValue('');
  await page.getByRole('button', { name: /^确\s*定$/ }).click();
  await expect.poll(() => queries.at(-1)?.has('traceId')).toBe(false);
});

test('AC-FE-F4745-A1 页面切换、后退与前进不复活旧查询', async ({ page }, testInfo) => {
  let resolveFirst: (() => void) | undefined;
  let reads = 0;
  await page.route('**/audit/data-changes?*', async (route) => {
    reads++;
    const first = reads === 1;
    if (first)
      await new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
    await route.fulfill({
      json: {
        items: [{ ...rows.audit, objectId: first ? '合成旧结果' : '合成新结果' }],
        apps: ['企业设置'],
        nextCursor: null,
      },
    });
  });
  await page.goto('/settings/menu/audit.business');
  await expect.poll(() => !!resolveFirst).toBe(true);
  await page.locator('.settings-navigation').getByRole('button', { name: '管理单元', exact: true }).click();
  await expect(page.getByRole('heading', { name: '管理单元', exact: true })).toBeVisible();
  resolveFirst!();
  await expect(page.getByRole('button', { name: '合成管理单元', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('mou.png'), fullPage: true });
  await page.goBack();
  await expect(page.getByRole('button', { name: '合成新结果', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '合成旧结果', exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('audit.png'), fullPage: true });
  await page.goForward();
  await expect(page.getByRole('heading', { name: '管理单元', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '合成新结果', exact: true })).toHaveCount(0);
});

function selectControl(page: Page, name: string) {
  return page
    .locator('.ant-select')
    .filter({ has: page.getByRole('combobox', { name, exact: true }) })
    .locator('.ant-select-selector');
}
