import { test, expect, employee } from './fixtures.js';
import { openDetail, person, recordId, setup } from './probation-fixtures.js';

for (const eligible of [false, true]) {
  test(`AC-FE-F456 服务端申请资格 ${eligible}，详情入口照此显示`, async ({ page }) => {
    await setup(page);
    await page.route('**/employment/probation-views?*', (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: recordId,
              employeeId: employee,
              revision: 4,
              ...person,
              hasProbation: true,
              employeeStatus: 2,
              canApplyRegularization: eligible,
              startDate: '2026-08-01',
              expectedEndDate: '2026-10-31',
              regularizationState: null,
              regularizationBusinessId: null,
            },
          ],
          page: 1,
          pageSize: 15,
          hasDataPermission: true,
        },
      }),
    );
    await page.reload();
    await openDetail(page);
    await expect(page.getByRole('button', { name: /^转\s*正\s*申\s*请$/ })).toHaveCount(eligible ? 1 : 0);
  });
}
