import { test, expect } from './fixtures.js';
import {
  candidate,
  company,
  contractType,
  department,
  employee,
  editor,
  fillCreate,
  openCreate,
  receipt,
  saveCreate,
  sent,
  setupCreate,
  dateCreate,
  dateInput,
} from './intern-create-fixtures.js';

// B38 / A48 / IN-R1：夹具是 POST /interns 的真实回执，而非 EmploymentBusiness。
test('AC-FE-R2d4-01 无匹配新增一次保存人员任职合同，回执后刷新实习中', async ({ page }) => {
  const state = await setupCreate(page);
  await openCreate(page);
  await fillCreate(page);
  const matches: unknown[] = [];
  await page.route('**/employment/rehire-matches', (route) => {
    matches.push(route.request().postDataJSON());
    return route.fulfill({ json: { matched: false } });
  });
  await editor(page).getByLabel('证件类型', { exact: true }).fill('id_card');
  await editor(page).getByLabel('证件号码', { exact: true }).fill('SYNTHETIC-NEW');
  await editor(page)
    .getByRole('button', { name: /校\s*验/ })
    .click();
  await expect(editor(page).getByText('未匹配到离职 / 退休人员')).toBeVisible();
  await editor(page).screenshot({ path: test.info().outputPath('intern-create.png') });
  await saveCreate(page).click();
  await expect(editor(page)).toHaveCount(0);
  expect(matches).toEqual([{ idType: 'id_card', idNumber: 'SYNTHETIC-NEW' }]);
  expect(state.requests).toHaveLength(1);
  expect(state.requests[0]!.body).toEqual({
    kind: 'hire',
    profile: { idType: 'id_card', idNumber: 'SYNTHETIC-NEW' },
    name: '合成新实习生',
    code: 'IN-NEW-001',
    loginEmail: 'intern@example.com',
    effectiveDate: '2026-10-12',
    fields: { employType: 'intern', departmentId: department },
    contract: { companyId: company, typeId: contractType, endDate: '2027-10-11' },
  });
  expect(state.requests[0]!.revision).toBe('0');
  expect(state.reads.at(-1)).toBe('interning');
  await expect(page.getByText('合成实习生', { exact: true })).toBeVisible();
});

test('AC-FE-R2d4-02 命中离职人员默认否，选重聘以候选员工 revision 提交', async ({ page }) => {
  const state = await setupCreate(page);
  await page.route('**/employment/rehire-matches', (route) => route.fulfill({ json: { matched: true, candidate } }));
  await page.route('**/employment/interns', (route) => {
    state.requests.push(sent(route.request()));
    return route.fulfill({ status: 201, json: receipt({ kind: 'rehire' }) });
  });
  await openCreate(page);
  await fillCreate(page);
  await editor(page).getByLabel('证件类型', { exact: true }).fill('id_card');
  await editor(page).getByLabel('证件号码', { exact: true }).fill('SYNTHETIC-OLD');
  await editor(page)
    .getByRole('button', { name: /校\s*验/ })
    .click();
  const match = page.getByRole('dialog', { name: '重聘提示', exact: true });
  await expect(match.getByText('OLD-001')).toBeVisible();
  await expect(match.getByText('2026-09-30')).toBeVisible();
  await match.getByRole('button', { name: '按重聘入职', exact: true }).click();
  await saveCreate(page).click();
  await expect(editor(page)).toHaveCount(0);
  expect(state.requests[0]!.body).toMatchObject({ kind: 'rehire', employeeId: employee });
  expect(state.requests[0]!.body).not.toHaveProperty('name');
  expect(state.requests[0]!.body).not.toHaveProperty('code');
  expect(state.requests[0]!.revision).toBe('5');
});

test('AC-FE-R2d4-03 合同终止日为空时阻止提交', async ({ page }) => {
  const state = await setupCreate(page);
  await openCreate(page);
  await fillCreate(page, false, false);
  await saveCreate(page).click();
  await expect(editor(page).getByText('请填写合同协议终止日期')).toBeVisible();
  expect(state.requests).toHaveLength(0);
});

test('AC-FE-R2d4-04 未来合同仅终止日公司，按服务端 pendingEntry 回执去待入职', async ({ page }) => {
  const state = await setupCreate(page);
  await page.route('**/employment/interns', (route) => {
    state.requests.push(sent(route.request()));
    return route.fulfill({
      status: 201,
      json: receipt({
        view: 'pendingEntry',
        contract: {
          stage: 'pending',
          id: null,
          startDate: '2026-11-01',
          endDate: '2027-10-11',
          companyId: company,
        },
      }),
    });
  });
  await openCreate(page);
  await fillCreate(page, true);
  await saveCreate(page).click();
  await expect(page).toHaveURL(/\/entries/);
  expect(state.requests[0]!.body.contract).toEqual({ companyId: company, endDate: '2027-10-11' });
});

test('AC-FE-R2d4-05 断网关闭重开仍只读，不能换证件或换视图绕过原命令', async ({ page }) => {
  const state = await setupCreate(page);
  await page.route('**/employment/interns', (route) => {
    state.requests.push(sent(route.request()));
    return route.abort();
  });
  await openCreate(page);
  await fillCreate(page);
  await saveCreate(page).click();
  await expect(saveCreate(page)).toBeDisabled();
  await editor(page)
    .getByRole('button', { name: /取\s*消$/ })
    .click();
  await page.getByRole('button', { name: '已离职', exact: true }).click();
  await openCreate(page);
  await expect(saveCreate(page)).toBeDisabled();
  await expect(editor(page).getByLabel('证件号码', { exact: true })).toBeDisabled();
  expect(state.requests).toHaveLength(1);
});

test('AC-FE-R2d4-06 无 Employee.Create 不显示入口', async ({ page }) => {
  await setupCreate(page, { noCreate: true });
  await expect(page.getByRole('heading', { name: '实习生', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '新增实习生', exact: true })).toHaveCount(0);
});

test('AC-FE-R2d4-07 重聘409先重读候选版本，确认后保留输入用新revision重提', async ({ page }) => {
  const state = await setupCreate(page);
  await page.route('**/employment/rehire-matches', (route) => route.fulfill({ json: { matched: true, candidate } }));
  await page.route('**/employment/interns', (route) => {
    state.requests.push(sent(route.request()));
    if (state.requests.length === 1) {
      state.revision = 6;
      return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT', message: '版本冲突' } } });
    }
    return route.fulfill({ status: 201, json: receipt({ kind: 'rehire' }) });
  });
  await openCreate(page);
  await fillCreate(page);
  await editor(page).getByLabel('证件类型', { exact: true }).fill('id_card');
  await editor(page).getByLabel('证件号码', { exact: true }).fill('SYN-RELOAD');
  await editor(page)
    .getByRole('button', { name: /校\s*验/ })
    .click();
  await page
    .getByRole('dialog', { name: '重聘提示', exact: true })
    .getByRole('button', { name: '按重聘入职', exact: true })
    .click();
  await saveCreate(page).click();
  await editor(page).getByRole('button', { name: '重读最新版本', exact: true }).click();
  await editor(page).getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
  await expect(dateInput(page, '合同协议终止日期')).toHaveValue('2027-10-11');
  await saveCreate(page).click();
  await expect(editor(page)).toHaveCount(0);
  expect(state.requests.map((request) => request.revision)).toEqual(['5', '6']);
});

test('AC-FE-R2d4-08 退休或结束类型裁剪不开放按重聘入职，缺省字段显示占位', async ({ page }) => {
  await setupCreate(page);
  await page.route('**/employment/rehire-matches', (route) =>
    route.fulfill({
      json: {
        matched: true,
        candidate: { employeeId: employee, endKind: 'retirement', rehire: false },
      },
    }),
  );
  await openCreate(page);
  await editor(page).getByLabel('证件类型', { exact: true }).fill('id_card');
  await editor(page).getByLabel('证件号码', { exact: true }).fill('SYN-RETIRE');
  await editor(page)
    .getByRole('button', { name: /校\s*验/ })
    .click();
  const match = page.getByRole('dialog', { name: '重聘提示', exact: true });
  await expect(match.getByRole('button', { name: '按重聘入职' })).toBeDisabled();
  await expect(match.getByText('请通过入职管理的“离职 / 退休再入职”办理。')).toBeVisible();
  await expect(match.getByText('--', { exact: true }).first()).toBeVisible();
});

test('AC-FE-R2d4-09 确定拒绝保留输入允许修正，错误回执则锁定', async ({ page }) => {
  const state = await setupCreate(page);
  await page.route('**/employment/interns', (route) => {
    state.requests.push(sent(route.request()));
    if (state.requests.length === 1)
      return route.fulfill({ status: 400, json: { error: { code: 'VALIDATION_FAILED', message: '工号已存在' } } });
    return route.fulfill({ status: 201, json: { id: employee } });
  });
  await openCreate(page);
  await fillCreate(page);
  await saveCreate(page).click();
  await expect(editor(page).getByText('工号已存在')).toBeVisible();
  await expect(editor(page).getByLabel('姓名', { exact: true })).toHaveValue('合成新实习生');
  await editor(page).getByLabel('工号', { exact: true }).fill('IN-NEW-002');
  await saveCreate(page).click();
  await expect(saveCreate(page)).toBeDisabled();
  expect(state.requests).toHaveLength(2);
});

test('AC-FE-R2d4-10 合同终止日必须晚于开始日；切换未来日期不发送旧正式合同字段', async ({ page }) => {
  const state = await setupCreate(page);
  await openCreate(page);
  await fillCreate(page);
  await dateCreate(page, '合同协议终止日期', '2026-10-12');
  await saveCreate(page).click();
  await expect(editor(page).getByText('合同终止日期必须晚于实习开始日期')).toBeVisible();
  expect(state.requests).toHaveLength(0);
});

test('AC-FE-R2d4-11 写成功后重读403仍未知锁定，按原命令查询不重发', async ({ page }) => {
  const state = await setupCreate(page);
  await page.route('**/employment/businesses/*', (route) =>
    route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN', message: '当前不可读取' } } }),
  );
  await openCreate(page);
  await fillCreate(page);
  await saveCreate(page).click();
  await expect(editor(page).getByRole('button', { name: '查询本次命令结果' })).toBeVisible();
  await expect(saveCreate(page)).toBeDisabled();
  const queries: string[] = [];
  await page.route('**/commands/*/result', (route) => {
    queries.push(route.request().url());
    return route.fulfill({
      json: {
        commandId: state.requests[0]!.id,
        status: 'failed',
        commandType: 'POST /api/tenant/employment/interns',
        businessId: null,
        businessType: null,
        revision: null,
        httpStatus: 400,
        completedAt: '2026-10-12T12:00:00Z',
      },
    });
  });
  await editor(page).getByRole('button', { name: '查询本次命令结果' }).click();
  await expect(editor(page).getByText('命令已被拒绝，请核对原因；当前未确认表单继续保持只读。')).toBeVisible();
  expect(queries[0]).toContain(state.requests[0]!.id);
  expect(state.requests).toHaveLength(1);
});

test('AC-FE-R2d4-12 选择否仍以新增提交，原证件校验结果不能跨证件沿用', async ({ page }) => {
  const state = await setupCreate(page);
  await page.route('**/employment/rehire-matches', (route) => route.fulfill({ json: { matched: true, candidate } }));
  await openCreate(page);
  await fillCreate(page);
  await editor(page).getByLabel('证件号码', { exact: true }).fill('SYNTHETIC-OLD');
  await editor(page)
    .getByRole('button', { name: /校\s*验/ })
    .click();
  await page
    .getByRole('dialog', { name: '重聘提示', exact: true })
    .getByRole('button', { name: '否，保持新增' })
    .click();
  await editor(page).getByLabel('证件号码', { exact: true }).fill('SYNTHETIC-CHANGED');
  await saveCreate(page).click();
  await expect(editor(page).getByText('请先填写完整证件信息并完成校验')).toBeVisible();
  expect(state.requests).toHaveLength(0);
  await editor(page)
    .getByRole('button', { name: /校\s*验/ })
    .click();
  await page
    .getByRole('dialog', { name: '重聘提示', exact: true })
    .getByRole('button', { name: '否，保持新增' })
    .click();
  await saveCreate(page).click();
  await expect(editor(page)).toHaveCount(0);
  expect(state.requests[0]!.body.kind).toBe('hire');
  expect(state.requests[0]!.body).not.toHaveProperty('employeeId');
});

test('AC-FE-R2d4-13 候选重读失败保留冲突锁，禁止直接重提', async ({ page }) => {
  const state = await setupCreate(page);
  let missing = false;
  await page.route('**/employment/rehire-matches', (route) =>
    route.fulfill({ json: missing ? { matched: false } : { matched: true, candidate } }),
  );
  await page.route('**/employment/interns', (route) => {
    state.requests.push(sent(route.request()));
    missing = true;
    return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT', message: '版本冲突' } } });
  });
  await openCreate(page);
  await fillCreate(page);
  await editor(page).getByLabel('证件号码', { exact: true }).fill('SYNTHETIC-OLD');
  await editor(page)
    .getByRole('button', { name: /校\s*验/ })
    .click();
  await page.getByRole('dialog', { name: '重聘提示', exact: true }).getByRole('button', { name: '按重聘入职' }).click();
  await saveCreate(page).click();
  await editor(page).getByRole('button', { name: '重读最新版本', exact: true }).click();
  await expect(editor(page).getByText('读取失败，输入已保留，请重新读取。')).toBeVisible();
  await expect(saveCreate(page)).toBeDisabled();
  expect(state.requests).toHaveLength(1);
});

test('AC-FE-R2d4-14 较早证件匹配晚返回时不能覆盖新输入', async ({ page }) => {
  await setupCreate(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route('**/employment/rehire-matches', async (route) => {
    requested = true;
    await held;
    await route.fulfill({ json: { matched: true, candidate } });
  });
  await openCreate(page);
  await fillCreate(page);
  await editor(page).getByLabel('证件号码', { exact: true }).fill('SYNTHETIC-FIRST');
  await editor(page)
    .getByRole('button', { name: /校\s*验/ })
    .click();
  await expect.poll(() => requested).toBe(true);
  await editor(page).getByLabel('证件号码', { exact: true }).fill('SYNTHETIC-SECOND');
  release();
  await saveCreate(page).click();
  await expect(editor(page).getByText('请先填写完整证件信息并完成校验')).toBeVisible();
  await expect(page.getByRole('dialog', { name: '重聘提示', exact: true })).toHaveCount(0);
});

test('AC-FE-R2d4-15 裁剪结束类型保守禁止重聘，必填合同字段无编辑权不能发送', async ({ page }) => {
  const state = await setupCreate(page, { hidden: ['endDate'] });
  await page.route('**/employment/rehire-matches', (route) =>
    route.fulfill({ json: { matched: true, candidate: { employeeId: employee } } }),
  );
  await openCreate(page);
  await editor(page).getByLabel('姓名', { exact: true }).fill('合成实习生');
  await editor(page).getByLabel('电子邮件', { exact: true }).fill('intern@example.com');
  await editor(page).getByLabel('工号', { exact: true }).fill('SYN-CUT');
  await editor(page).getByLabel('证件号码', { exact: true }).fill('SYNTHETIC-CUT');
  await editor(page)
    .getByRole('button', { name: /校\s*验/ })
    .click();
  const match = page.getByRole('dialog', { name: '重聘提示', exact: true });
  await expect(match.getByRole('button', { name: '按重聘入职' })).toBeDisabled();
  await match.getByRole('button', { name: '否，保持新增' }).click();
  await expect(dateInput(page, '合同协议终止日期')).toHaveCount(0);
  await saveCreate(page).click();
  expect(state.requests).toHaveLength(0);
});
