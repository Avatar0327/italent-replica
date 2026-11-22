import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, expect, seedDemoUser, snapshotFixture } from './fixtures.js';

interface Manifest {
  url: string;
  name: string;
  sourceId: string;
  template: { id: string; name: string };
}
const SETTINGS = 'TenantBase.ESignSettings';
const RECORDS = 'TenantBase.ESignRecord';
let backend: ChildProcess;
let live: Manifest;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  backend = spawn(process.execPath, [fileURLToPath(new URL('./f505s6-live-server.mjs', import.meta.url))], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: '--conditions=@italent/source' },
  });
  live = await new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    backend.stdout!.on('data', (chunk) => {
      output += String(chunk);
      const ready = output.split('\n').find((line) => line.startsWith('F505S6_READY '));
      if (ready) resolve(JSON.parse(ready.slice('F505S6_READY '.length)));
    });
    backend.stderr!.on('data', (chunk) => (errors += String(chunk)));
    backend.once('error', reject);
    backend.once('exit', (code) => reject(new Error(`F505S6 后端退出 ${code}\n${errors}`)));
  });
});
test.afterAll(async () => {
  if (!backend || backend.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => backend.once('exit', () => resolve()));
  backend.kill('SIGTERM');
  await exited;
});
test.beforeEach(async ({ page }) => {
  await seedDemoUser(page);
  await page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        apps: snapshotFixture.apps.map((app) =>
          app.app === 'settings' ? { ...app, entryObjects: [...app.entryObjects, SETTINGS, RECORDS] } : app,
        ),
      },
    }),
  );
  await page.route('**/permission/me/objects/**', (route) => {
    const objectCode = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!);
    const fields = objectCode === SETTINGS ? ['validityDays', 'remindBeforeExpiry'] : ['name', 'status', 'files'];
    return route.fulfill({
      json: {
        objectCode,
        dataOperations: { read: true, update: true },
        viewableFields: fields,
        editableFields: fields,
        buttons: [],
      },
    });
  });
  await page.route(/\/api\/tenant\/(offers\b|esign\/)/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const response = await page.request.fetch(`${live.url}${url.pathname}${url.search}`, {
      method: request.method(),
      headers: request.headers(),
      data: request.postDataBuffer() ?? undefined,
    });
    await route.fulfill({ response });
  });
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' });
});

test('FE-01/03 Offer 列表发起签署，真实回执刷新任务状态与来源历史', async ({ page }) => {
  await page.goto('/offers');
  await page.getByRole('button', { name: '已接受Offer' }).click();
  const row = page.getByRole('row').filter({ hasText: live.name });
  await expect(page.getByRole('columnheader', { name: 'ID', exact: true })).toHaveCount(0);
  await row.getByRole('button', { name: '行操作' }).click();
  const sign = page.getByRole('menuitem', { name: '发起电子签署' });
  await expect(sign).toBeEnabled();
  await sign.click();
  const modal = page.getByRole('dialog');
  await modal.locator('select[name="esignTemplateIds"]').selectOption(live.template.id);
  const receipt = page.waitForResponse((result) => result.url().endsWith(`/offers/${live.sourceId}/esign-tasks`));
  await modal.getByRole('button', { name: /^确\s*定$/ }).click();
  expect((await receipt).status()).toBe(201);
  await expect(modal.getByText('签署中（待本人签署）').first()).toBeVisible();
  await expect(modal.getByText(live.template.name, { exact: true }).last()).toBeVisible();
});

test('FE-05 真实场景页三行独立保存', async ({ page }) => {
  await page.goto('/esign-scenes');
  const row = (label: string) => page.getByRole('row').filter({ hasText: label });
  const offer = row('Offer电子签署');
  const entry = row('入职电子签署');
  const transfer = row('调动电子签署');
  for (const item of [offer, entry, transfer]) await expect(item).toContainText('2 天');
  await offer.getByRole('button', { name: /^编\s*辑$/ }).click();
  const drawer = page.getByRole('dialog');
  await drawer.locator('input[id="validityDays"]').fill('13');
  const saved = page.waitForResponse(
    (result) => result.url().endsWith('/esign/scenes/offer') && result.request().method() === 'PUT',
  );
  await drawer.getByRole('button', { name: /^保\s*存$/ }).click();
  expect((await saved).status()).toBe(200);
  await expect(offer).toContainText('13 天');
  await expect(entry).toContainText('2 天');
  await expect(transfer).toContainText('2 天');
});
