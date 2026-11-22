import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, seedDemoUser, snapshotFixture, test } from './fixtures.js';

type Scene = 'offer' | 'entry';
type Actor = 'employee' | 'initiator';
interface Source {
  id: string;
  name: string;
  template: { id: string; name: string };
  sourcePath: string;
  tenantId: string;
  employee: string;
  initiator: string;
}

const RECORDS = 'TenantBase.ESignRecord';
const EMPLOYMENT = 'TenantBase.EmploymentRecord';
const OFFER = 'TenantBase.Offer';
const labels = { offer: 'Offer电子签署', entry: '入职电子签署' };
let backend: ChildProcess;
let live: { url: string } & Record<Scene, Source>;

test.beforeAll(async () => {
  test.setTimeout(150_000);
  backend = spawn(process.execPath, [fileURLToPath(new URL('./f505s7-live-server.mjs', import.meta.url))], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: '--conditions=@italent/source' },
  });
  live = await new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    const prefix = 'F505S7_READY ';
    backend.stdout!.on('data', (chunk) => {
      output += String(chunk);
      const ready = output.split('\n').find((line) => line.startsWith(prefix));
      if (ready && output.endsWith('\n')) resolve(JSON.parse(ready.slice(prefix.length)));
    });
    backend.stderr!.on('data', (chunk) => (errors += String(chunk)));
    backend.once('error', reject);
    backend.once('exit', (code) => reject(new Error(`签署冒烟后端退出 ${code}\n${errors}`)));
  });
});

test.afterAll(async () => {
  if (!backend?.pid || backend.exitCode !== null || backend.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => backend.once('exit', () => resolve()));
  backend.kill('SIGTERM');
  await exited;
});

async function attachBackend(page: Page, scene: Scene, currentActor: () => Actor) {
  await seedDemoUser(page);
  const w = live[scene];
  await page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        session: { ...snapshotFixture.session, tenantId: w.tenantId, userId: w[currentActor()] },
        apps: snapshotFixture.apps.map((app) =>
          app.app === 'settings' ? { ...app, entryObjects: [...app.entryObjects, RECORDS] } : app,
        ),
      },
    }),
  );
  await page.route('**/permission/me/objects/*', (route) => {
    const objectCode = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!);
    const fields = objectCode === RECORDS ? ['scene', 'status', 'files', 'initiatedAt'] : ['id', 'name'];
    const buttons =
      objectCode === EMPLOYMENT
        ? [{ buttonCode: 'Employment.Edit', level: 'detail' }]
        : objectCode === RECORDS
          ? [{ buttonCode: 'ESignRecord.Download', level: 'list' }]
          : [];
    return route.fulfill({
      json: {
        objectCode,
        dataOperations: { update: objectCode === EMPLOYMENT || objectCode === OFFER },
        viewableFields: fields,
        editableFields: [],
        buttons,
      },
    });
  });
  // 只固定外壳授权与身份切换。来源列表、上下文、写回执、本人签署和文件使用真实 Hono 路由。
  await page.route(/\/api\/tenant\/(offers\b|employment\/pending-entries\b|esign\/)/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = request.headers();
    const response = await page.request.fetch(`${live.url}/${scene}${url.pathname}${url.search}`, {
      method: request.method(),
      headers: {
        connection: 'close',
        'x-f505-actor': currentActor(),
        ...(headers['if-match'] ? { 'if-match': headers['if-match'] } : {}),
        ...(headers['idempotency-key'] ? { 'idempotency-key': headers['idempotency-key'] } : {}),
      },
      data: request.postDataBuffer() ?? undefined,
    });
    await route.fulfill({ response });
  });
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' });
});

async function signFromMine(page: Page, scene: Scene, taskId: string) {
  await page.goto('/self/esign');
  await page.getByRole('button', { name: labels[scene], exact: true }).click();
  const detail = page.getByRole('dialog', { name: '签署详情' });
  const signed = page.waitForResponse((response) => response.url().endsWith(`/esign/mine/${taskId}/sign`));
  await detail.getByRole('button', { name: '确认签署' }).click();
  const response = await signed;
  expect(response.status()).toBe(200);
  return { detail, signedTask: await response.json() };
}

for (const scene of ['offer', 'entry'] as const) {
  test(`AC-ESIGN-F505-23 ${scene} 真列表发起、本人签、企业签、完成并下载`, async ({ page }) => {
    const w = live[scene];
    let actor: Actor = 'initiator';
    await attachBackend(page, scene, () => actor);
    const openList = async () => {
      await page.goto(scene === 'offer' ? '/offers' : '/entries');
      if (scene === 'offer') await page.getByRole('button', { name: '已接受Offer' }).click();
      const sourceRow = page.getByRole('row').filter({ hasText: w.name });
      await expect(sourceRow).toHaveAttribute('data-row-key', w.id);
      return sourceRow;
    };
    const sourceRow = await openList();
    await sourceRow.getByRole('button', { name: scene === 'offer' ? '行操作' : '更多操作' }).click();
    await page.getByRole('menuitem', { name: scene === 'offer' ? '发起电子签署' : '发起电子文件签署' }).click();
    const dialog = page.getByRole('dialog', { name: '发起电子签署' });
    const confirm = dialog.getByRole('button', { name: /^确\s*定$/ });
    await expect(confirm).toBeDisabled();
    await dialog.locator('select[name="esignTemplateIds"]').selectOption(w.template.id);
    const receipt = page.waitForResponse((response) => response.url().endsWith(`${w.sourcePath}/esign-tasks`));
    await confirm.click();
    const created = await receipt;
    expect(created.status()).toBe(201);
    const { sourceId, taskId } = await created.json();
    expect(sourceId).toBe(w.id);
    await expect(dialog.getByText('签署中（待本人签署）').first()).toBeVisible();
    await expect(dialog.getByRole('region', { name: '电子签署' })).toContainText(w.template.name);

    actor = 'employee';
    const employee = await signFromMine(page, scene, taskId);
    expect(employee.signedTask).toMatchObject({ id: taskId, status: 'signing', currentNode: 'enterprise' });
    actor = 'initiator';
    const enterprise = await signFromMine(page, scene, taskId);
    expect(enterprise.signedTask).toMatchObject({ id: taskId, status: 'completed', currentNode: null });
    await expect(enterprise.detail.getByText('签署完成', { exact: true })).toBeVisible();
    const download = page.waitForEvent('download');
    await enterprise.detail.getByRole('button', { name: '下载文件' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.pdf$/);
    expect((await readFile(await file.path())).subarray(0, 5).toString()).toBe('%PDF-');
    const updatedRow = await openList();
    if (scene === 'entry') {
      await updatedRow.getByRole('button', { name: '电子签署' }).click();
      await expect(
        page.getByRole('dialog', { name: '电子签署' }).getByRole('region', { name: '电子签署' }),
      ).toContainText('签署完成');
    }
  });
}
