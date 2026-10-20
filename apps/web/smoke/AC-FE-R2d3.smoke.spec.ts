import type { Page, Request } from '@playwright/test';
import { test, expect, employee } from './fixtures.js';
import {
  applicationId,
  department,
  business,
  conflict,
  employeeRevision,
  manager,
  openDetail,
  rows,
  setup,
  target,
} from './intern-fixtures.js';

const headers = {
  interning: ['姓名', '工号', '部门', '职位', '入职日期', '人员状态'],
  converting: ['姓名', '工号', '部门', '职位', '实习转正日期', '审批状态'],
  converted: [
    '姓名',
    '工号',
    '部门',
    '职位',
    '实习转正日期',
    '人员状态',
    '试用期开始日期',
    '试用期(月)',
    '预计试用结束日期',
  ],
  left: ['姓名', '工号', '部门', '职位', '入职日期', '实习结束日期'],
};
const labels = { interning: '实习中', converting: '实习转正中', converted: '已转正', left: '已离职' } as const;
const dialog = (page: Page) => page.getByRole('dialog').last();
const save = (page: Page, name: RegExp = /保\s*存$/) => dialog(page).getByRole('button', { name });

async function choose(page: Page, label: string, text: string) {
  await dialog(page)
    .getByRole('combobox', { name: label, exact: true })
    .locator('xpath=ancestor::div[contains(@class,"ant-select-selector")]')
    .click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').getByText(text).click();
}
async function date(page: Page, label: string, value: string) {
  const input = dialog(page)
    .locator('.ant-form-item')
    .filter({ has: page.locator('label').getByText(label, { exact: true }) })
    .locator('input');
  await input.fill(value);
  await input.press('Enter');
  await dialog(page).locator('.ant-modal-title').click();
}
const posted = (request: Request) => ({
  body: request.postDataJSON() as Record<string, unknown>,
  ifMatch: request.headers()['if-match'],
  key: request.headers()['idempotency-key'],
});

test('AC-FE-R2d3-01 四视图各按 view 读，列按投影，筛选 / 分页 / 切换视图不串数据', async ({ page }) => {
  const { queries } = await setup(page);
  await expect(page.getByRole('heading', { name: '实习生', exact: true })).toBeVisible();
  expect(queries[0]?.get('view')).toBe('interning');
  expect(queries[0]?.get('pageSize')).toBe('30');
  for (const view of ['interning', 'converting', 'converted', 'left'] as const) {
    await page.getByRole('button', { name: labels[view], exact: true }).click();
    await expect(page.getByRole('button', { name: labels[view], exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => queries.at(-1)?.get('view')).toBe(view);
    await expect(page.locator('.intern-table .ant-table-thead th')).toHaveText([...headers[view], '操作']);
  }
  await expect(page.getByRole('cell', { name: '2026-11-15', exact: true })).toBeHidden();
  await page.getByRole('button', { name: '已转正', exact: true }).click();
  await expect(page.getByRole('cell', { name: '2026-11-15', exact: true })).toBeVisible();
  await page.getByLabel('姓名 / 工号', { exact: true }).fill('合成');
  await page.getByRole('button', { name: /查\s*询/ }).click();
  await expect.poll(() => queries.at(-1)?.get('keyword')).toBe('合成');
  expect(queries.at(-1)?.get('view')).toBe('converted');
  await page.getByRole('button', { name: '实习中', exact: true }).click();
  await expect.poll(() => queries.at(-1)?.get('view')).toBe('interning');
  expect(queries.at(-1)?.has('keyword')).toBe(false);
  await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
});

test('AC-FE-R2d3-02 筛选字段不可见时不显示控件；无按钮时详情不出入口', async ({ page }) => {
  await setup(page, { viewableFields: ['effectiveDate'], buttons: [] });
  await expect(page.getByRole('button', { name: '查看详情', exact: true })).toBeVisible();
  await expect(page.getByLabel('姓名 / 工号', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: '部门', exact: true })).toHaveCount(0);
  await expect(page.getByRole('cell', { name: rows.interning.name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '查看详情', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('员工档案').first()).toBeVisible();
  for (const name of ['实习转正', '实习转正申请', '结束实习'])
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
});

test('AC-FE-R2d3-03 直接实习转正：试用期自动算、超编确认后同一上下文重提、成功后刷新', async ({ page }) => {
  const { queries, server } = await setup(page);
  const sent: ReturnType<typeof posted>[] = [];
  await page.route(`**/employment/interns/${employee}/regularize`, (route) => {
    sent.push(posted(route.request()));
    if (sent.length === 1)
      return route.fulfill(
        conflict('已超出设定编制，确认后继续保存', { reason: 'CONFIRMATION_REQUIRED', warnings: [] }),
      );
    server.employeeRevision = employeeRevision + 1;
    return route.fulfill({ status: 201, json: business('intern_regularization') });
  });
  await openDetail(page, 'interning');
  await page.getByRole('button', { name: '实习转正', exact: true }).click();
  for (const section of ['员工信息', '任职信息', '试用期信息', '汇报关系', '合同协议'])
    await expect(dialog(page).getByRole('heading', { name: section, exact: true })).toBeVisible();
  await date(page, '实习转正日期', '2026-10-16');
  await choose(page, '部门', '合成转正部门');
  await choose(page, '试用期(月)', '1个月');
  await expect(dialog(page).locator('input[value="2026-11-15"]')).toBeVisible();
  await choose(page, '直线经理', '合成经理');
  const before = queries.length;
  await save(page).click();
  await expect(page.getByText('已超出设定编制，确认后继续保存').last()).toBeVisible();
  await page
    .getByRole('button', { name: /确\s*定/ })
    .last()
    .click();
  await expect(page.getByText('实习转正成功')).toBeVisible();
  expect(sent).toHaveLength(2);
  expect(sent[0]!.body).toEqual({
    effectiveDate: '2026-10-16',
    departmentId: target,
    directManagerId: manager,
    probation: true,
    probationMonths: 1,
    probationEndDate: '2026-11-15',
  });
  expect(sent[1]!.body).toEqual({ ...sent[0]!.body, confirmed: true });
  expect([sent[0]!.ifMatch, sent[1]!.ifMatch]).toEqual([String(employeeRevision), String(employeeRevision)]);
  expect(sent[1]!.key).not.toBe(sent[0]!.key);
  await expect.poll(() => queries.length).toBeGreaterThan(before);
  await expect(page.getByRole('dialog', { name: '员工档案' })).toHaveCount(0);
});

test('AC-FE-R2d3-04 结束实习：在途转正确认、显示取消待入职开关，确认后重提', async ({ page }) => {
  const { server } = await setup(page);
  const sent: ReturnType<typeof posted>[] = [];
  await page.route(`**/employment/interns/${employee}/terminate`, (route) => {
    sent.push(posted(route.request()));
    if (sent.length === 1)
      return route.fulfill(
        conflict('此人有已通过审批、尚未生效的实习转正（待入职），结束实习将一并作废，确定？', {
          reason: 'CONFIRMATION_REQUIRED',
          warnings: [{ businessId: applicationId, effectiveDate: '2026-11-20', reason: 'X', state: 'approved' }],
          hiddenCount: 0,
        }),
      );
    server.employeeRevision = employeeRevision + 1;
    return route.fulfill({ status: 201, json: business('leave', { status: 'approved' }) });
  });
  await openDetail(page, 'interning');
  await page.getByRole('button', { name: '结束实习', exact: true }).click();
  await expect(dialog(page).getByRole('switch')).toHaveCount(0);
  await save(page).click();
  await expect(dialog(page).getByText('请填写实习结束日期')).toBeVisible();
  await date(page, '实习结束日期', '2026-10-31');
  await save(page).click();
  await expect(page.getByText(/结束实习将一并作废/).last()).toBeVisible();
  await expect(page.getByRole('switch', { name: '离职同步取消待入职' })).not.toBeChecked();
  await page
    .getByRole('button', { name: /确\s*定/ })
    .last()
    .click();
  await expect(page.getByText('结束实习成功')).toBeVisible();
  expect(sent.map((item) => item.body)).toEqual([
    { endDate: '2026-10-31' },
    { endDate: '2026-10-31', confirmed: true },
  ]);
  expect(sent[1]!.key).not.toBe(sent[0]!.key);
});

test('AC-FE-R2d3-05 DEC-647：实习中 / 实习转正中详情都不渲染“实习转正申请”，直接转正照常', async ({ page }) => {
  await setup(page);
  const applications: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/businesses')) applications.push(request.url());
  });
  await openDetail(page, 'interning');
  await expect(page.getByRole('button', { name: '实习转正', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '结束实习', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '实习转正申请', exact: true })).toHaveCount(0);
  await expect(page.getByRole('row').getByRole('button', { name: '实习转正申请' })).toHaveCount(0);
  await page.getByRole('dialog', { name: '员工档案' }).getByRole('button', { name: '关闭' }).click();
  await openDetail(page, 'converting');
  await expect(page.getByRole('button', { name: '实习转正', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '实习转正申请', exact: true })).toHaveCount(0);
  expect(applications).toEqual([]);
});

test('AC-FE-R2d3-06 实习转正中：撤回审批中的申请，入口不含实习转正申请', async ({ page }) => {
  const { server } = await setup(page);
  const withdrawn: ReturnType<typeof posted>[] = [];
  await page.route(`**/employment/businesses/${applicationId}/withdraw`, (route) => {
    withdrawn.push(posted(route.request()));
    server.businessRevision = 4;
    return route.fulfill({
      json: business('intern_regularization', { id: applicationId, status: 'draft', revision: 4 }),
    });
  });
  await openDetail(page, 'converting');
  await expect(page.getByRole('button', { name: '实习转正申请', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /撤\s*销/ })).toBeVisible();
  await page.getByRole('button', { name: /撤\s*回/ }).click();
  await page
    .getByRole('tooltip')
    .getByRole('button', { name: /确\s*定/ })
    .click();
  await expect(page.getByText('已撤回')).toBeVisible();
  expect(withdrawn).toEqual([{ body: {}, ifMatch: String(rows.converting.revision), key: expect.any(String) }]);
});

test('AC-FE-R2d3-07 结果未知只读锁定：关闭重开、换入口仍锁定，不换命令 ID 重提', async ({ page }) => {
  await setup(page);
  let attempts = 0;
  await page.route(`**/employment/interns/${employee}/regularize`, (route) => {
    attempts += 1;
    return route.abort('connectionreset');
  });
  await openDetail(page, 'interning');
  await page.getByRole('button', { name: '实习转正', exact: true }).click();
  await date(page, '实习转正日期', '2026-10-16');
  await dialog(page).getByRole('radio', { name: '否' }).check();
  await save(page).click();
  await expect(dialog(page).getByText(/结果待确认/)).toBeVisible();
  await expect(save(page)).toBeDisabled();
  await dialog(page)
    .getByRole('button', { name: /取\s*消/ })
    .click();
  await page.getByRole('button', { name: '实习转正', exact: true }).click();
  await expect(dialog(page).getByText(/结果待确认/)).toBeVisible();
  await expect(save(page)).toBeDisabled();
  await dialog(page)
    .getByRole('button', { name: /取\s*消/ })
    .click();
  await page.getByRole('button', { name: '结束实习', exact: true }).click();
  await expect(dialog(page).getByText('本对象有未确认的其他操作，确认结果前不能发起新操作。')).toBeVisible();
  await expect(save(page)).toBeDisabled();
  expect(attempts).toBe(1);
});

test('AC-FE-R2d3-08 409 版本冲突：重读员工最新 revision、保留输入，核对后按新版本重提', async ({ page }) => {
  const { server } = await setup(page);
  const sent: ReturnType<typeof posted>[] = [];
  await page.route(`**/employment/interns/${employee}/terminate`, (route) => {
    sent.push(posted(route.request()));
    if (sent.length === 1)
      return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT', message: '版本冲突' } } });
    server.employeeRevision = employeeRevision + 2;
    return route.fulfill({ status: 201, json: business('leave', { employeeRevision: employeeRevision + 2 }) });
  });
  await openDetail(page, 'interning');
  await page.getByRole('button', { name: '结束实习', exact: true }).click();
  await date(page, '实习结束日期', '2026-10-31');
  server.employeeRevision = employeeRevision + 1;
  await save(page).click();
  await expect(
    dialog(page)
      .getByText(/版本冲突/)
      .first(),
  ).toBeVisible();
  await dialog(page).getByRole('button', { name: '重读最新版本' }).click();
  await dialog(page).getByRole('button', { name: '已核对差异，继续编辑' }).click();
  await expect(dialog(page).locator('input[value="2026-10-31"]')).toBeVisible();
  await save(page).click();
  await expect(page.getByText('结束实习成功')).toBeVisible();
  expect(sent.map((item) => item.ifMatch)).toEqual([String(employeeRevision), String(employeeRevision + 1)]);
  expect(sent[1]!.body).toEqual({ endDate: '2026-10-31' });
});

test('AC-FE-R2d3-09 409 重读回填任职字段：默认部门未改、服务端部门已变，重提发最新部门（第 1 轮 P2-1）', async ({
  page,
}) => {
  const { server } = await setup(page);
  const sent: ReturnType<typeof posted>[] = [];
  await page.route(`**/employment/interns/${employee}/regularize`, (route) => {
    sent.push(posted(route.request()));
    if (sent.length === 1)
      return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT', message: '版本冲突' } } });
    server.employeeRevision = employeeRevision + 2;
    return route.fulfill({
      status: 201,
      json: business('intern_regularization', { employeeRevision: employeeRevision + 2 }),
    });
  });
  await openDetail(page, 'interning');
  await page.getByRole('button', { name: '实习转正', exact: true }).click();
  await expect(dialog(page).getByText('合成实习部门').first()).toBeVisible();
  await date(page, '实习转正日期', '2026-10-16');
  await dialog(page).getByRole('radio', { name: '否' }).check();
  // 另一位 HR 已把当前主职部门改成“合成转正部门”，员工 revision + 1
  server.record = { ...server.record, departmentId: target };
  server.employeeRevision = employeeRevision + 1;
  await save(page).click();
  await dialog(page).getByRole('button', { name: '重读最新版本' }).click();
  await expect(dialog(page).getByRole('cell', { name: '部门', exact: true })).toBeVisible();
  await dialog(page).getByRole('button', { name: '已核对差异，继续编辑' }).click();
  await save(page).click();
  await expect(page.getByText('实习转正成功')).toBeVisible();
  expect(sent[0]!.body).toMatchObject({ departmentId: department, effectiveDate: '2026-10-16', probation: false });
  expect(sent[1]!.body).toEqual({ effectiveDate: '2026-10-16', departmentId: target, probation: false });
  expect(sent.map((item) => item.ifMatch)).toEqual([String(employeeRevision), String(employeeRevision + 1)]);
});

test('AC-FE-R2d3-10 写后列表读取失败：结果待确认、关闭重开与换入口仍锁定（第 1 轮 P2-2）', async ({ page }) => {
  const { server } = await setup(page);
  let attempts = 0;
  await page.route(`**/employment/interns/${employee}/terminate`, (route) => {
    attempts += 1;
    [server.employeeRevision, server.listStatus] = [employeeRevision + 1, 503];
    return route.fulfill({ status: 201, json: business('leave') });
  });
  await openDetail(page, 'interning');
  await page.getByRole('button', { name: '结束实习', exact: true }).click();
  await date(page, '实习结束日期', '2026-10-31');
  await save(page).dblclick();
  await expect(dialog(page).getByText(/结果待确认/)).toBeVisible();
  await expect(page.getByText('结束实习成功')).toHaveCount(0);
  await expect(save(page)).toBeDisabled();
  await dialog(page)
    .getByRole('button', { name: /取\s*消/ })
    .click();
  await page.getByRole('button', { name: '结束实习', exact: true }).click();
  await expect(dialog(page).getByText(/结果待确认/)).toBeVisible();
  await expect(save(page)).toBeDisabled();
  await dialog(page)
    .getByRole('button', { name: /取\s*消/ })
    .click();
  await page.getByRole('button', { name: '实习转正', exact: true }).click();
  await expect(dialog(page).getByText('本对象有未确认的其他操作，确认结果前不能发起新操作。')).toBeVisible();
  await expect(save(page)).toBeDisabled();
  expect(attempts).toBe(1);
});

test('AC-FE-R2d3-11 写后回读 revision 未前进：直接转正按结果未知锁定，不提示成功（第 1 轮 P2-2）', async ({ page }) => {
  await setup(page);
  await page.route(`**/employment/interns/${employee}/regularize`, (route) =>
    route.fulfill({ status: 201, json: business('intern_regularization') }),
  );
  await openDetail(page, 'interning');
  await page.getByRole('button', { name: '实习转正', exact: true }).click();
  await date(page, '实习转正日期', '2026-10-16');
  await dialog(page).getByRole('radio', { name: '否' }).check();
  await save(page).click();
  await expect(dialog(page).getByText(/结果待确认/)).toBeVisible();
  await expect(page.getByText('实习转正成功')).toHaveCount(0);
  await expect(save(page)).toBeDisabled();
});

test('AC-FE-R2d3-12 读基线时并发改任职：不拼“新 revision + 旧任职字段”（第 2 轮 P2-R2-1）', async ({ page }) => {
  const { server } = await setup(page);
  const sent: ReturnType<typeof posted>[] = [];
  await page.route(`**/employment/interns/${employee}/regularize`, (route) => {
    sent.push(posted(route.request()));
    server.employeeRevision = employeeRevision + 2;
    return route.fulfill({
      status: 201,
      json: business('intern_regularization', { employeeRevision: employeeRevision + 2 }),
    });
  });
  await openDetail(page, 'interning');
  // 交错顺序：任职先读到部门 A → 另一位 HR 改成 B、员工 revision 5 → 6 → 员工 revision 随后才应答
  let changed!: () => void;
  const answered = new Promise<void>((resolve) => (changed = resolve));
  server.afterRecords = () => {
    server.afterRecords = undefined;
    [server.record, server.employeeRevision] = [{ ...server.record, departmentId: target }, employeeRevision + 1];
    changed();
  };
  server.beforeEmployee = () => Promise.race([answered, new Promise<void>((resolve) => setTimeout(resolve, 800))]);
  await page.getByRole('button', { name: '实习转正', exact: true }).click();
  await expect(dialog(page).getByText('合成转正部门').first()).toBeVisible();
  await date(page, '实习转正日期', '2026-10-16');
  await dialog(page).getByRole('radio', { name: '否' }).check();
  await save(page).click();
  await expect(page.getByText('实习转正成功')).toBeVisible();
  expect(sent.map((item) => [item.ifMatch, item.body.departmentId])).toEqual([[String(employeeRevision + 1), target]]);
});

test('AC-FE-R2d3-13 读基线期间员工一直在变：有限次重读后报错，不渲染表单（第 2 轮 P2-R2-1）', async ({ page }) => {
  const { server } = await setup(page);
  let posts = 0;
  await page.route(`**/employment/interns/${employee}/regularize`, (route) => {
    posts += 1;
    return route.abort();
  });
  await openDetail(page, 'interning');
  let records = 0;
  server.afterRecords = () => {
    records += 1;
    server.employeeRevision += 1;
  };
  await page.getByRole('button', { name: '实习转正', exact: true }).click();
  await expect(dialog(page).getByText('此员工的任职正在被修改，未能读到一致的版本，请稍后重试。')).toBeVisible();
  await expect(save(page)).toHaveCount(0);
  // 每轮读取最多 3 次；开发模式 StrictMode 会把打开时的读取 effect 执行两次（先挂载的那次结果被丢弃）
  expect([3, 6]).toContain(records);
  expect(posts).toBe(0);
});
