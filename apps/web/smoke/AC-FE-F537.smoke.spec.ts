import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

interface Fixture {
  url: string;
  actor: { tenant: string; user: string };
  first: string;
  second: string;
}

const writePath = '/api/tenant/self-service/transfer';
const processing = '处理中 / 结果待确认';
const recoveryKey = 'italent.commands.pending:transfer';
let backend: ChildProcess;
let fixture: Fixture;

test.beforeAll(async () => {
  backend = spawn(process.execPath, [fileURLToPath(new URL('./f537-live-server.mjs', import.meta.url))], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  fixture = await new Promise((resolve, reject) => {
    const prefix = 'F537_READY ';
    let stdout = '';
    let stderr = '';
    backend.stdout!.on('data', (part) => {
      stdout += String(part);
      const line = stdout.split('\n').find((value) => value.startsWith(prefix));
      if (line) resolve(JSON.parse(line.slice(prefix.length)) as Fixture);
    });
    backend.stderr!.on('data', (part) => {
      stderr += String(part);
    });
    backend.once('error', reject);
    backend.once('exit', (code) => reject(new Error(`F-537 后端退出 ${code}\n${stderr}`)));
  });
});
test.afterEach(async ({ context }) => {
  await context.unrouteAll({ behavior: 'wait' });
});
test.afterAll(async () => {
  if (!backend?.pid || backend.exitCode !== null || backend.signalCode !== null) return;
  const exited = new Promise<void>((done) => backend.once('exit', () => done()));
  backend.kill('SIGTERM');
  await exited;
});

async function live(
  context: BrowserContext,
  baseURL: string,
  firstWrite: 'rollback' | 'disconnect',
  beforeQueryDelivery?: Promise<void>,
) {
  await context.addCookies([
    { name: 'italent_demo_tenant', value: fixture.actor.tenant, url: baseURL },
    { name: 'italent_demo_user', value: fixture.actor.user, url: baseURL },
  ]);
  const writes: { id: string; status?: number }[] = [];
  const queries: { path: string; status: number; body: unknown }[] = [];
  await context.route('**/api/tenant/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = request.headers();
    const first = url.pathname === writePath && request.method() === 'POST' && writes.length === 0;
    const write = url.pathname === writePath && request.method() === 'POST';
    if (write) writes.push({ id: headers['idempotency-key']! });
    if (first && firstWrite === 'disconnect') return route.abort('failed');
    const response = await context.request.fetch(`${fixture.url}${url.pathname}${url.search}`, {
      method: request.method(),
      headers: { ...headers, ...(first ? { 'x-smoke-rollback': 'yes' } : {}) },
      data: request.postData() ?? undefined,
    });
    if (write) writes.at(-1)!.status = response.status();
    if (url.pathname.startsWith('/api/tenant/commands/')) {
      queries.push({ path: url.pathname, status: response.status(), body: await response.json() });
      await beforeQueryDelivery;
    }
    await route.fulfill({ response });
    await response.dispose();
  });
  return { writes, queries };
}

async function open(page: Page) {
  await page.getByRole('button', { name: '本人调动申请', exact: true }).click();
  return page.getByRole('dialog', { name: '本人调动申请', exact: true });
}
const submit = (page: Page) => page.getByRole('dialog').getByRole('button', { name: '提交', exact: true });
const department = (page: Page) => page.getByRole('dialog').locator('select[name="departmentId"]');
const pendingRecord = (page: Page) => page.evaluate((key) => localStorage.getItem(key), recoveryKey);
async function close(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
}

test('AC-FE-F537 真未知：断网后刷新、重开与查询始终锁定，只查原命令且没有重提', async ({ page, context, baseURL }) => {
  const { writes, queries } = await live(context, baseURL!, 'disconnect');
  await page.goto('/self/applications');
  let drawer = await open(page);
  await department(page).selectOption(fixture.first);
  await submit(page).click();
  await expect(drawer).toContainText(processing);
  const id = writes[0]!.id;
  await close(page);
  await page.reload();
  drawer = await open(page);
  await expect(drawer).toContainText(processing);
  await drawer.getByRole('button', { name: '查询结果', exact: true }).click();
  await expect(drawer).toContainText('暂未查到本次命令的结果');
  await expect(submit(page)).toBeHidden();
  expect(await pendingRecord(page)).toContain(id);
  expect(writes).toEqual([{ id }]);
  expect(queries).toMatchObject([{ path: `/api/tenant/commands/${id}/result`, status: 404 }]);
});

test('AC-FE-F537 P2-2 查询回执到达时抽屉已关闭，确认未执行后重开保留原值并可改正重提', async ({
  page,
  context,
  baseURL,
}) => {
  let deliver!: () => void;
  const held = new Promise<void>((resolve) => (deliver = resolve));
  const { writes, queries } = await live(context, baseURL!, 'rollback', held);
  await page.goto('/self/applications');
  let drawer = await open(page);
  await department(page).selectOption(fixture.first);
  await submit(page).click();
  await expect(drawer).toContainText(processing);
  await expect.poll(() => writes[0]?.status).toBe(500);
  const id = writes[0]!.id;
  expect(await pendingRecord(page)).toContain(id);
  await close(page);
  drawer = await open(page);
  await expect(drawer).toContainText(processing);
  try {
    await drawer.getByRole('button', { name: '查询结果', exact: true }).click();
    await expect.poll(() => queries.length).toBe(1);
    expect(await pendingRecord(page)).toContain(id);
    await close(page);
  } finally {
    deliver();
  }
  await expect.poll(() => pendingRecord(page)).toBeNull();
  drawer = await open(page);
  await expect(department(page)).toBeEnabled();
  await expect(department(page)).toHaveValue(fixture.first);
  expect(queries).toMatchObject([
    { path: `/api/tenant/commands/${id}/result`, status: 200, body: { status: 'not_executed' } },
  ]);
  expect(writes).toHaveLength(1);
  await department(page).selectOption(fixture.second);
  await submit(page).click();
  await expect.poll(() => writes[1]?.status).toBe(201);
  expect(writes[1]!.id).not.toBe(id);
  await expect(page.getByText('申请已提交审批，请在“我的申请”核对。')).toBeVisible();
});
