import { test, expect, snapshotFixture } from './fixtures.js';
import { setup, listRecord } from './part-time-fixtures.js';

const today = snapshotFixture.session.today;
const dateAt = (days: number) =>
  new Date(Date.parse(`${today}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

for (const entry of ['快捷筛选', '高级筛选'] as const) {
  test(`AC-FE-F255-expiring-range ${entry}拉宽到第60天不漏第45天，遵守1～365天边界`, async ({ page }) => {
    await setup(page);
    const queries: URLSearchParams[] = [];
    await page.route('**/employment/part-times?*', (route) => {
      const q = new URL(route.request().url()).searchParams;
      queries.push(q);
      // 模拟既有接口的交集；真实 SQL 漏行由 AC-PT-F255-expiring-range 覆盖。
      const included =
        Number(q.get('days')) >= 45 &&
        (!q.get('endFrom') || q.get('endFrom')! <= dateAt(45)) &&
        (!q.get('endTo') || q.get('endTo')! >= dateAt(45));
      return route.fulfill({
        json: { items: included ? [{ ...listRecord, endDate: dateAt(45) }] : [], total: included ? 1 : 0 },
      });
    });
    await page.getByRole('button', { name: '即将到期', exact: true }).click();
    const container = page.getByRole(entry === '快捷筛选' ? 'region' : 'dialog', { name: entry });
    const apply = async (end: string) => {
      if (entry === '高级筛选') await page.getByRole('button', { name: entry, exact: true }).click();
      await container.getByLabel('兼职结束日期起', { exact: true }).fill(today);
      await container.getByLabel('兼职结束日期止', { exact: true }).fill(end);
      await container.getByRole('button', { name: /^确\s*定$/ }).click();
    };
    await apply(dateAt(60));
    await expect.poll(() => queries.at(-1)?.get('days')).toBe('60');
    await expect(page.getByRole('cell', { name: '合成兼职员工', exact: true })).toBeVisible();
    await apply(dateAt(365));
    await expect.poll(() => queries.at(-1)?.get('days')).toBe('365');
    const count = queries.length;
    await apply(dateAt(366));
    await expect(container.getByRole('alert')).toContainText('365');
    expect(queries).toHaveLength(count);
    // 非法输入仍在当前表单；修正到当天后用 days=1，显式右端仍精确限定当天。
    await container.getByLabel('兼职结束日期止', { exact: true }).fill(today);
    await container.getByRole('button', { name: /^确\s*定$/ }).click();
    await expect.poll(() => queries.at(-1)?.get('days')).toBe('1');
    expect(queries.at(-1)?.get('endTo')).toBe(today);
  });
}
