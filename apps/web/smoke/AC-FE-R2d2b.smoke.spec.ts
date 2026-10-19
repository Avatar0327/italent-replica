import { test, expect } from './fixtures.js';
import { requestSetup } from './part-time-request-fixtures.js';
const named = (name: string) => ({ name: new RegExp(`^${name.split('').join('\\s*')}$`) });
async function dateForm(page: import('@playwright/test').Page, kind = '延长') {
  await page
    .getByRole('button', named(`${kind}兼职申请`))
    .first()
    .click();
  return page.getByRole('dialog', named(`${kind}兼职申请`));
}
test('AC-FE-R2d2b-01 延长缩短：取消不发，确定提交，warnings 不重复确认', async ({ page }) => {
  const state = await requestSetup(page);
  const form = await dateForm(page);
  await form.getByLabel('新结束日期', { exact: true }).fill('2026-10-25');
  await form.getByRole('button', named('提交')).click();
  const confirm = page.getByRole('dialog').filter({ hasText: '请确认以下信息' });
  await expect(confirm).toContainText('新结束日期（2026-10-25）早于原结束日期（2026-11-30），兼职并未延长');
  await confirm.getByRole('button', { name: /取\s*消/ }).click();
  expect(state.writes).toHaveLength(0);
  await form.getByRole('button', named('提交')).click();
  await confirm.getByRole('button', { name: /确\s*定/ }).click();
  await expect(form).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]?.body).toMatchObject({ requestType: 'extend', endDate: '2026-10-25', submit: true });
});
for (const kind of ['延长', '结束'])
  for (const submit of [false, true])
    test(`AC-FE-R2d2b-02 ${kind} ${submit ? '直接提交' : '草稿'}`, async ({ page }) => {
      const state = await requestSetup(page);
      const form = await dateForm(page, kind);
      await form
        .getByLabel(kind === '延长' ? '新结束日期' : '结束日期', { exact: true })
        .fill(kind === '延长' ? '2026-12-31' : '2026-10-25');
      await form.getByRole('button', named(submit ? '提交' : '保存草稿')).click();
      await expect(form).toHaveCount(0);
      expect(state.writes[0]?.body).toMatchObject({ requestType: kind === '延长' ? 'extend' : 'end', submit });
    });
test('AC-FE-R2d2b-03 等于原日期不确认，409 中文提示与重读恢复', async ({ page }) => {
  const state = await requestSetup(page);
  state.failure = 409;
  const form = await dateForm(page);
  await form.getByLabel('新结束日期', { exact: true }).fill('2026-11-30');
  await form.getByRole('button', named('提交')).click();
  await expect(form).toContainText('新结束日期不能与原结束日期相同');
  await expect(page.getByText('请确认以下信息', { exact: true })).toHaveCount(0);
  await expect(form.getByRole('button', named('重读最新版本'))).toBeVisible();
  expect(state.writes).toHaveLength(1);
});
test('AC-FE-R2d2b-04 非原发起人提交被拒是中文拒绝并重读，不进 unknown', async ({ page }) => {
  const state = await requestSetup(page);
  state.row.status = 'draft';
  state.failure = 403;
  await page.getByRole('button', named('审批中的兼职')).click();
  await page.getByRole('button', named('查看详情')).click();
  await page.getByRole('button', named('提交')).click();
  const form = page.getByRole('dialog', named('提交兼职申请'));
  await form.getByRole('button', named('提交')).click();
  await expect(form).toContainText('原发起人');
  await expect(form.getByText(/结果待确认/)).toHaveCount(0);
  await expect(form.getByRole('button', named('提交'))).toBeEnabled();
});
test('AC-FE-R2d2b-05 网络未知：关闭、换视图、重开仍锁定', async ({ page }) => {
  const state = await requestSetup(page);
  state.unknown = true;
  const form = await dateForm(page);
  await form.getByLabel('新结束日期', { exact: true }).fill('2026-12-31');
  await form.getByRole('button', named('保存草稿')).click();
  await expect(form).toContainText('结果待确认');
  await form.getByRole('button', named('取消')).click();
  await page.getByRole('button', named('全部兼职记录')).click();
  const reopened = await dateForm(page);
  await expect(reopened).toContainText('结果待确认');
  await expect(reopened.getByRole('button', named('提交'))).toBeDisabled();
  expect(state.writes).toHaveLength(1);
});
test('AC-FE-R2d2b-06 无按钮权不显示三类申请入口', async ({ page }) => {
  const state = await requestSetup(page);
  state.buttons = false;
  await page.reload();
  for (const name of ['新增兼职申请', '延长兼职申请', '结束兼职申请'])
    await expect(page.getByRole('button', named(name))).toHaveCount(0);
});
for (const submit of [false, true])
  test(`AC-FE-R2d2b-07 新增 ${submit ? '直接提交' : '草稿'}真实载荷`, async ({ page }) => {
    const state = await requestSetup(page);
    await page.getByRole('button', named('新增兼职申请')).click();
    const form = page.getByRole('dialog', named('新增兼职申请'));
    await form.getByRole('combobox', named('兼职人员')).click();
    await page.getByTitle('合成兼职员工', { exact: true }).click();
    await form.getByRole('combobox', named('兼职类型')).click();
    await page.locator('.ant-select-dropdown:visible').getByTitle('兼职', { exact: true }).click();
    await form.getByLabel('开始日期', { exact: true }).fill('2026-09-01');
    await form.getByRole('combobox', named('兼职部门')).click();
    await page.getByTitle('合成兼职部门', { exact: true }).click();
    await form.screenshot({ path: '../../.demo/fe-r2d2b-add.png' });
    await form.getByRole('button', named(submit ? '提交' : '保存草稿')).click();
    await expect(form).toHaveCount(0);
    expect(state.writes[0]?.body).toMatchObject({
      requestType: 'add',
      partTimeType: 'part_time',
      startDate: '2026-09-01',
      submit,
    });
    expect(state.writes[0]?.body.fields).not.toHaveProperty('isDepartmentHead');
  });
for (const approvalType of ['part_time_extend', 'transfer'])
  test(`AC-FE-R2d2b-08 审批同意前确认 ${approvalType}`, async ({ page }) => {
    await requestSetup(page);
    const id = '70000000-0000-4000-8000-000000000001';
    const task = '80000000-0000-4000-8000-000000000001';
    const detail = {
      id,
      revision: 4,
      title: '合成待办申请',
      approvalType,
      status: 'running',
      actions: ['approve'],
      recordsHidden: false,
      form: { values: { originalEndDate: '2026-11-30', endDate: '2026-10-25' } },
      tasks: [{ id: task, nodeName: '合成审批节点', status: 'pending' }],
      logs: [],
    };
    let writes = 0;
    await page.route('**/api/tenant/approval/**', (route) => {
      const req = route.request();
      if (req.method() === 'POST') {
        writes++;
        return route.fulfill({ json: { ...detail, revision: 5 } });
      }
      return route.fulfill({
        json: req.url().includes('/todos?') ? { items: [{ ...detail, instanceId: id, taskId: task }] } : detail,
      });
    });
    await page.goto('/approval/todos');
    await page.getByText('合成待办申请', { exact: true }).click();
    await page.getByRole('button', { name: /^同\s*意$/ }).click();
    const form = page.getByRole('dialog', { name: /^同\s*意$/ });
    await form.getByRole('button', { name: /^保\s*存$/ }).click();
    if (approvalType === 'part_time_extend') {
      const confirm = page.getByRole('dialog').filter({ hasText: '请确认以下信息' });
      await expect(confirm).toBeVisible();
      await confirm.getByRole('button', { name: /取\s*消/ }).click();
      expect(writes).toBe(0);
      await expect(form).toBeVisible();
      await form.getByRole('button', { name: /^保\s*存$/ }).click();
      await confirm.getByRole('button', { name: /确\s*定/ }).click();
    }
    await expect(form).toHaveCount(0);
    expect(writes).toBe(1);
  });
test('AC-FE-R2d2b-09 草稿修改、提交、撤回、删除使用真实 revision', async ({ page }) => {
  const state = await requestSetup(page);
  state.row.status = 'draft';
  await page.getByRole('button', named('审批中的兼职')).click();
  await page.getByRole('button', named('查看详情')).click();
  const detail = page.getByRole('dialog').filter({ has: page.getByRole('heading', named('兼职申请详情')) });
  await detail.getByRole('button', named('修改')).click();
  let form = page.getByRole('dialog', named('修改兼职申请'));
  await form.getByLabel('新结束日期', { exact: true }).fill('2027-01-31');
  await form.getByRole('button', named('保存')).click();
  await expect(form).toHaveCount(0);
  expect(state.writes[0]).toMatchObject({ method: 'PATCH', revision: '1', body: { endDate: '2027-01-31' } });
  for (const action of ['提交', '撤回', '删除']) {
    await detail.getByRole('button', named(action)).click();
    form = page.getByRole('dialog', named(`${action}兼职申请`));
    await form.getByRole('button', named(action)).click();
    await expect(form).toHaveCount(0);
  }
  expect(state.writes.map((write) => write.revision)).toEqual(['1', '2', '3', '4']);
  await expect(detail.getByRole('button', named('修改'))).toHaveCount(0);
});
test('AC-FE-R2d2b-10 写成功后读取失败仍 unknown，重开不换命令', async ({ page }) => {
  const state = await requestSetup(page);
  state.readFailure = true;
  const form = await dateForm(page);
  await form.getByLabel('新结束日期', { exact: true }).fill('2026-12-31');
  await form.getByRole('button', named('保存草稿')).click();
  await expect(form).toContainText('结果待确认');
  await expect(form.getByRole('button', named('保存草稿'))).toBeDisabled();
  await form.getByRole('button', named('取消')).click();
  const reopened = await dateForm(page);
  await expect(reopened).toContainText('结果待确认');
  expect(state.writes).toHaveLength(1);
});
test('AC-FE-R2d2b-11 409 重读保留改过字段，未改字段回填新值，显式确认才重提', async ({ page }) => {
  const state = await requestSetup(page);
  state.row.status = 'draft';
  state.failure = 409;
  await page.getByRole('button', named('审批中的兼职')).click();
  await page.getByRole('button', named('查看详情')).click();
  await page.getByRole('button', named('修改')).click();
  const form = page.getByRole('dialog', named('修改兼职申请'));
  await form.getByLabel('新结束日期', { exact: true }).fill('2027-01-31');
  await form.getByRole('button', named('保存')).click();
  await expect(form.getByRole('button', named('重读最新版本'))).toBeVisible();
  state.row.revision = 9;
  state.row.requestRemark = '合成服务端新备注';
  await form.getByRole('button', named('重读最新版本')).click();
  await form.getByRole('button', named('已核对差异，继续编辑')).click();
  await expect(form.getByLabel('新结束日期', { exact: true })).toHaveValue('2027-01-31');
  await expect(form.getByLabel('延长备注', { exact: true })).toHaveValue('合成服务端新备注');
  state.failure = 0;
  await form.getByRole('button', named('保存')).click();
  await expect(form).toHaveCount(0);
  expect(state.writes.at(-1)).toMatchObject({ revision: '9', body: { endDate: '2027-01-31' } });
});
