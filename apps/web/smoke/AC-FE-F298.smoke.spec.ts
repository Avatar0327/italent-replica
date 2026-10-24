import { OFFER_VIEWS } from '@italent/domain';
import { test, expect, snapshotFixture, tenant, user } from './fixtures.js';
import { listFixture, offerPermission, offerRow } from './offer-list-fixture.js';

const named = (name: string) => ({ name, exact: true });
test.beforeEach(async ({ page, context, baseURL }) => {
  await context.addCookies([
    { name: 'italent_demo_tenant', value: tenant, url: baseURL! },
    { name: 'italent_demo_user', value: user, url: baseURL! },
  ]);
  await page.unroute('**/api/tenant/**');
  await context.route('**/api/tenant/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/permission/me/snapshot')) return route.fulfill({ json: snapshotFixture });
    if (url.pathname.includes('/permission/me/objects/')) return route.fulfill({ json: offerPermission });
    if (url.pathname.endsWith('/offers/views')) return route.fulfill({ json: { items: OFFER_VIEWS } });
    if (url.pathname.endsWith(`/offers/${offerRow.id}/mail`))
      return route.fulfill({
        json: {
          offerId: offerRow.id,
          name: offerRow.name,
          recipient: offerRow.personalEmail,
          subject: '录用通知',
          notice: { title: '录用通知书', paragraphs: ['合成真实 ID 邮件'] },
          attachments: [],
          cc: [],
          bcc: [],
        },
      });
    if (url.pathname.endsWith(`/offers/${offerRow.id}`))
      return route.fulfill({ json: { ...offerRow, status: 'sent' } });
    return route.fulfill({ json: listFixture([offerRow]) });
  });
});

test('AC-FE-F298 列表到重新读取的详情再到邮件，保留真实 ID 与名称', async ({ page, context }) => {
  await page.goto('/offers');
  await page.getByRole('button', named(offerRow.name)).click();
  const detail = page.getByRole('dialog');
  for (const name of [
    offerRow.departmentName,
    offerRow.departmentFullName,
    offerRow.positionName,
    offerRow.postName,
    offerRow.directManagerName,
  ])
    await expect(detail.getByText(name, { exact: true })).toBeVisible();
  const opened = context.waitForEvent('page');
  await detail.getByRole('button', named('查看Offer邮件')).click();
  const mail = await opened;
  await expect(mail).toHaveURL(new RegExp(`/offers/${offerRow.id}/mail$`));
  await expect(mail.getByRole('heading', named(offerRow.name))).toBeVisible();
  expect(await mail.evaluate(() => window.opener)).toBeNull();
  await expect(page).toHaveURL(/\/offers$/);
  await mail.close();
});

for (const [label, field, name] of [
  ['部门', 'departmentId', 'departmentName'],
  ['职位', 'positionId', 'positionName'],
  ['职务', 'postId', 'postName'],
] as const) {
  test(`AC-FE-F298 ${label}筛选名称为 label，提交仍为 ID`, async ({ page }) => {
    await page.goto('/offers');
    await page.getByRole('button', named('待发二级视图')).click();
    await page.getByRole('menuitem', named('未发起审批')).click();
    await page.getByRole('button', named(`${label} ▾`)).click();
    await page.getByRole('combobox', named(label)).click();
    const request = page.waitForRequest((r) => new URL(r.url()).searchParams.get(field) === offerRow[field]);
    await page
      .locator('.ant-select-dropdown:visible .ant-select-item-option-content')
      .getByText(offerRow[name], { exact: true })
      .click();
    const url = new URL((await request).url());
    expect(url.searchParams.get(field)).toBe(offerRow[field]);
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('view')).toBe('unsubmitted');
  });
}
