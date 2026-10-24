import type { Page, Request } from '@playwright/test';
import { test, expect, employee } from './fixtures.js';
import { applicationId, business, employeeRevision, openDetail, rows, setup, target } from './intern-fixtures.js';

const dialog = (page: Page) => page.getByRole('dialog', { name: '实习转正申请', exact: true });
const submit = (page: Page) => dialog(page).getByRole('button', { name: /提\s*交$/ });
const field = (page: Page, label: string) =>
  dialog(page)
    .locator('.ant-form-item')
    .filter({ has: page.locator('label').getByText(label, { exact: true }) });
async function date(page: Page, label: string, value: string) {
  await field(page, label).locator('input').fill(value);
  await field(page, label).locator('input').press('Enter');
  await dialog(page).locator('.ant-modal-title').click();
}
async function month(page: Page) {
  await dialog(page)
    .getByRole('combobox', { name: '试用期(月)', exact: true })
    .locator('xpath=ancestor::div[contains(@class,"ant-select-selector")]')
    .click();
  await page.locator('.ant-select-dropdown:visible').getByText('1个月', { exact: true }).click();
}
const posted = (request: Request) => ({
  body: request.postDataJSON() as Record<string, unknown>,
  revision: request.headers()['if-match'],
  key: request.headers()['idempotency-key'],
});
const rejection = (status: number, reason: string, message: string) => ({
  status,
  json: { error: { code: status === 409 ? 'CONFLICT' : 'VALIDATION_FAILED', message, details: { reason } } },
});

async function application(page: Page) {
  const fixture = await setup(page);
  const created: ReturnType<typeof posted>[] = [];
  const submitted: ReturnType<typeof posted>[] = [];
  const state = { submitted: false, revision: 1, values: {} as Record<string, unknown> };
  const receipt = (status: string, revision: number): Record<string, unknown> =>
    business('intern_regularization', {
      id: applicationId,
      status,
      revision,
      mode: 'application',
      probation: false,
      probationMonths: null,
      probationEndDate: null,
      ...created.at(-1)?.body,
      ...state.values,
    });
  await page.route(`**/employment/employees/${employee}/businesses`, (route) => {
    created.push(posted(route.request()));
    state.values = created.at(-1)!.body;
    fixture.server.employeeRevision = employeeRevision + 1;
    return route.fulfill({ status: 201, json: receipt('draft', 1) });
  });
  await page.route(`**/employment/businesses/${applicationId}`, (route) =>
    route.fulfill({ json: receipt(state.submitted ? 'in_review' : 'draft', state.revision) }),
  );
  await page.route(`**/employment/businesses/${applicationId}/submit`, (route) => {
    submitted.push(posted(route.request()));
    state.submitted = true;
    state.revision = 2;
    return route.fulfill({ json: receipt('in_review', 2) });
  });
  await page.route('**/employment/interns?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    fixture.queries.push(query);
    return route.fulfill({
      json: {
        items:
          query.get('view') === 'converting' && state.submitted
            ? [{ ...rows.converting, revision: state.revision }]
            : query.get('view') === 'interning' && !state.submitted
              ? [rows.interning]
              : [],
        page: Number(query.get('page')),
        pageSize: 30,
        hasDataPermission: true,
      },
    });
  });
  await openDetail(page, 'interning');
  await page.getByRole('button', { name: '实习转正申请', exact: true }).click();
  await date(page, '实习转正日期', '2026-10-16');
  return { ...fixture, created, submitted, state, receipt };
}

test('AC-FE-F285-01 带试用期申请：五区共用、推算可手改、两步真实回执后进入实习转正中', async ({ page }) => {
  const { created, submitted } = await application(page);
  await expect(dialog(page).getByRole('heading')).toHaveText([
    '员工信息',
    '任职信息',
    '试用期信息',
    '汇报关系',
    '合同协议',
  ]);
  await month(page);
  await expect(field(page, '预计试用结束日期').locator('input')).toHaveValue('2026-11-15');
  await date(page, '预计试用结束日期', '2026-12-01');
  await submit(page).click();
  await expect(page.getByRole('button', { name: '实习转正中', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('cell', { name: '审批中', exact: true })).toBeVisible();
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({
    revision: String(employeeRevision),
    body: {
      kind: 'intern_regularization',
      mode: 'application',
      effectiveDate: '2026-10-16',
      fields: { departmentId: rows.interning.departmentId },
      probation: true,
      probationMonths: 1,
      probationEndDate: '2026-12-01',
    },
  });
  expect(submitted).toEqual([{ body: {}, revision: '1', key: expect.any(String) }]);
  expect(submitted[0]!.key).not.toBe(created[0]!.key);
});

test('AC-FE-F285-02 关闭试用期清空，重新开启不残留；选择否申请成功', async ({ page }) => {
  const { created } = await application(page);
  await month(page);
  await dialog(page).getByRole('radio', { name: '否', exact: true }).check();
  await expect(field(page, '试用期(月)')).toHaveCount(0);
  await dialog(page).getByRole('radio', { name: '是', exact: true }).check();
  await expect(field(page, '预计试用结束日期').locator('input')).toHaveValue('');
  await submit(page).click();
  await expect(field(page, '试用期(月)').getByText('请填写试用期(月)', { exact: true })).toBeVisible();
  expect(created).toHaveLength(0);
  await dialog(page).getByRole('radio', { name: '否', exact: true }).check();
  await submit(page).click();
  await expect(page.getByRole('button', { name: '实习转正中', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(created[0]!.body.probation).toBe(false);
  expect(created[0]!.body).not.toHaveProperty('probationMonths');
  expect(created[0]!.body).not.toHaveProperty('probationEndDate');
});

test('AC-FE-F285-03 月数为空或结束日过早阻止提交；服务端400在字段显示并保留输入可重提', async ({ page }) => {
  const { created } = await application(page);
  await submit(page).click();
  await expect(field(page, '试用期(月)').getByText('请填写试用期(月)', { exact: true })).toBeVisible();
  expect(created).toHaveLength(0);
  await month(page);
  await date(page, '预计试用结束日期', '2026-10-15');
  await submit(page).click();
  await expect(field(page, '预计试用结束日期').getByText('预计试用结束日期不得早于实习转正日期')).toBeVisible();
  expect(created).toHaveLength(0);
  await date(page, '预计试用结束日期', '2026-11-20');
  const attempts: ReturnType<typeof posted>[] = [];
  await page.route(`**/employment/employees/${employee}/businesses`, (route) => {
    attempts.push(posted(route.request()));
    return attempts.length === 1
      ? route.fulfill(rejection(400, 'PROBATION_MONTHS_REQUIRED', '有试用期时必须填写试用期(月)'))
      : route.fallback();
  });
  await submit(page).click();
  await expect(field(page, '试用期(月)').getByText('有试用期时必须填写试用期(月)')).toBeVisible();
  await expect(field(page, '预计试用结束日期').locator('input')).toHaveValue('2026-11-20');
  await expect(submit(page)).toBeEnabled();
  await submit(page).click();
  await expect(page.getByRole('button', { name: '实习转正中', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(attempts[1]!.body).toEqual(attempts[0]!.body);
  expect(attempts[1]!.key).not.toBe(attempts[0]!.key);
});

test('AC-FE-F285-04 创建结果未知关闭重开及切到直接转正仍锁定，不发第二次命令', async ({ page }) => {
  await application(page);
  let attempts = 0;
  await page.route(`**/employment/employees/${employee}/businesses`, (route) => {
    attempts += 1;
    return route.abort('failed');
  });
  await dialog(page).getByRole('radio', { name: '否', exact: true }).check();
  await submit(page).click();
  await expect(submit(page)).toBeDisabled();
  await dialog(page)
    .getByRole('button', { name: /取\s*消/ })
    .click();
  await page.getByRole('button', { name: '实习转正申请', exact: true }).click();
  await expect(submit(page)).toBeDisabled();
  await dialog(page)
    .getByRole('button', { name: /取\s*消/ })
    .click();
  await page.getByRole('button', { name: '实习转正', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: '实习转正', exact: true }).getByRole('button', { name: /保\s*存/ }),
  ).toBeDisabled();
  expect(attempts).toBe(1);
});

test('AC-FE-F285-05 提交审批明确拒绝：重读、关闭重开仍处理同一草稿，不重复创建', async ({ page }) => {
  const { created, submitted, state, receipt } = await application(page);
  let reads = 0;
  let attempts = 0;
  await page.route(`**/employment/businesses/${applicationId}`, (route) => {
    reads += 1;
    return route.fulfill({ json: receipt(state.submitted ? 'in_review' : 'draft', state.revision) });
  });
  await page.route(`**/employment/businesses/${applicationId}/submit`, (route) => {
    attempts += 1;
    if (attempts === 1) return route.fulfill(rejection(422, 'NO_PROCESS', '未匹配到审批流程'));
    submitted.push(posted(route.request()));
    state.submitted = true;
    state.revision = 2;
    return route.fulfill({ json: receipt('in_review', 2) });
  });
  await dialog(page).getByRole('radio', { name: '否', exact: true }).check();
  await submit(page).click();
  await expect(dialog(page).getByText('未匹配到审批流程').first()).toBeVisible();
  await expect.poll(() => reads).toBeGreaterThan(0);
  await dialog(page)
    .getByRole('button', { name: /取\s*消/ })
    .click();
  await page.getByRole('button', { name: '实习转正申请', exact: true }).click();
  await submit(page).click();
  await expect(page.getByRole('button', { name: '实习转正中', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(created).toHaveLength(1);
  expect(submitted).toHaveLength(1);
});

test('AC-FE-F285-06 创建409：重读最新部门、保留日期与试用期，核对后用新revision重提', async ({ page }) => {
  const { created, server, receipt } = await application(page);
  await page.route(`**/employment/employees/${employee}/businesses`, (route) => {
    created.push(posted(route.request()));
    server.employeeRevision += 1;
    if (created.length === 1) {
      server.record = { ...server.record, departmentId: target };
      return route.fulfill({
        status: 409,
        json: { error: { code: 'REVISION_CONFLICT', message: '版本冲突' } },
      });
    }
    return route.fulfill({
      status: 201,
      json: { ...receipt('draft', 1), employeeRevision: server.employeeRevision },
    });
  });
  await month(page);
  await submit(page).click();
  await expect(dialog(page).getByRole('button', { name: '已核对差异，继续编辑' })).toBeVisible();
  await expect(submit(page)).toBeDisabled();
  await dialog(page).getByRole('button', { name: '已核对差异，继续编辑' }).click();
  await expect(field(page, '实习转正日期').locator('input')).toHaveValue('2026-10-16');
  await expect(field(page, '部门').getByText('合成转正部门', { exact: true })).toBeVisible();
  await submit(page).click();
  await expect(page.getByRole('button', { name: '实习转正中', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(created.map((item) => item.revision)).toEqual(['5', '6']);
  expect(created[1]!.body.fields).toEqual({ departmentId: target });
});

test('AC-FE-F285-07 提交审批结果未知：换视图后直接转正、撤回与撤销均不能绕开员工恢复锁', async ({ page }) => {
  const { state, created } = await application(page);
  let attempts = 0;
  await page.route(`**/employment/businesses/${applicationId}/submit`, (route) => {
    attempts += 1;
    state.submitted = true;
    state.revision = 2;
    return route.abort('failed');
  });
  await dialog(page).getByRole('radio', { name: '否', exact: true }).check();
  await submit(page).click();
  await expect(submit(page)).toBeDisabled();
  await dialog(page)
    .getByRole('button', { name: /取\s*消/ })
    .click();
  await page.getByRole('dialog', { name: '员工档案' }).getByRole('button', { name: '关闭' }).click();
  await openDetail(page, 'converting');
  for (const name of [/撤\s*回/, /撤\s*销/]) await expect(page.getByRole('button', { name })).toBeDisabled();
  await page.getByRole('button', { name: '实习转正', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: '实习转正', exact: true }).getByRole('button', { name: /保\s*存/ }),
  ).toBeDisabled();
  expect(created).toHaveLength(1);
  expect(attempts).toBe(1);
});

test('AC-FE-F285-08 错误创建回执锁定且不发第二步', async ({ page }) => {
  const { receipt, submitted } = await application(page);
  await page.route(`**/employment/employees/${employee}/businesses`, (route) =>
    route.fulfill({ status: 201, json: { ...receipt('draft', 1), employeeRevision } }),
  );
  await dialog(page).getByRole('radio', { name: '否', exact: true }).check();
  await submit(page).click();
  await expect(dialog(page).getByText(/当前表单已锁定/)).toBeVisible();
  expect(submitted).toHaveLength(0);
});

test('AC-FE-F285-09 403资格拒绝显示服务端原因并重读列表，不在前端补资格规则', async ({ page }) => {
  const { queries } = await application(page);
  await page.route(`**/employment/employees/${employee}/businesses`, (route) =>
    route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN', message: '当前身份不能发起此申请' } } }),
  );
  await dialog(page).getByRole('radio', { name: '否', exact: true }).check();
  const before = queries.length;
  await submit(page).click();
  await expect(dialog(page).getByText('当前身份不能发起此申请').first()).toBeVisible();
  await expect.poll(() => queries.length).toBeGreaterThan(before);
  await expect(dialog(page).getByRole('radio', { name: '否', exact: true })).toBeChecked();
});

test('AC-FE-F285-10 本单已确认提交，列表失败只需重试定位，不锁定也不重发写命令', async ({ page }) => {
  const { created, submitted } = await application(page);
  let unavailable = true;
  await page.route('**/employment/interns?*', (route) =>
    unavailable
      ? route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: '列表暂不可用' } } })
      : route.fallback(),
  );
  await dialog(page).getByRole('radio', { name: '否', exact: true }).check();
  await submit(page).click();
  await expect(page.getByRole('button', { name: '实习转正中', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByText('申请已提交，列表定位失败，请重试读取。')).toBeVisible();
  unavailable = false;
  await page.getByRole('button', { name: '重试定位', exact: true }).click();
  await expect(page.getByRole('cell', { name: '审批中', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '查看详情', exact: true }).click();
  await expect(page.getByRole('button', { name: /撤\s*回/ })).toBeEnabled();
  expect(created).toHaveLength(1);
  expect(submitted).toHaveLength(1);
});

test('AC-FE-F285-11 提交审批409重读同一草稿，核对后按草稿新revision重提', async ({ page }) => {
  const { state, created, submitted, receipt } = await application(page);
  await page.route(`**/employment/businesses/${applicationId}/submit`, (route) => {
    submitted.push(posted(route.request()));
    if (submitted.length === 1) {
      state.revision = 3;
      return route.fulfill({
        status: 409,
        json: { error: { code: 'REVISION_CONFLICT', message: '草稿版本冲突' } },
      });
    }
    state.revision = 4;
    state.submitted = true;
    return route.fulfill({ json: receipt('in_review', 4) });
  });
  await dialog(page).getByRole('radio', { name: '否', exact: true }).check();
  await submit(page).click();
  await expect(dialog(page).getByRole('button', { name: '已核对差异，继续编辑' })).toBeVisible();
  await expect(submit(page)).toBeDisabled();
  await dialog(page).getByRole('button', { name: '已核对差异，继续编辑' }).click();
  await submit(page).click();
  await expect(page.getByRole('button', { name: '实习转正中', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(submitted.map((item) => item.revision)).toEqual(['1', '3']);
  expect(created).toHaveLength(1);
});

for (const status of [403, 409, 422]) {
  test(`AC-FE-F285-12-${status} 明确拒绝保留原输入，并显示本单真实试用期回读`, async ({ page }) => {
    const { state, receipt, created } = await application(page);
    await page.route(`**/employment/businesses/${applicationId}/submit`, (route) => {
      // F-306：本单最新版本，不能用原输入或员工当前试用期冒充。
      state.values = { ...state.values, probationMonths: 2, probationEndDate: '2026-12-20' };
      return route.fulfill(rejection(status, 'BUSINESS_REJECTED', '服务端明确拒绝本次提交'));
    });
    await month(page);
    await date(page, '预计试用结束日期', '2026-11-20');
    await submit(page).click();
    await expect(dialog(page).getByText('服务端明确拒绝本次提交').first()).toBeVisible();
    await expect(field(page, '预计试用结束日期').locator('input')).toHaveValue('2026-11-20');
    const latest = dialog(page).getByRole('region', { name: '服务端最新值' });
    await expect(latest.getByText('2026-12-20', { exact: true })).toBeVisible();
    await expect(latest.getByText('2', { exact: true })).toBeVisible();
    expect(receipt('draft', 1).probation).toBe(true);
    expect(created).toHaveLength(1);
    await expect(submit(page)).toBeEnabled();
  });
}

test('AC-FE-F285-13 两步提交冲突恢复核对最新试用期，未保存结束日不推算', async ({ page }) => {
  const { state, submitted, receipt } = await application(page);
  await page.route(`**/employment/businesses/${applicationId}/submit`, (route) => {
    submitted.push(posted(route.request()));
    state.revision = 3;
    state.values = { ...state.values, probationMonths: 2, probationEndDate: null };
    return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT', message: '草稿版本冲突' } } });
  });
  await month(page);
  await submit(page).click();
  await expect(dialog(page).getByRole('button', { name: '已核对差异，继续编辑' })).toBeVisible();
  await expect(dialog(page).getByRole('row').filter({ hasText: '试用期(月)' })).toBeVisible();
  await expect(field(page, '试用期(月)').getByText('2个月', { exact: true })).toBeVisible();
  await expect(field(page, '预计试用结束日期').locator('input')).toHaveValue('');
  await dialog(page).getByRole('button', { name: '已核对差异，继续编辑' }).click();
  await page.route(`**/employment/businesses/${applicationId}/submit`, (route) => {
    submitted.push(posted(route.request()));
    state.submitted = true;
    state.revision = 4;
    return route.fulfill({ json: receipt('in_review', 4) });
  });
  await submit(page).click();
  await expect(page.getByRole('button', { name: '实习转正中', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(submitted.map((item) => item.revision)).toEqual(['1', '3']);
  expect(submitted.every((item) => Object.keys(item.body).length === 0)).toBe(true);
});

for (const mode of ['none', 'trimmed'] as const) {
  test(`AC-FE-F285-14-${mode} 冲突回读为空或裁剪时，不复活原试用期输入`, async ({ page }) => {
    const { receipt } = await application(page);
    await page.route(`**/employment/businesses/${applicationId}`, (route) => {
      const latest: Record<string, unknown> = {
        ...receipt('draft', 3),
        probation: false,
        probationMonths: null,
        probationEndDate: null,
      };
      if (mode === 'trimmed') {
        for (const key of ['probation', 'probationMonths', 'probationEndDate']) delete latest[key];
      }
      return route.fulfill({ json: latest });
    });
    await page.route(`**/employment/businesses/${applicationId}/submit`, (route) =>
      route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT', message: '草稿版本冲突' } } }),
    );
    await month(page);
    await submit(page).click();
    await expect(dialog(page).getByRole('button', { name: '已核对差异，继续编辑' })).toBeVisible();
    await expect(dialog(page).getByRole('radio', { name: '是', exact: true })).not.toBeChecked();
    if (mode === 'none') await expect(dialog(page).getByRole('radio', { name: '否', exact: true })).toBeChecked();
    else await expect(dialog(page).getByRole('radio', { name: '否', exact: true })).not.toBeChecked();
    await expect(field(page, '试用期(月)')).toHaveCount(0);
    await dialog(page)
      .getByRole('button', { name: /取\s*消/ })
      .click();
    await page.getByRole('button', { name: '实习转正申请', exact: true }).click();
    await expect(dialog(page).getByRole('radio', { name: '是', exact: true })).not.toBeChecked();
    await expect(submit(page)).toBeDisabled();
  });
}

for (const targetPage of [100, 101]) {
  test(`AC-FE-F285-15 第${targetPage}页申请已提交：切换视图并独立继续定位`, async ({ page }) => {
    const { state, created, submitted } = await application(page);
    const seen: number[] = [];
    await page.route('**/employment/interns?*', (route) => {
      const query = new URL(route.request().url()).searchParams;
      const current = Number(query.get('page'));
      const converting = query.get('view') === 'converting';
      if (converting) seen.push(current);
      const preceding = Array.from({ length: 30 }, (_, index) => {
        const serial = String((current - 1) * 30 + index + 1).padStart(12, '0');
        return {
          ...rows.converting,
          effectiveDate: '2026-10-01',
          employeeId: `30000000-0000-4000-9000-${serial}`,
          id: `90000000-0000-4000-8000-${serial}`,
        };
      });
      return route.fulfill({
        json: {
          items: converting
            ? current === targetPage
              ? [{ ...rows.converting, effectiveDate: '2026-10-16', revision: state.revision }]
              : preceding
            : [rows.interning],
          page: current,
          pageSize: 30,
          hasDataPermission: true,
        },
      });
    });
    await dialog(page).getByRole('radio', { name: '否', exact: true }).check();
    await submit(page).click();
    await expect.poll(() => Math.max(...seen)).toBe(100);
    expect(state.submitted).toBe(true);
    expect(created).toHaveLength(1);
    expect(submitted).toHaveLength(1);
    // 旧实现第 101 页必须在这里判红：写入及本单回读成功，最终视图却仍停留在实习中。
    await expect(page.getByRole('button', { name: '实习转正中', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog(page)).toHaveCount(0);
    if (targetPage === 101) await page.getByRole('button', { name: '继续定位', exact: true }).click();
    await expect(page.getByText(`第 ${targetPage} 页`, { exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: '审批中', exact: true })).toHaveCount(1);
    await page.getByRole('button', { name: '查看详情', exact: true }).click();
    await expect(page.getByRole('button', { name: /撤\s*回/ })).toBeEnabled();
    expect(created).toHaveLength(1);
    expect(submitted).toHaveLength(1);
  });
}

for (const readback of ['unavailable', 'draft'] as const) {
  test(`AC-FE-F285-16 本单回读${readback}不能确认写入，关闭重开仍锁定`, async ({ page }) => {
    const { state, created, submitted, receipt } = await application(page);
    await page.route(`**/employment/businesses/${applicationId}`, (route) => {
      if (!state.submitted) return route.fallback();
      return readback === 'unavailable'
        ? route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: '本单暂不可读' } } })
        : route.fulfill({ json: receipt('draft', state.revision) });
    });
    await dialog(page).getByRole('radio', { name: '否', exact: true }).check();
    await submit(page).click();
    await expect(dialog(page).getByText(/当前表单已锁定/)).toBeVisible();
    await dialog(page)
      .getByRole('button', { name: /取\s*消/ })
      .click();
    await page.getByRole('button', { name: '实习转正申请', exact: true }).click();
    await expect(submit(page)).toBeDisabled();
    expect(created).toHaveLength(1);
    expect(submitted).toHaveLength(1);
  });
}

for (const status of ['approved', 'effective'] as const) {
  test(`AC-FE-F285-17 写后本单已${status}时按真实状态切换视图`, async ({ page }) => {
    const { state, receipt, created, submitted } = await application(page);
    const view = status === 'effective' ? 'converted' : 'converting';
    await page.route(`**/employment/businesses/${applicationId}`, (route) =>
      state.submitted ? route.fulfill({ json: receipt(status, 3) }) : route.fallback(),
    );
    await page.route('**/employment/interns?*', (route) => {
      const query = new URL(route.request().url()).searchParams;
      return state.submitted && query.get('view') === view
        ? route.fulfill({
            json: { items: [{ ...rows[view], id: applicationId, state: status }], page: 1, pageSize: 30 },
          })
        : route.fallback();
    });
    await dialog(page).getByRole('radio', { name: '否', exact: true }).check();
    await submit(page).click();
    await expect(
      page.getByRole('button', { name: status === 'effective' ? '已转正' : '实习转正中', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog(page)).toHaveCount(0);
    expect(created).toHaveLength(1);
    expect(submitted).toHaveLength(1);
  });
}

test('AC-FE-F285-18 定位未找到可重读，切换视图后迟到读取不覆盖用户选择', async ({ page }) => {
  const { created, submitted } = await application(page);
  let hold = false;
  let release: (() => void) | undefined;
  await page.route('**/employment/interns?*', async (route) => {
    if (new URL(route.request().url()).searchParams.get('view') !== 'converting') return route.fallback();
    // 初次列表读取和定位都为空；显式在用户重试时延后响应，不依赖 React 的挂载请求次数。
    if (hold)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    await route.fulfill({ json: { items: [], page: 1, pageSize: 30, hasDataPermission: true } });
  });
  await dialog(page).getByRole('radio', { name: '否', exact: true }).check();
  await submit(page).click();
  await expect(page.getByText('申请已提交，当前可见列表中未找到，可重新读取。')).toBeVisible();
  hold = true;
  await page.getByRole('button', { name: '重试定位', exact: true }).click();
  await expect.poll(() => !!release).toBe(true);
  await page.goBack();
  release!();
  await expect(page.getByRole('button', { name: '实习中', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(/申请已提交，/)).toHaveCount(0);
  expect(created).toHaveLength(1);
  expect(submitted).toHaveLength(1);
});

test('AC-FE-F285-19 打开员工详情停止后台定位，迟到结果不干扰后续操作', async ({ page }) => {
  const { created, submitted } = await application(page);
  let release: (() => void) | undefined;
  await page.route('**/employment/interns?*', async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get('view') !== 'converting') return route.fallback();
    const current = Number(query.get('page'));
    const preceding = Array.from({ length: 30 }, (_, index) => ({
      ...rows.converting,
      effectiveDate: '2026-10-01',
      id: `90000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      employeeId: `30000000-0000-4000-9000-${String(index + 1).padStart(12, '0')}`,
    }));
    if (current === 2)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    await route.fulfill({
      json: { items: current === 1 ? preceding : [rows.converting], page: current, pageSize: 30 },
    });
  });
  await page.route('**/personnel/employees/30000000-0000-4000-9000-*', (route) =>
    route.fulfill({
      json: { id: new URL(route.request().url()).pathname.split('/').at(-1), name: '前置合成员工', revision: 1 },
    }),
  );
  await dialog(page).getByRole('radio', { name: '否', exact: true }).check();
  await submit(page).click();
  await expect.poll(() => !!release).toBe(true);
  await page.getByRole('button', { name: '查看详情', exact: true }).first().click();
  // 响应仍在途，打开详情本身就应停止定位；不能等它自动翻页后才取消。
  await expect(page.getByText('申请已提交，正在定位列表中的申请。')).toHaveCount(0);
  release!();
  await expect(page.getByText('第 1 页', { exact: true })).toBeVisible();
  expect(created).toHaveLength(1);
  expect(submitted).toHaveLength(1);
});

for (const action of ['视图', '筛选', '翻页', '后退前进'] as const) {
  test(`AC-FE-F285-20 ${action}取消定位任务，迟到响应和历史导航不恢复扫描`, async ({ page }) => {
    const { created, submitted } = await application(page);
    const reads: number[] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/employment/interns?*', async (route) => {
      const query = new URL(route.request().url()).searchParams;
      if (query.get('view') !== 'converting') return route.fallback();
      const current = Number(query.get('page'));
      reads.push(current);
      const preceding = Array.from({ length: 30 }, (_, index) => ({
        ...rows.converting,
        effectiveDate: '2026-10-01',
        id: `90000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        employeeId: `30000000-0000-4000-9000-${String(index + 1).padStart(12, '0')}`,
      }));
      if (current === 2) await pending;
      await route.fulfill({
        json: { items: current === 1 ? preceding : [rows.converting], page: current, pageSize: 30 },
      });
    });
    await dialog(page).getByRole('radio', { name: '否', exact: true }).check();
    await submit(page).click();
    await expect.poll(() => reads.includes(2)).toBe(true);
    if (action === '视图') await page.getByRole('button', { name: '实习中', exact: true }).click();
    if (action === '筛选') {
      await page.getByRole('textbox', { name: '姓名 / 工号', exact: true }).fill('合成筛选');
      await page.getByRole('button', { name: /查\s*询/ }).click();
    }
    if (action === '翻页') await page.getByRole('button', { name: '下一页', exact: true }).click();
    if (action === '后退前进') await page.goBack();
    await expect(page.getByText(/申请已提交，/)).toHaveCount(0);
    release();
    if (action === '后退前进') {
      await expect(page.getByRole('button', { name: '实习中', exact: true })).toHaveAttribute('aria-pressed', 'true');
      const beforeForward = reads.length;
      await page.goForward();
      await expect(page.getByRole('button', { name: '实习转正中', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      // 等正常列表读取及迟到响应落定，防止“尚未翻页”造成阴性断言假绿。
      await page.waitForLoadState('networkidle');
      await expect(page.getByText('第 1 页', { exact: true })).toBeVisible();
      expect(reads.slice(beforeForward)).toEqual([1]);
    }
    await expect(page.getByText(action === '翻页' ? '第 2 页' : '第 1 页', { exact: true })).toBeVisible();
    await expect(page.getByText(/申请已提交，/)).toHaveCount(0);
    expect(created).toHaveLength(1);
    expect(submitted).toHaveLength(1);
  });
}
