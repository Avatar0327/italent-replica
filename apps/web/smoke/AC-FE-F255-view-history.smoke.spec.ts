import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { setup, listRecord, fields } from './part-time-fixtures.js';

const exclusive: Record<string, string[]> = {
  all: ['serviceStatuses', 'current'],
  expiring: ['pendingStatuses'],
  in_approval: ['kinds', 'statuses', 'requestSources'],
};

async function historySetup(page: Page) {
  await setup(page);
  await page.route('**/permission/me/objects/*', (route) =>
    route.fulfill({
      json: {
        viewableFields: [...fields, 'requestSource'],
        dataOperations: { read: true, update: true },
        editableFields: ['endDate'],
        buttons: [{ buttonCode: 'Employment.PartTimeBatchEnd', level: 'list' }],
      },
    }),
  );
  const queries: URLSearchParams[] = [];
  const invalid: string[] = [];
  await page.route('**/employment/part-times?*', (route) => {
    const q = new URL(route.request().url()).searchParams;
    queries.push(q);
    if (Object.entries(exclusive).some(([view, keys]) => q.get('view') !== view && keys.some((key) => q.has(key)))) {
      invalid.push(q.toString());
      return route.fulfill({
        status: 400,
        json: { error: { code: 'VALIDATION_FAILED', message: '该视图不支持此筛选' } },
      });
    }
    return route.fulfill({ json: { items: [listRecord], total: 61, page: Number(q.get('page')), pageSize: 30 } });
  });
  await page.reload();
  await expect(page.getByRole('cell', { name: '合成兼职员工', exact: true })).toBeVisible();
  return { queries, invalid };
}

for (const scenario of [
  {
    view: '审批中的兼职',
    key: 'in_approval',
    target: '全部兼职记录',
    targetKey: 'all',
    picks: [
      ['申请类型', '延长'],
      ['审批状态', '退回'],
      ['申请来源', '调动申请'],
    ],
  },
  {
    view: '即将到期',
    key: 'expiring',
    target: '全部兼职记录',
    targetKey: 'all',
    picks: [['延长/结束申请审批状态', '退回']],
  },
  {
    view: '全部兼职记录',
    key: 'all',
    target: '即将到期',
    targetKey: 'expiring',
    picks: [
      ['任职状态', '任职中'],
      ['是否当前生效', '否'],
    ],
  },
] as const) {
  test(`AC-FE-F255-history ${scenario.key} 专属参数不跨 Back / Forward 视图`, async ({ page }) => {
    const { queries, invalid } = await historySetup(page);
    await page.getByRole('button', { name: scenario.target, exact: true }).click();
    await page.getByRole('button', { name: scenario.view, exact: true }).click();
    await page.getByRole('button', { name: '高级筛选', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '高级筛选' });
    for (const [label, choice] of scenario.picks) {
      const select = drawer.getByRole('combobox', { name: label, exact: true });
      await select.click();
      await page.locator('.ant-select-dropdown:visible').getByTitle(choice, { exact: true }).click();
      if (label !== '是否当前生效') await select.press('Escape');
    }
    await drawer.getByRole('button', { name: /^确\s*定$/ }).click();
    await expect.poll(() => exclusive[scenario.key]!.every((key) => queries.at(-1)?.has(key))).toBe(true);
    await page.goBack();
    await expect.poll(() => queries.at(-1)?.get('view')).toBe(scenario.targetKey);
    expect(invalid).toEqual([]);
    for (const keys of Object.values(exclusive)) for (const key of keys) expect(queries.at(-1)?.has(key)).toBe(false);
    await expect(page.getByRole('cell', { name: '合成兼职员工', exact: true })).toBeVisible();
    await page.goForward();
    await expect.poll(() => queries.at(-1)?.get('view')).toBe(scenario.key);
    expect(invalid).toEqual([]);
    for (const key of exclusive[scenario.key]!) expect(queries.at(-1)?.has(key)).toBe(false);
    await expect(page.getByRole('cell', { name: '合成兼职员工', exact: true })).toBeVisible();
  });
}

test('AC-FE-F255-history 历史切换同步重置分页、排序、勾选、详情和未应用筛选草稿', async ({ page }) => {
  const { queries } = await historySetup(page);
  await page.getByRole('button', { name: '全部兼职记录', exact: true }).click();
  await page.getByRole('button', { name: '即将到期', exact: true }).click();
  await page.getByRole('columnheader', { name: '工号', exact: true }).click();
  await expect.poll(() => queries.at(-1)?.get('sortBy')).toBe('code');
  await page.getByTitle('2', { exact: true }).click();
  await expect.poll(() => queries.at(-1)?.get('page')).toBe('2');
  await page.getByRole('checkbox', { name: 'Select all' }).check();
  await page.getByRole('button', { name: '查看详情', exact: true }).click();
  await expect(page.getByRole('heading', { name: '兼职详情', exact: true })).toBeVisible();
  await page.goBack();
  await expect.poll(() => queries.at(-1)?.get('view')).toBe('all');
  expect(queries.at(-1)?.get('page')).toBe('1');
  expect(queries.at(-1)?.has('sortBy')).toBe(false);
  await expect(page.getByRole('checkbox', { name: 'Select all' })).not.toBeChecked();
  await expect(page.getByRole('heading', { name: '兼职详情', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '高级筛选', exact: true }).click();
  await page.getByRole('dialog', { name: '高级筛选' }).getByLabel('兼职开始日期起', { exact: true }).fill('2026-10-01');
  await page.goForward();
  await expect.poll(() => queries.at(-1)?.get('view')).toBe('expiring');
  expect(queries.at(-1)?.get('page')).toBe('1');
  expect(queries.at(-1)?.has('sortBy')).toBe(false);
  expect(queries.at(-1)?.has('startFrom')).toBe(false);
  await expect(page.getByRole('dialog', { name: '高级筛选' })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Select all' })).not.toBeChecked();
});
