import type { BrowserContext, Page } from '@playwright/test';
import { test, expect, snapshotFixture, tenant, user } from './fixtures.js';
import { mailFixture, mailRow, sentMailRow } from './offer-mail-fixture.js';

const named = (name: string) => ({ name, exact: true });
test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([
    { name: 'italent_demo_tenant', value: tenant, url: baseURL! },
    { name: 'italent_demo_user', value: user, url: baseURL! },
  ]);
  // 新标签不继承 page.route；在 context 上沿用底座快照夹具。
  await context.route('**/api/tenant/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/permission/me/snapshot')) return route.fulfill({ json: snapshotFixture });
    if (path.includes('/permission/me/objects/'))
      return route.fulfill({ json: { dataOperations: { read: true }, viewableFields: ['name'], buttons: [] } });
    if (path.endsWith(`/offers/${mailRow.id}/mail`)) return route.fulfill({ json: mailFixture });
    if (path.endsWith(`/offers/${sentMailRow.id}/mail`))
      return route.fulfill({ json: { ...mailFixture, offerId: sentMailRow.id, name: sentMailRow.name } });
    return route.fulfill({ json: { items: [] } });
  });
});

test('AC-FE-F234 已入职行打开新标签，列表保留，详情显示真实读口响应', async ({ page, context }) => {
  await page.goto('/offers');
  await page.getByRole('button', named('已入职Offer')).click();
  const row = page.getByRole('row').filter({ hasText: mailRow.name });
  const button = row.getByRole('button', named('查看Offer邮件'));
  await expect(button).toBeEnabled();
  const opened = context.waitForEvent('page');
  await button.click();
  const mail = await opened;
  await expect(mail).toHaveURL(new RegExp(`/offers/${mailRow.id}/mail$`));
  await expect(mail.getByRole('heading', named(mailRow.name))).toBeVisible();
  const content = mail.locator('.offer-mail-page');
  await expect(content.getByText('录用通知', { exact: true })).toBeVisible();
  for (const paragraph of mailFixture.notice.paragraphs) await expect(content.getByText(paragraph)).toBeVisible();
  await expect(content.getByRole('button')).toHaveCount(0);
  await expect(content.getByText('演示数据', { exact: true })).toHaveCount(0);
  expect(await mail.evaluate(() => window.opener === null)).toBe(true);
  await expect(page).toHaveURL(/\/offers$/);
  await expect(row).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await mail.screenshot({ path: '../../.demo/f234fe-mail.png', fullPage: true });
  await mail.close();
});

test('AC-FE-F234 下拉邮件入口同样打开新标签，待发没有邮件入口', async ({ page, context }) => {
  await page.goto('/offers');
  await page.getByRole('row').filter({ hasText: '合成社招甲' }).getByRole('button', named('行操作')).click();
  await expect(page.getByRole('menuitem', named('查看Offer邮件'))).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', named('已发Offer')).click();
  await page.getByRole('row').filter({ hasText: sentMailRow.name }).getByRole('button', named('行操作')).click();
  const item = page.getByRole('menuitem', named('查看Offer邮件'));
  await expect(item).not.toHaveAttribute('aria-disabled', 'true');
  const opened = context.waitForEvent('page');
  await item.click();
  const mail = await opened;
  await expect(mail).toHaveURL(new RegExp(`/offers/${sentMailRow.id}/mail$`));
  await expect(mail.getByRole('heading', named(sentMailRow.name))).toBeVisible();
  await expect(page).toHaveURL(/\/offers$/);
  await mail.close();
});

async function openMail(page: Page, context: BrowserContext) {
  await page.goto('/offers');
  await page.getByRole('button', named('已入职Offer')).click();
  const opened = context.waitForEvent('page');
  await page.getByRole('row').filter({ hasText: mailRow.name }).getByRole('button', named('查看Offer邮件')).click();
  const mail = await opened;
  await expect(mail).toHaveURL(new RegExp(`/offers/${mailRow.id}/mail$`));
  return mail;
}

test('AC-FE-F234 空值邮件显示 --，仍保留姓名与正文', async ({ page, context }) => {
  await context.route(`**/api/tenant/offers/${mailRow.id}/mail`, (route) =>
    route.fulfill({ json: { ...mailFixture, recipient: null, attachments: [], cc: null, bcc: [] } }),
  );
  const mail = await openMail(page, context);
  const content = mail.locator('.offer-mail-page');
  await expect(content.getByRole('heading', named(mailRow.name))).toBeVisible();
  await expect(content.locator('dd')).toHaveText([mailRow.name, '--', '录用通知', '--', '--', '--']);
  for (const paragraph of mailFixture.notice.paragraphs) await expect(content.getByText(paragraph)).toBeVisible();
  await expect(mail.getByText('暂无Offer邮件', { exact: true })).toHaveCount(0);
  await expect(mail.getByText('暂无访问权限', { exact: true })).toHaveCount(0);
  await mail.close();
});

test('AC-FE-F234 未发送 404 显示暂无Offer邮件，不混淆为无权', async ({ page, context }) => {
  await context.route(`**/api/tenant/offers/${mailRow.id}/mail`, (route) =>
    route.fulfill({
      status: 404,
      json: { error: { code: 'NOT_FOUND', details: { reason: 'OFFER_MAIL_NOT_SENT' } } },
    }),
  );
  const mail = await openMail(page, context);
  await expect(mail.getByText('暂无Offer邮件', { exact: true })).toBeVisible();
  await expect(mail.getByText('暂无访问权限', { exact: true })).toHaveCount(0);
  await expect(mail.locator('.offer-mail-page')).toHaveCount(0);
  await mail.close();
});

test('AC-FE-F234 403 显示通用无权状态，不能误报未发送', async ({ page, context }) => {
  await context.route(`**/api/tenant/offers/${mailRow.id}/mail`, (route) =>
    route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN' } } }),
  );
  const mail = await openMail(page, context);
  await expect(mail.getByText('暂无访问权限', { exact: true })).toBeVisible();
  await expect(mail.getByText('暂无Offer邮件', { exact: true })).toHaveCount(0);
  await expect(mail.locator('.offer-mail-page')).toHaveCount(0);
  await mail.close();
});
