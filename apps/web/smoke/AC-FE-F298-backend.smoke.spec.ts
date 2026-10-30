import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { snapshotFixture } from './fixtures.js';
import { offerPermission } from './offer-list-fixture.js';

let backend: ChildProcess;
let manifest: { id: string; tenant: string; user: string; url: string };
test.beforeAll(async () => {
  test.setTimeout(180_000);
  backend = spawn(process.execPath, [fileURLToPath(new URL('./offer-live-server.mjs', import.meta.url))], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  manifest = await new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    backend.stderr!.on('data', (part) => {
      errors += String(part);
    });
    backend.stdout!.on('data', (part) => {
      output += String(part);
      const ready = output.split('\n').find((line) => line.startsWith('F298_READY '));
      if (ready) resolve(JSON.parse(ready.slice('F298_READY '.length)));
    });
    backend.once('error', reject);
    backend.once('exit', (code) => reject(new Error(`F298 backend exited ${code}: ${errors}`)));
  });
});
test.afterAll(async () => {
  if (!backend || backend.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => backend.once('exit', () => resolve()));
  backend.kill('SIGTERM');
  await exited;
});

test('AC-FE-F298 隔离数据库真实列表→详情→邮件，无业务响应桩', async ({ page, context, baseURL }) => {
  await context.addCookies([
    { name: 'italent_demo_tenant', value: manifest.tenant, url: baseURL! },
    { name: 'italent_demo_user', value: manifest.user, url: baseURL! },
  ]);
  const reads: string[] = [];
  await context.route('**/api/tenant/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/tenant/offers')) {
      expect(route.request().method()).toBe('GET');
      expect(route.request().headers()['x-tenant-id']).toBe(manifest.tenant);
      reads.push(path);
      // 仅代理到真实 Hono + 隔离数据库，不制造 Offer 列表、详情或邮件响应。
      const url = new URL(route.request().url());
      const response = await context.request.get(`${manifest.url}${url.pathname}${url.search}`);
      expect(response.ok(), await response.text()).toBe(true);
      return route.fulfill({ response });
    }
    if (path.endsWith('/permission/me/snapshot'))
      return route.fulfill({
        json: {
          ...snapshotFixture,
          session: { ...snapshotFixture.session, tenantId: manifest.tenant, userId: manifest.user },
        },
      });
    return route.fulfill({ json: offerPermission });
  });
  await page.goto('/offers');
  await page.getByRole('button', { name: '已发Offer', exact: true }).click();
  await page.getByRole('button', { name: '合成数据库候选人', exact: true }).click();
  const detail = page.getByRole('dialog');
  await expect(detail.getByText('合成联调集团/合成联调部门', { exact: true })).toBeVisible();
  await expect(detail.getByText('合成联调职位', { exact: true })).toBeVisible();
  const opened = context.waitForEvent('page');
  await detail.getByRole('button', { name: '查看Offer邮件', exact: true }).click();
  const mail = await opened;
  await expect(mail).toHaveURL(new RegExp(`/offers/${manifest.id}/mail$`));
  await expect(mail.getByText('db-recipient@example.com', { exact: true })).toBeVisible();
  await expect(mail.locator('.offer-mail-body')).toContainText('合成联调部门');
  expect(reads).toContain(`/api/tenant/offers/${manifest.id}`);
  expect(reads).toContain(`/api/tenant/offers/${manifest.id}/mail`);
  expect(await mail.evaluate(() => window.opener)).toBeNull();
  await mail.close();
});
