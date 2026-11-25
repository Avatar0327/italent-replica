import type { Page } from '@playwright/test';
import { test, expect, demoRoutes, employee, tenant, insecureContext, selfServiceButtons } from './fixtures.js';

const business = '50000000-0000-4000-8000-000000000002';
const department = '60000000-0000-4000-8000-000000000002';
const preview = {
  employeeRevision: 7,
  allowDirectTransfer: false,
  allowedActions: { application: true, directList: false, directRow: false },
  fields: { departmentId: department },
  customFields: {},
  before: null,
  beforeLabels: {},
  valueLabels: { departmentId: '合成目标部门' },
  reasons: [],
  form: {
    id: 'demo-form',
    name: '调动',
    isStandard: true,
    excludedAutofillFields: [],
    customFields: [],
    fieldModes: { 'preset:departmentId': 'editable' },
  },
};
const draft = {
  id: business,
  employeeId: employee,
  revision: 4,
  employeeRevision: 7,
  status: 'draft',
  effectiveDate: '2026-11-02',
  fields: { departmentId: department, isKeyPerson: false },
  customFields: { synthetic_note: '合成草稿备注' },
};
async function openForm(page: Page, manager: boolean) {
  await page.getByRole('button', { name: manager ? '他人调动申请' : '本人调动申请', exact: true }).click();
  return page.getByRole('dialog');
}
async function setup(page: Page, manager: boolean) {
  await page.route('**/api/tenant/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/permission/me/objects/TenantBase.EmploymentRecord'))
      return route.fulfill({
        json: {
          objectCode: 'TenantBase.EmploymentRecord',
          dataOperations: {},
          viewableFields: [],
          editableFields: [],
          buttons: ['Transfer.Self', 'Employment.Create', 'Employment.Submit'].map((buttonCode) => ({
            buttonCode,
            level: 'detail',
          })),
        },
      });
    if (path.endsWith('/self-service/profile'))
      return route.fulfill({
        json: {
          selfServiceButtons,
          employee: { id: employee, name: '合成申请人', code: 'DEMO-001', revision: 7 },
          timezone: 'Asia/Shanghai',
          today: '2026-10-13',
          record: null,
        },
      });
    if (path.endsWith('/transfers/manager'))
      return route.fulfill({ json: { canApply: true, canViewReporting: false } });
    if (path.endsWith('/transfers/catalog'))
      return route.fulfill({
        json: {
          today: '2026-10-13',
          types: [{ code: 'across_department', name: '跨部门调动', formId: 'demo-form' }],
          reasons: [],
        },
      });
    if (path.endsWith('/manager/employees'))
      return route.fulfill({
        json: {
          items: [{ id: employee, name: '合成申请人', code: 'DEMO-001', revision: 7 }],
        },
      });
    if (path.endsWith('/preview')) return route.fulfill({ json: preview });
    if (path.includes('/references/departmentId'))
      return route.fulfill({ json: { items: [{ id: department, name: '合成目标部门' }] } });
    return route.fallback();
  });
  await page.goto(manager ? '/manager/applications' : '/self/applications');
  const drawer = await openForm(page, manager);
  if (manager) await drawer.locator('select[name="employeeId"]').selectOption(employee);
  await expect(drawer.getByRole('button', { name: '提交', exact: true })).toBeEnabled();
  return drawer;
}
test.beforeEach(async ({ page, baseURL }) => {
  await page.context().addCookies([{ name: 'italent_demo_tenant', value: tenant, url: baseURL! }]);
});

for (const entry of [
  { manager: false, action: '提交', path: '**/self-service/transfer' },
  { manager: true, action: '提交', path: `**/transfers/employees/${employee}` },
  { manager: true, action: '暂存', path: `**/transfers/employees/${employee}` },
]) {
  test(`AC-FE-R1d-2 ${entry.manager ? '经理' : '本人'}${entry.action}未确认关闭重开仍只读锁定`, async ({ page }) => {
    let command = '';
    let writes = 0;
    await page.route(entry.path, (route) => {
      writes++;
      command = route.request().headers()['idempotency-key']!;
      return route.abort('failed');
    });
    const drawer = await setup(page, entry.manager);
    await drawer.getByRole('button', { name: entry.action, exact: true }).click();
    await expect.poll(() => writes).toBe(1);
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await openForm(page, entry.manager);
    await expect(drawer).toContainText('处理中 / 结果待确认');
    await expect(drawer).toContainText(command);
    await expect(drawer).toContainText(employee);
    await expect(drawer).toContainText('2026-10-13');
    await expect(drawer).toContainText('查询确认原命令未执行成功后，可核对原输入重新提交。');
    await expect(drawer.getByRole('button', { name: '提交', exact: true })).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: '回查结果', exact: true })).toHaveCount(0);
    expect(writes).toBe(1);
  });
}

test('AC-FE-F110-11 本人提交未知：关闭重开、整页刷新后仍锁定，按原命令 ID 查询结果解锁', async ({ page }) => {
  let command = '';
  let writes = 0;
  const queries: string[] = [];
  await page.route('**/self-service/transfer', (route) => {
    writes++;
    command = route.request().headers()['idempotency-key']!;
    return route.abort('failed');
  });
  // F-120 真实形状：先 404（查不到，可能仍在处理），再 200 succeeded 指向本次调动单。
  await page.route('**/api/tenant/commands/*/result', (route) => {
    queries.push(new URL(route.request().url()).pathname);
    if (queries.length === 1) return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND' } } });
    return route.fulfill({
      json: {
        commandId: command,
        status: 'succeeded',
        // 真实投影（AC-TRF-F120 ①）：本人调动的命令类型。
        commandType: 'POST /api/tenant/self-service/transfer',
        businessType: 'transfer',
        businessId: business,
        revision: 1,
        httpStatus: 201,
        completedAt: '2026-10-13T02:00:00.000Z',
      },
    });
  });
  await page.route(`**/employment/businesses/${business}`, (route) =>
    route.fulfill({ json: { ...draft, revision: 1, status: 'in_review' } }),
  );
  const drawer = await setup(page, false);
  await drawer.getByRole('button', { name: '提交', exact: true }).click();
  await expect.poll(() => writes).toBe(1);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await openForm(page, false);
  await expect(drawer).toContainText(command);
  await page.reload();
  await openForm(page, false);
  await expect(drawer).toContainText('处理中 / 结果待确认');
  await expect(drawer).toContainText(command);
  await expect(drawer).toContainText('刷新前或其他标签页的提交内容未在本页保存');
  await expect(drawer.getByRole('button', { name: '提交', exact: true })).toHaveCount(0);
  const record = await page.evaluate(() => localStorage.getItem('italent.commands.pending:transfer'));
  expect(record).toContain(command);
  await drawer.getByRole('button', { name: '查询结果', exact: true }).click();
  await expect(drawer).toContainText('暂未查到本次命令的结果，可能仍在处理中，请稍后再查询。');
  await expect(drawer).toContainText(command);
  await drawer.getByRole('button', { name: '查询结果', exact: true }).click();
  await expect(drawer).toContainText('申请已提交审批，请在“我的申请”核对。');
  await expect(drawer).not.toContainText('处理中 / 结果待确认');
  expect(await page.evaluate(() => localStorage.getItem('italent.commands.pending:transfer'))).toBeNull();
  expect(queries).toEqual([`/api/tenant/commands/${command}/result`, `/api/tenant/commands/${command}/result`]);
  expect(writes).toBe(1);
});

test('AC-FE-R1d-2 经理暂存关闭重开读取完整原单，刷新草稿后按原 ID 与 revision 提交', async ({ page }) => {
  let reads = 0;
  let revision = 4;
  let created = 0;
  let submitted: Record<string, string> | undefined;
  await page.route(`**/transfers/employees/${employee}`, (route) => {
    created++;
    return route.fulfill({ status: 201, json: { id: business, revision: 1, employeeRevision: 7, status: 'draft' } });
  });
  await page.route(`**/employment/businesses/${business}`, (route) => {
    reads++;
    return route.fulfill({ json: { ...draft, revision } });
  });
  await page.route(`**/employment/businesses/${business}/submit`, (route) => {
    submitted = route.request().headers();
    expect(route.request().postDataJSON()).toEqual({});
    return route.fulfill({ json: { ...draft, revision: 6, status: 'in_review' } });
  });
  const drawer = await setup(page, true);
  await drawer.getByRole('button', { name: '暂存', exact: true }).click();
  await expect(drawer).toContainText('提交暂存申请');
  const before = reads;
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('.service-nav a[href="/manager/todos"]').click();
  await page.locator('.service-nav a[href="/manager/applications"]').click();
  await openForm(page, true);
  await expect.poll(() => reads).toBeGreaterThan(before);
  await expect(drawer).toContainText('合成草稿备注');
  await expect(drawer).toContainText('2026-11-02');
  await expect(drawer.getByTestId('draft-withEstablishment')).toHaveText('未读取');
  await expect(drawer.getByTestId('draft-transferTypeCode')).toHaveText('未读取');
  revision = 5;
  await drawer.getByRole('button', { name: '重新读取已暂存申请', exact: true }).click();
  await expect(drawer.getByTestId('draft-revision')).toHaveText('5');
  await drawer.getByRole('button', { name: '提交暂存申请', exact: true }).click();
  await expect.poll(() => submitted?.['if-match']).toBe('5');
  expect(submitted?.['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  expect(created).toBe(1);
});

test('AC-FE-R1d-2 原草稿提交未确认，回查仍为草稿不能解除命令锁定', async ({ page }) => {
  let reads = 0;
  let writes = 0;
  await page.route(`**/transfers/employees/${employee}`, (route) => route.fulfill({ json: draft }));
  await page.route(`**/employment/businesses/${business}`, (route) => {
    reads++;
    return route.fulfill({ json: draft });
  });
  await page.route(`**/employment/businesses/${business}/submit`, (route) => {
    writes++;
    return route.abort('failed');
  });
  const drawer = await setup(page, true);
  await drawer.getByRole('button', { name: '暂存', exact: true }).click();
  await drawer.getByRole('button', { name: '提交暂存申请', exact: true }).click();
  await expect.poll(() => writes).toBe(1);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await openForm(page, true);
  await expect(drawer).toContainText('处理中 / 结果待确认');
  const before = reads;
  await drawer.getByRole('button', { name: '回查结果', exact: true }).click();
  await expect.poll(() => reads).toBeGreaterThan(before);
  await expect(drawer).toContainText('处理中 / 结果待确认');
  await expect(drawer.getByRole('button', { name: '提交暂存申请', exact: true })).toHaveCount(0);
  expect(writes).toBe(1);
});

test('AC-FE-R1d-2 经理草稿读取失败禁止续办，恢复读取后才能提交', async ({ page }) => {
  let unavailable = true;
  await page.route(`**/transfers/employees/${employee}`, (route) => route.fulfill({ json: draft }));
  await page.route(`**/employment/businesses/${business}`, (route) =>
    unavailable
      ? route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN', message: '无权读取草稿' } } })
      : route.fulfill({ json: draft }),
  );
  const drawer = await setup(page, true);
  await drawer.getByRole('button', { name: '暂存', exact: true }).click();
  await expect(drawer).toContainText('暂无访问权限');
  await expect(drawer.getByRole('button', { name: '提交暂存申请', exact: true })).toHaveCount(0);
  unavailable = false;
  await drawer.getByRole('button', { name: '重新读取已暂存申请', exact: true }).click();
  await expect(drawer.getByRole('button', { name: '提交暂存申请', exact: true })).toBeEnabled();
});

test('AC-FE-R1d-2 本人申请确认成功后可以显式新建，未确认保护不阻断下一笔', async ({ page }) => {
  const commands: string[] = [];
  await page.route('**/self-service/transfer', (route) => {
    commands.push(route.request().headers()['idempotency-key']!);
    return route.fulfill({ status: 201, json: { ...draft, status: 'in_review' } });
  });
  const drawer = await setup(page, false);
  await drawer.getByRole('button', { name: '提交', exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await openForm(page, false);
  await drawer.getByRole('button', { name: '新建调动申请', exact: true }).click();
  await drawer.getByRole('button', { name: '提交', exact: true }).click();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[0]).not.toBe(commands[1]);
});

// F-110 取代原“整页刷新才重新发起”：刷新后仍锁定，只能按原命令 ID 查询结果解锁（见 AC-FE-F110-11）。
test('AC-FE-R1d-2 查看我的申请后返回不清除原命令，整页刷新后仍锁定', async ({ page }) => {
  let writes = 0;
  await page.route('**/self-service/transfer', (route) => {
    writes++;
    return route.abort('failed');
  });
  const drawer = await setup(page, false);
  await drawer.getByRole('button', { name: '提交', exact: true }).click();
  await expect.poll(() => writes).toBe(1);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('.service-nav a[href="/self/requests"]').click();
  await page.locator('.service-nav a[href="/self/applications"]').click();
  await openForm(page, false);
  await expect(drawer).toContainText('处理中 / 结果待确认');
  await expect(drawer.getByRole('button', { name: '提交', exact: true })).toHaveCount(0);
  expect(writes).toBe(1);
  await page.reload();
  await openForm(page, false);
  await expect(drawer).toContainText('处理中 / 结果待确认');
  await expect(drawer.getByRole('button', { name: '提交', exact: true })).toHaveCount(0);
  expect(writes).toBe(1);
});

for (const manager of [false, true]) {
  test(`AC-FE-R1d-3 ${manager ? '经理' : '员工'}明确拒绝保留输入，可改正重提且未知结果仍锁定`, async ({ page }) => {
    const drawer = await setup(page, manager);
    const target = '60000000-0000-4000-8000-000000000003';
    const custom = '70000000-0000-4000-8000-000000000001';
    await page.route('**/preview', (route) =>
      route.fulfill({
        json: {
          ...preview,
          customFields: { [custom]: '' },
          form: {
            ...preview.form,
            customFields: [{ id: custom, name: '合成备注', valueType: 'string' }],
            fieldModes: { ...preview.form.fieldModes, [`custom:${custom}`]: 'editable' },
          },
        },
      }),
    );
    await page.route('**/references/departmentId**', (route) =>
      route.fulfill({ json: { items: [{ id: target, name: '合成另一部门' }] } }),
    );
    const commands: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    const refusal = '合成业务拒绝，请修改后重提';
    await page.route(manager ? `**/transfers/employees/${employee}` : '**/self-service/transfer', (route) => {
      commands.push(route.request().headers()['idempotency-key']!);
      bodies.push(route.request().postDataJSON());
      if (commands.length === 1)
        return route.fulfill({
          status: manager ? 422 : 409,
          json: { error: { code: 'VALIDATION_FAILED', message: refusal } },
        });
      return route.abort('failed');
    });
    await drawer.locator('input[name="effectiveDate"]').fill('2026-11-02');
    await drawer.locator(`input[name="${custom}"]`).fill('合成原输入');
    await drawer.locator('select[name="departmentId"]').selectOption(target);
    await drawer.getByRole('button', { name: '提交', exact: true }).click();
    await expect(drawer).toContainText(refusal);
    await expect(drawer.locator('input[name="effectiveDate"]')).toHaveValue('2026-11-02');
    await expect(drawer.locator('select[name="departmentId"]')).toHaveValue(target);
    await expect(drawer.locator(`input[name="${custom}"]`)).toHaveValue('合成原输入');
    if (manager) await expect(drawer.locator('select[name="employeeId"]')).toHaveValue(employee);
    await drawer.locator(`input[name="${custom}"]`).fill('合成改正输入');
    await drawer.getByRole('button', { name: '提交', exact: true }).click();
    await expect.poll(() => commands.length).toBe(2);
    expect(commands[1]).not.toBe(commands[0]);
    expect(bodies[1]).toMatchObject({
      effectiveDate: '2026-11-02',
      fields: { departmentId: target },
      customFields: { [custom]: '合成改正输入' },
    });
    await expect(drawer).toContainText('处理中 / 结果待确认');
    await expect(drawer.getByRole('button', { name: '提交', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await openForm(page, manager);
    await expect(drawer).toContainText(commands[1]!);
    await expect(drawer.getByRole('button', { name: '提交', exact: true })).toHaveCount(0);
    expect(commands).toHaveLength(2);
  });
}

const LOCK_BUSY = '检测到你在另一个标签页打开了此单据，请关闭后重试。';
const LOCKS_UNSUPPORTED = '当前浏览器环境不支持安全保存（需 https 访问），命令未发出。';
const transferRecoveryKey = 'italent.commands.pending:transfer';
/** 同源另开一个真实标签页，一直占着调动恢复记录的互斥锁；关闭该页时浏览器释放。 */
async function holdLockInOtherTab(page: Page) {
  const other = await page.context().newPage();
  await other.route('**/lock-holder', (route) => route.fulfill({ body: '', contentType: 'text/html' }));
  await other.goto('/lock-holder');
  await other.evaluate(
    (name) =>
      new Promise<void>((held) => {
        void navigator.locks.request(name, { mode: 'exclusive' }, () => {
          held();
          return new Promise<void>(() => {});
        });
      }),
    transferRecoveryKey,
  );
  return other;
}
/** 持锁页上按锁名数正在排队的登记请求（navigator.locks.query）。 */
const queuedOn = (holder: Page) =>
  holder.evaluate(
    async (name) => (await navigator.locks.query()).pending?.filter((lock) => lock.name === name).length ?? 0,
    transferRecoveryKey,
  );
/** F-558 第 2 轮 P3：持锁页上确认 count 次登记都已在排队（navigator.locks.query），再释放，确保走的是登记竞争。 */
async function releaseWhenQueued(holder: Page, count: number) {
  try {
    await expect.poll(() => queuedOn(holder)).toBe(count);
  } finally {
    await holder.close();
  }
}

// F-110 第 2 轮 P2-1：http 非安全上下文没有 locks 与 randomUUID；提交前就拒绝，按钮不能停在忙碌。
for (const manager of [false, true]) {
  test(`AC-FE-F110-24 DEC-955 非安全上下文：${manager ? '经理' : '本人'}提交提示需 https、零请求、不卡忙碌`, async ({
    page,
  }) => {
    await insecureContext(page);
    let writes = 0;
    await page.route(manager ? `**/transfers/employees/${employee}` : '**/self-service/transfer', (route) => {
      writes++;
      return route.abort('failed');
    });
    const drawer = await setup(page, manager);
    for (let attempt = 0; attempt < 2; attempt++) {
      await drawer.getByRole('button', { name: '提交', exact: true }).click();
      await expect(drawer.getByText(LOCKS_UNSUPPORTED)).toBeVisible();
      await expect(drawer.getByRole('button', { name: '提交', exact: true })).toBeEnabled();
    }
    expect(writes).toBe(0);
    expect(await page.evaluate((key) => localStorage.getItem(key), transferRecoveryKey)).toBeNull();
  });
}

// F-110 第 2 轮 P2-4：登记就被拒（命令未发出）时不要求先重读草稿；发出后的重读保护不变（见上方 R1d-2 用例）。
test('AC-FE-F110-27 经理提交暂存申请遇他页持锁被拒：他页关闭后直接点原按钮，按原单与 revision 提交一次', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const submits: { path: string; ifMatch?: string; command?: string }[] = [];
  await page.route(`**/transfers/employees/${employee}`, (route) =>
    route.fulfill({ status: 201, json: { id: business, revision: 1, employeeRevision: 7, status: 'draft' } }),
  );
  await page.route(`**/employment/businesses/${business}`, (route) => route.fulfill({ json: draft }));
  await page.route(`**/employment/businesses/${business}/submit`, (route) => {
    const headers = route.request().headers();
    submits.push({
      path: new URL(route.request().url()).pathname,
      ifMatch: headers['if-match'],
      command: headers['idempotency-key'],
    });
    return route.fulfill({ json: { ...draft, revision: 5, status: 'in_review' } });
  });
  const drawer = await setup(page, true);
  await drawer.getByRole('button', { name: '暂存', exact: true }).click();
  const submit = drawer.getByRole('button', { name: '提交暂存申请', exact: true });
  await expect(submit).toBeEnabled();
  const holder = await holdLockInOtherTab(page);
  try {
    await submit.click();
    await expect(drawer.getByText(LOCK_BUSY)).toBeVisible({ timeout: 10_000 });
    expect(submits).toEqual([]);
  } finally {
    await holder.close();
  }
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect.poll(() => submits).toHaveLength(1);
  expect(submits[0]).toMatchObject({ path: `/api/tenant/employment/businesses/${business}/submit`, ifMatch: '4' });
  expect(submits[0]!.command).toMatch(/^[0-9a-f-]{36}$/);
});

test('AC-FE-F110-27 正例：提交暂存申请已发出后被拒，仍须先重读草稿，重读后按新 revision 提交', async ({ page }) => {
  let revision = 4;
  const submits: (string | undefined)[] = [];
  await page.route(`**/transfers/employees/${employee}`, (route) =>
    route.fulfill({ status: 201, json: { id: business, revision: 1, employeeRevision: 7, status: 'draft' } }),
  );
  await page.route(`**/employment/businesses/${business}`, (route) => route.fulfill({ json: { ...draft, revision } }));
  await page.route(`**/employment/businesses/${business}/submit`, (route) => {
    submits.push(route.request().headers()['if-match']);
    return submits.length === 1
      ? route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT', message: '单据已被修改' } } })
      : route.fulfill({ json: { ...draft, revision: 6, status: 'in_review' } });
  });
  const drawer = await setup(page, true);
  await drawer.getByRole('button', { name: '暂存', exact: true }).click();
  const submit = drawer.getByRole('button', { name: '提交暂存申请', exact: true });
  await submit.click();
  await expect.poll(() => submits).toEqual(['4']);
  await expect(submit).toBeDisabled();
  revision = 5;
  await drawer.getByRole('button', { name: '重新读取已暂存申请', exact: true }).click();
  await expect(drawer.getByTestId('draft-revision')).toHaveText('5');
  await submit.click();
  await expect.poll(() => submits).toEqual(['4', '5']);
});

const OTHER_TAB = '其他标签页有该对象未确认的命令，本次命令未发出；请等待结果或先查询结果。';
// 查到成功但归属无法确认时的中性提示（F-558 第 3 轮）：不声称本页未提交。
const FOUND_RESULT =
  '已查到原命令执行成功，但无法确认是否由本页发出；本页输入仍保留在下方，请先在“我的申请”核对，避免重复提交。';
// F-558 ①：同一单两页同时提交（第三页占着锁让两页排队），后登记的一页本次未发出，提示走内核 raceOf 的原因，
// 不只显示“处理中”；先登记那页落定后，后一页解锁、原输入仍在。
for (const manager of [false, true]) {
  test(`AC-FE-F558-1 ${manager ? '经理' : '本人'}两页同时提交：后一页提示其他标签页、零请求，落定后输入保留`, async ({
    page,
    context,
  }) => {
    test.setTimeout(60_000);
    const writes: { tab: number; command: string }[] = [];
    let respond = () => {};
    const answered = new Promise<void>((resolve) => (respond = resolve));
    const pageB = await context.newPage();
    await demoRoutes(pageB);
    const tabs = [page, pageB];
    const drawers = [];
    for (const [tab, target] of tabs.entries()) {
      await target.route(manager ? `**/transfers/employees/${employee}` : '**/self-service/transfer', async (route) => {
        writes.push({ tab, command: route.request().headers()['idempotency-key']! });
        await answered;
        return route.fulfill({ status: 201, json: { ...draft, status: 'in_review' } }).catch(() => {});
      });
      const drawer = await setup(target, manager);
      await drawer.locator('input[name="effectiveDate"]').fill('2026-11-02');
      drawers.push(drawer);
    }
    // 第 2 轮 P3：按钮在持锁前定位并确认可点，持锁后只点击；释放前确认两次登记都在排队，竞争不靠时序碰运气。
    const submits = drawers.map((drawer) => drawer.getByRole('button', { name: '提交', exact: true }));
    for (const submit of submits) await expect(submit).toBeEnabled();
    const holder = await holdLockInOtherTab(page);
    for (const submit of submits) await submit.click();
    await releaseWhenQueued(holder, 2);
    await expect.poll(() => writes).toHaveLength(1);
    const loser = drawers[1 - writes[0]!.tab]!;
    await expect(loser.getByText(OTHER_TAB)).toBeVisible();
    await expect(loser.getByText('处理中 / 结果待确认')).toBeVisible();
    await expect(loser).toContainText(writes[0]!.command);
    await expect(loser.getByRole('button', { name: '提交', exact: true })).toBeHidden();
    respond();
    // 先登记那页确认成功、删掉恢复记录；后一页收到 storage 事件解锁，提示随锁定一起消失，输入原样可再提交。
    await expect(loser.getByText(OTHER_TAB)).toHaveCount(0);
    await expect(loser.getByRole('button', { name: '提交', exact: true })).toBeEnabled();
    await expect(loser.locator('input[name="effectiveDate"]')).toHaveValue('2026-11-02');
    if (manager) await expect(loser.locator('select[name="employeeId"]')).toHaveValue(employee);
    expect(writes).toHaveLength(1);
    await pageB.close();
  });
}

// F-558 第 2 轮 P2-3：后一页按提示查询，查到先登记那页的命令已成功（那页回执还没到）：这是“查到他页结果”，
// 不是本页保存成功；后一页从未发出的输入原样保留在表单里，可核对后自行决定是否再提交。
for (const manager of [false, true]) {
  test(`AC-FE-F558-3 ${manager ? '经理' : '本人'}后一页查到他页成功：显示结果，本页原输入仍在、零写请求`, async ({
    page,
    context,
  }) => {
    test.setTimeout(60_000);
    const writes: { tab: number; command: string }[] = [];
    const queries: string[] = [];
    let respond = () => {};
    const answered = new Promise<void>((resolve) => (respond = resolve));
    const dates = ['2026-11-02', '2026-11-09'];
    const pageB = await context.newPage();
    await demoRoutes(pageB);
    const tabs = [page, pageB];
    const drawers = [];
    for (const [tab, target] of tabs.entries()) {
      await target.route(manager ? `**/transfers/employees/${employee}` : '**/self-service/transfer', async (route) => {
        writes.push({ tab, command: route.request().headers()['idempotency-key']! });
        await answered;
        return route.fulfill({ status: 201, json: { ...draft, status: 'in_review' } }).catch(() => {});
      });
      const drawer = await setup(target, manager);
      // F-120 真实投影：服务端已按先登记那页的命令建好调动单（那页的回执还没到）。
      await target.route('**/api/tenant/commands/*/result', (route) => {
        queries.push(new URL(route.request().url()).pathname);
        return route.fulfill({
          json: {
            commandId: writes[0]!.command,
            status: 'succeeded',
            commandType: manager
              ? 'POST /api/tenant/employment/transfers/employees/:id'
              : 'POST /api/tenant/self-service/transfer',
            businessType: 'transfer',
            businessId: business,
            revision: 1,
            httpStatus: 201,
            completedAt: '2026-11-02T02:00:00.000Z',
          },
        });
      });
      await target.route(`**/employment/businesses/${business}`, (route) =>
        route.fulfill({ json: { ...draft, revision: 1, status: 'in_review' } }),
      );
      await drawer.locator('input[name="effectiveDate"]').fill(dates[tab]!);
      drawers.push(drawer);
    }
    const submits = drawers.map((drawer) => drawer.getByRole('button', { name: '提交', exact: true }));
    for (const submit of submits) await expect(submit).toBeEnabled();
    const holder = await holdLockInOtherTab(page);
    for (const submit of submits) await submit.click();
    await releaseWhenQueued(holder, 2);
    await expect.poll(() => writes).toHaveLength(1);
    const loserTab = 1 - writes[0]!.tab;
    const loser = drawers[loserTab]!;
    await expect(loser.getByText(OTHER_TAB)).toBeVisible();
    await loser.getByRole('button', { name: '查询结果', exact: true }).click();
    await expect(loser.getByText('处理中 / 结果待确认')).toHaveCount(0);
    // 本页原输入仍在、可编辑（不被他页结果替换或清空），他页的结果另行显示。
    await expect(loser.locator('input[name="effectiveDate"]')).toHaveValue(dates[loserTab]!);
    await expect(loser.getByRole('button', { name: '提交', exact: true })).toBeEnabled();
    await expect(loser.getByText(FOUND_RESULT)).toBeVisible();
    await expect(loser).toContainText(business);
    expect(queries).toEqual([`/api/tenant/commands/${writes[0]!.command}/result`]);
    expect(writes).toHaveLength(1);
    respond();
    await pageB.close();
  });
}
