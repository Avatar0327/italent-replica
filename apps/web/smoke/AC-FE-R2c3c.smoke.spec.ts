import { fork } from 'node:child_process';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { choose, item, named, pickDate, save } from './contracts-fixtures.js';
import { seedDemoUser, snapshotFixture, tenant, user } from './fixtures.js';
import type { startRetirementBackend } from './retirement-live-backend.js';
import { allButtons, switchView } from './retirement-fixtures.js';

type Manifest = Awaited<ReturnType<typeof startRetirementBackend>>['manifest'];
type Call = { path: string; method: string; body: unknown; status: number; json: Record<string, unknown> };
const root = '/api/tenant/employment';
const dialog = (page: Page) => page.getByRole('dialog').last();
let backend: ReturnType<typeof fork>;
let manifest: Manifest;

test.beforeAll(async () => {
  backend = fork(new URL('./retirement-live-server.mjs', import.meta.url));
  manifest = await new Promise((resolve, reject) => {
    backend.once('message', (message) => resolve(message as Manifest));
    backend.once('error', reject);
    backend.once('exit', (code) => reject(new Error(`退休冒烟后端启动失败 ${code}`)));
  });
});

test.afterEach(async ({ context, page }) => {
  await page.goto('about:blank');
  await context.unrouteAll({ behavior: 'wait' });
});

test.afterAll(async () => {
  if (!backend?.connected) return;
  const exited = new Promise<void>((resolve) => backend.once('exit', () => resolve()));
  backend.disconnect();
  await exited;
});

async function setupLive(page: Page) {
  const calls: Call[] = [];
  const context = page.context();
  await seedDemoUser(page);
  await context.route('**/__demo/personas', (route) =>
    route.fulfill({
      json: {
        tenantId: tenant,
        current: user,
        personas: [{ userId: user, name: '合成演示用户', role: '演示身份', entry: '/staff' }],
      },
    }),
  );
  await context.route('**/api/tenant/**', (route) =>
    route.fulfill({ json: { items: [], total: 0, hasDataPermission: true } }),
  );
  await context.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        session: {
          ...snapshotFixture.session,
          tenantId: manifest.tenantId,
          userId: manifest.userId,
          today: '2026-10-06',
        },
      },
    }),
  );
  await context.route('**/permission/me/objects/*', (route) => {
    const fields = `name code departmentId positionId lastWorkDate effectiveDate expectedRetirementDate
      status kind mode retireType reEmployed handoverEmployeeId employType remarks probation probationMonths
      probationEndDate dutyTransferTiming dutyTransferDate`.split(/\s+/);
    return route.fulfill({
      json: {
        objectCode: decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!),
        dataOperations: { read: true, create: true, update: true },
        viewableFields: fields,
        editableFields: fields,
        buttons: [
          ...allButtons,
          'Employment.RetireEdit',
          'Employment.Create',
          'Employment.Edit',
          'Employment.Preview',
        ].map((buttonCode) => ({ buttonCode, level: 'detail' })),
      },
    });
  });
  await context.route(/\/api\/tenant\/(employment|org|personnel)\//, async (route) => {
    const request = route.request();
    const { pathname, search } = new URL(request.url());
    const all = request.headers();
    expect(all['x-tenant-id']).toBe(manifest.tenantId);
    const headers = Object.fromEntries(
      ['content-type', 'if-match', 'idempotency-key'].flatMap((key) => (all[key] ? [[key, all[key]]] : [])),
    );
    const response = await context.request.fetch(`${manifest.url}${pathname}${search}`, {
      method: request.method(),
      headers,
      data: request.postDataBuffer() ?? undefined,
    });
    if (request.method() !== 'GET')
      calls.push({
        path: pathname,
        method: request.method(),
        body: request.postDataJSON(),
        status: response.status(),
        json: await response.json(),
      });
    // 切换视图时浏览器可能取消旧的引用读取；写响应及其它路由错误仍进入测试结果。
    await route.fulfill({ response }).catch((error: unknown) => {
      if (request.method() !== 'GET' || !String(error).includes('Route is already handled')) throw error;
    });
  });
  await page.goto('/retirements');
  return calls;
}

async function openPerson(page: Page, name: string, view: 'upcoming' | 'all' | 'processing' = 'all') {
  await switchView(page, view);
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) });
  await row.getByRole('button', named('查看详情')).click();
}
const preview = (form: Locator) => form.getByRole('button', named('预览')).click();

test('AC-FE-R2c3c-01 同时返聘预览和创建走退休专用入口，详情读回返聘计划', async ({ page }) => {
  const calls = await setupLive(page);
  await openPerson(page, '合成同时返聘员工', 'upcoming');
  await page.getByRole('button', named('退休办理')).click();
  const form = dialog(page);
  await pickDate(form, '最后工作日', '2026-10-25');
  await expect(form.getByRole('checkbox', { name: '是否同时返聘' })).toBeVisible({ timeout: 5000 });
  await form.getByRole('checkbox', { name: '是否同时返聘' }).check();
  await choose(form, '雇佣关系', '内部员工');
  const remarks = form.getByLabel('备注', { exact: true });
  await remarks.fill('合成返聘计划');
  await choose(form, '部门', '合成将停用返聘部门');
  await preview(form);
  await expect
    .poll(() => calls[0]?.json.rehire)
    .toMatchObject({
      blockers: [{ reason: 'RETIREMENT_REHIRE_INVALID', message: expect.any(String) }],
    });
  const blocked = (calls[0]!.json.rehire as { blockers: { message: string }[] }).blockers[0]!;
  await expect(form.getByText(blocked.message, { exact: true })).toBeVisible();
  await expect(remarks).toHaveValue('合成返聘计划');
  await expect(form.getByRole('button', named('提交'))).toBeDisabled();
  await choose(form, '部门', '合成返聘部门');
  await expect(form.getByRole('button', named('提交'))).toBeDisabled();
  await preview(form);
  await expect(form.getByText('2026-10-27', { exact: true })).toBeVisible();
  await form.getByRole('button', named('提交')).click();
  await expect(page.getByText('退休办理成功', { exact: true })).toBeVisible();
  const path = `${root}/retirements/employees/${manifest.simultaneous}`;
  const body = {
    lastWorkDate: '2026-10-25',
    reEmployed: true,
    rehire: {
      fields: {
        employType: 'internal',
        remarks: '合成返聘计划',
        departmentId: manifest.target,
      },
    },
  };
  expect(calls).toEqual([
    expect.objectContaining({
      path: `${path}/preview`,
      body: { ...body, rehire: { fields: { ...body.rehire.fields, departmentId: manifest.closing } } },
      status: 200,
    }),
    expect.objectContaining({ path: `${path}/preview`, body, status: 200 }),
    expect.objectContaining({ path, body: { mode: 'direct', ...body }, status: 201 }),
  ]);
  await openPerson(page, '合成同时返聘员工');
  const plan = dialog(page).getByRole('region', { name: '返聘计划' });
  await expect(plan).toContainText('合成返聘计划');
  await expect(plan).toContainText('合成返聘部门');
  await expect(dialog(page).getByText('无编制部门', { exact: true })).toBeVisible();
});

test('AC-FE-R2c3c-02 在途退休的返聘申请预览、真实拒绝保留日期、新增并改期', async ({ page }) => {
  const calls = await setupLive(page);
  await openPerson(page, '合成提前返聘员工', 'processing');
  await expect(dialog(page).getByRole('button', named('退休返聘申请'))).toBeVisible({ timeout: 5000 });
  await dialog(page).getByRole('button', named('退休返聘申请')).click();
  const form = dialog(page);
  await pickDate(form, '返聘生效日期', '2026-10-16');
  await choose(form, '雇佣关系', '内部员工');
  await preview(form);
  await expect(form.getByText(/须先发起退休/)).toBeVisible();
  await expect(item(form, '返聘生效日期').locator('input')).toHaveValue('2026-10-16');
  await expect(form.getByRole('button', save)).toBeDisabled();

  await pickDate(form, '返聘生效日期', '2026-10-18');
  await preview(form);
  await expect(form.getByText('返聘预览通过')).toBeVisible();
  await form.getByRole('button', save).click();
  await expect(form.getByText('返聘申请已保存')).toBeVisible();
  await pickDate(form, '返聘生效日期', '2026-10-19');
  await preview(form);
  await form.getByRole('button', save).click();
  await expect(form.getByText('返聘日期已保存')).toBeVisible();

  const path = `${root}/employees/${manifest.applying}`;
  const create = calls.find((call) => call.path === `${path}/businesses`);
  expect(create).toMatchObject({ status: 201, json: { kind: 'retire_rehire', status: 'draft' } });
  expect(calls.filter((call) => call.path === `${path}/forward-update-preview`).map((call) => call.status)).toEqual([
    409, 200, 200,
  ]);
  expect(calls.at(-1)).toMatchObject({
    method: 'PATCH',
    path: `${root}/businesses/${String(create!.json.id)}`,
    body: { effectiveDate: '2026-10-19' },
    status: 200,
  });
  await form.getByRole('button', named('取消')).click();
  await dialog(page).getByRole('button', named('查看返聘申请')).click();
  await expect(item(dialog(page), '返聘生效日期').locator('input')).toHaveValue('2026-10-19');
  await page.reload();
  await expect(item(dialog(page), '返聘生效日期').locator('input')).toHaveValue('2026-10-19');
  expect(calls.filter((call) => call.path === `${path}/businesses`)).toHaveLength(1);
});

test('AC-FE-R2c3c-03 编辑退休只提交交接人，退休日期与返聘字段只读', async ({ page }) => {
  const calls = await setupLive(page);
  await openPerson(page, '合成编辑退休员工');
  await expect(dialog(page).getByRole('button', named('编辑'))).toBeVisible({ timeout: 5000 });
  await dialog(page).getByRole('button', named('编辑')).click();
  const form = dialog(page);
  for (const label of ['最后工作日', '退休生效日期', '是否同时返聘']) {
    await expect(form.getByText(label, { exact: true })).toBeVisible();
    await expect(item(form, label).locator('input')).toHaveCount(0);
  }
  await expect(form.getByText('暂无返聘计划', { exact: true })).toBeVisible();
  await choose(form, '工作交接人', '合成交接员工');
  await form.getByRole('button', save).click();
  await expect(page.getByText('退休信息已保存', { exact: true })).toBeVisible();
  expect(calls).toEqual([
    expect.objectContaining({ method: 'PATCH', status: 200, body: { handoverEmployeeId: manifest.handover } }),
  ]);
  await expect(dialog(page).getByText('合成交接员工', { exact: true })).toBeVisible();
});

test('AC-FE-R2c3c-04 仅服务器返回 restore 的详情提供恢复，展示真实 409 原因', async ({ page }) => {
  const calls = await setupLive(page);
  await openPerson(page, '合成编辑退休员工');
  await expect(dialog(page).getByText('退休信息', { exact: true })).toBeVisible();
  await expect(dialog(page).getByRole('button', named('恢复'))).toHaveCount(0);
  await dialog(page).locator('.ant-drawer-close').click();
  await openPerson(page, '合成已撤销退休员工');
  await expect(dialog(page).getByRole('button', named('恢复'))).toBeVisible({ timeout: 5000 });
  await dialog(page).getByRole('button', named('恢复')).click();
  await expect(dialog(page).getByText('已撤销的退休不能恢复，请重新办理退休')).toBeVisible();
  expect(calls).toEqual([
    expect.objectContaining({
      path: expect.stringMatching(/\/retirements\/[^/]+\/restore$/),
      status: 409,
      json: {
        error: {
          code: 'CONFLICT',
          message: '已撤销的退休不能恢复，请重新办理退休',
          details: { reason: 'EXIT_RESTORE_NOT_SUPPORTED' },
        },
      },
    }),
  ]);
});
