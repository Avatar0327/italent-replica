// F-147：恢复槽键统一为“资源 + 对象 id”。同一对象上任一动作结果未知时，其他动作一并锁定；
// 合同按槽里记下的 op / mode 重开表单；审批动作的上下文存进内核槽，冲突重读后不丢（接口全部为合成桩）。
import type { Locator, Page } from '@playwright/test';
import { test, expect, user } from './fixtures.js';
import {
  capture,
  choose as chooseOption,
  instance,
  item,
  named,
  pickDate,
  requestId,
  save,
  setupContracts,
  task,
  type Write,
} from './contracts-fixtures.js';
import { button, cancel, mockSuccession, openMenu as openSuccession, positionRecord } from './r3d1-fixtures.js';
import { mockIdp } from './r3d2-fixtures.js';

const failed = { status: 500, json: { error: { code: 'INTERNAL' } } };
const blocked = '本对象有未确认的其他操作，确认结果前不能发起新操作。';
const unknown = '处理中 / 结果待确认';

async function writesTo(page: Page, pattern: string, respond: () => object = () => failed) {
  const writes: Write[] = [];
  await page.route(pattern, (route) => {
    if (route.request().method() === 'GET') return route.fallback();
    capture(writes, route.request());
    const { status = 200, json } = respond() as { status?: number; json: unknown };
    return route.fulfill({ status, json });
  });
  return writes;
}
const closeDialog = (page: Page) => page.getByRole('button', { name: /取\s*消/ }).last().click();

test.describe('合同', () => {
  test('AC-FE-F147-01 续签结果未知后点“终止”：按槽里的续签重开并锁定，不打开终止表单', async ({ page }) => {
    await setupContracts(page);
    const writes = await writesTo(page, '**/api/tenant/contracts/commands');
    await page.getByRole('button', { name: '查看合同', exact: true }).first().click();
    const heading = page.locator('.contract-heading');
    await heading.getByRole('button', named('续签')).click();
    const renew = page.getByRole('dialog', { name: '续签合同', exact: true });
    await item(renew, '合同期限（月）').getByRole('spinbutton').fill('24');
    await expect(item(renew, '终止日期').getByRole('textbox')).not.toHaveValue('');
    await renew.getByRole('button', save).click();
    await expect(renew).toContainText(unknown);
    await closeDialog(page);
    await expect(renew).toHaveCount(0);
    await heading.getByRole('button', named('终止')).click();
    await expect(renew).toBeVisible();
    await expect(renew).toContainText(unknown);
    await expect(renew.getByRole('button', save)).toBeDisabled();
    await expect(page.getByRole('dialog', { name: '终止合同', exact: true })).toHaveCount(0);
    expect(writes).toHaveLength(1);
  });

  test('AC-FE-F147-02 行内新签结果未知后点顶部“新签”：仍是原命令，锁定且不发第二次', async ({ page }) => {
    await setupContracts(page);
    const writes = await writesTo(page, '**/api/tenant/contracts/commands');
    await page.getByRole('button', { name: '入职缺失', exact: true }).click();
    await page.locator('.ant-table').getByRole('button', named('新签')).click();
    const form = page.getByRole('dialog', { name: '新签合同', exact: true });
    await chooseOption(form, '公司', '合成公司');
    await chooseOption(form, '合同类型', '合成合同类型');
    await pickDate(form, '生效日期', '2026-11-01');
    await item(form, '合同期限（月）').getByRole('spinbutton').fill('12');
    await expect(item(form, '终止日期').getByRole('textbox')).not.toHaveValue('');
    await form.getByRole('button', save).click();
    await expect(form).toContainText(unknown);
    await closeDialog(page);
    await page.locator('.contract-heading').getByRole('button', named('新签')).click();
    await expect(form).toContainText(unknown);
    await expect(form.getByRole('button', save)).toBeDisabled();
    expect(writes).toHaveLength(1);
  });

  test('AC-FE-F147-03 规则删除结果未知：同一规则的编辑一并锁定', async ({ page }) => {
    await setupContracts(page);
    const writes = await writesTo(page, '**/api/tenant/contracts/rules/rule');
    await page.getByRole('link', { name: '自动续签规则', exact: true }).click();
    const table = page.locator('.ant-table');
    await table.getByRole('button', named('删除')).click();
    await page.getByRole('tooltip').getByRole('button', named('确定')).click();
    await expect.poll(() => writes.length).toBe(1);
    await expect(table.getByRole('button', named('删除'))).toBeDisabled();
    await table.getByRole('button', named('编辑')).click();
    const dialog = page.getByRole('dialog', { name: '编辑自动续签规则', exact: true });
    await expect(dialog).toContainText(blocked);
    await expect(dialog.getByRole('button', save)).toBeDisabled();
    expect(writes).toHaveLength(1);
  });

  test('AC-FE-F147-04 自动续签开关结果未知：合同设置编辑一并锁定', async ({ page }) => {
    await setupContracts(page);
    const writes = await writesTo(page, '**/api/tenant/contracts/settings');
    await page.getByRole('link', { name: '自动续签规则', exact: true }).click();
    await page.getByRole('switch', { name: '合同到期自动续签', exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    await page.getByRole('link', { name: '合同管理设置', exact: true }).click();
    await page.getByRole('button', named('编辑')).click();
    const dialog = page.getByRole('dialog', { name: '编辑合同管理设置', exact: true });
    await expect(dialog).toContainText(blocked);
    await expect(dialog.getByRole('button', save)).toBeDisabled();
    expect(writes).toHaveLength(1);
  });
});

/** 审批中合同行 + 流程详情：动作回执与之后的 GET 都是同一份完整详情（同 AC-FE-R2a-16 夹具）。 */
async function approvals(page: Page, fail: { urge?: object; transfer?: object }) {
  const writes: Write[] = [];
  const current = { revision: 4 };
  const detail = () => ({
    id: instance,
    title: '合成合同变更申请',
    revision: current.revision,
    status: 'running',
    approvalType: 'contract',
    actions: ['urge', 'transfer', 'withdraw'],
    recordsHidden: false,
    form: { values: {} },
    tasks: [{ id: task, nodeName: '合成审批节点', assigneeUserId: user, status: 'pending' }],
    logs: [],
  });
  await page.route('**/api/tenant/approval/**', (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET') {
      capture(writes, route.request());
      const action = url.pathname.split('/').at(-1) as 'urge' | 'transfer';
      // 冲突时别人已改过本单，重读拿到下一版本。
      if (fail[action] && (fail[action] as { status?: number }).status === 409) current.revision += 1;
      const { status = 200, json } = (fail[action] ?? { json: detail() }) as { status?: number; json: unknown };
      return route.fulfill({ status, json });
    }
    if (url.pathname.endsWith('/instances')) {
      const items = url.searchParams.get('businessId') === requestId ? [{ ...detail(), tasks: undefined }] : [];
      return route.fulfill({ json: { items } });
    }
    return route.fulfill({ json: detail() });
  });
  await setupContracts(page);
  await page.getByRole('button', { name: '审批中合同协议', exact: true }).click();
  return writes;
}
const row = (page: Page, label: string) => page.locator('.ant-table').getByRole('button', { name: label, exact: true });
const detailDialog = (page: Page) => page.getByRole('dialog', { name: '合成合同变更申请' });
const detailButton = (scope: Locator, label: string) =>
  scope.getByRole('button', { name: new RegExp(`^${[...label].join('\\s*')}$`) });

test.describe('审批', () => {
  test('AC-FE-F147-05 行内催办结果未知：打开详情，转交与撤销一并锁定并提示未确认的催办', async ({ page }) => {
    const writes = await approvals(page, { urge: failed });
    await row(page, '催办').click();
    await expect(row(page, '催办')).toBeDisabled();
    await row(page, '转交').click();
    const detail = detailDialog(page);
    await expect(detail).toContainText('本单有未确认的“催办”操作');
    await expect(detailButton(detail, '转交')).toBeDisabled();
    await expect(detailButton(detail, '撤销')).toBeDisabled();
    expect(writes).toHaveLength(1);
  });

  test('AC-FE-F147-06 详情里转交结果未知：关闭后行内催办一并锁定', async ({ page }) => {
    const writes = await approvals(page, { transfer: failed });
    await row(page, '转交').click();
    const detail = detailDialog(page);
    await detailButton(detail, '转交').click();
    await page.getByLabel('转交给（账号编号）').fill(user);
    await page.getByRole('button', save).click();
    await expect(page.getByRole('dialog', { name: '转交', exact: true })).toContainText(unknown);
    await closeDialog(page);
    await detail.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(detail).toHaveCount(0);
    await expect(row(page, '催办')).toBeDisabled();
    expect(writes).toHaveLength(1);
  });

  test('AC-FE-F147-07 转交冲突重读后关闭：槽里仍记着转交，其他动作保持禁用、提示不消失', async ({ page }) => {
    const writes = await approvals(page, { transfer: { status: 409, json: { error: { code: 'REVISION_CONFLICT' } } } });
    await row(page, '转交').click();
    const detail = detailDialog(page);
    await detailButton(detail, '转交').click();
    const form = page.getByRole('dialog', { name: '转交', exact: true });
    await page.getByLabel('转交给（账号编号）').fill(user);
    await page.getByRole('button', save).click();
    await form.getByRole('button', { name: '重读最新版本', exact: true }).click();
    await expect(form.getByRole('button', { name: '已核对差异，继续编辑', exact: true })).toBeVisible();
    await closeDialog(page);
    await expect(form).toHaveCount(0);
    await expect(detail).toContainText('本单有未确认的“转交”操作');
    await expect(detailButton(detail, '撤销')).toBeDisabled();
    await expect(detailButton(detail, '转交')).toBeEnabled();
    expect(writes).toHaveLength(1);
  });
});

test.describe('继任', () => {
  test.use({ viewport: { width: 1440, height: 1000 } });
  test('AC-FE-F147-08 批量结束结果未知：重选同一记录后编辑与删除一并锁定', async ({ page }) => {
    await mockSuccession(page);
    const posts: string[] = [];
    await page.route('**/succession/records/end', (route) => {
      posts.push(route.request().headers()['idempotency-key'] ?? '');
      return route.abort('failed');
    });
    await openSuccession(page, '继任地图与列表');
    await expect(page.locator('.list-card')).toContainText(positionRecord.position?.name ?? '合成研发总监');
    const selectRow = () => page.getByRole('checkbox').last().check();
    await selectRow();
    await button(page, '更多操作').click();
    await page.getByRole('menuitem', { name: '结束继任', exact: true }).click();
    const end = page.getByRole('dialog', { name: '结束继任', exact: true });
    await end.getByRole('button', { name: /保\s*存$/ }).click();
    await expect(end).toContainText(unknown);
    await cancel(page);
    await expect(end).toBeHidden();
    await selectRow();
    await expect(button(page, '删除')).toBeDisabled();
    await button(page, '编辑').click();
    const edit = page.getByRole('dialog', { name: '编辑继任', exact: true });
    await expect(edit).toContainText(blocked);
    await expect(edit.getByRole('button', { name: /保\s*存$/ })).toBeDisabled();
    expect(posts).toHaveLength(1);
  });
});

test.describe('发展计划', () => {
  test.use({ viewport: { width: 1440, height: 1000 } });
  async function openIdp(page: Page, name: string) {
    await page.goto('/idp');
    await page.getByLabel('切换演示身份').selectOption(user);
    await expect(page).toHaveURL(/\/staff$/);
    await page.getByRole('button', { name: '应用导航' }).click();
    await page.getByRole('dialog', { name: '全部菜单' }).getByRole('link', { name: '人才发展计划', exact: true }).click();
    await expect(page).toHaveURL(/\/idp\/plans$/);
    await page.getByRole('menuitem', { name: '人才发展计划', exact: true }).click();
    await page.getByRole('menuitem', { name, exact: true }).click();
  }
  const ok = (dialog: Locator) => dialog.getByRole('button', { name: /确\s*定/ });

  test('AC-FE-F147-09 批量催办结果未知：同一计划的终止一并锁定，不发第二次', async ({ page }) => {
    const calls = await mockIdp(page, { writeStatus: 500 });
    await openIdp(page, '发展计划');
    await page.getByRole('row', { name: /合成发展计划/ }).getByRole('checkbox').check();
    const intervene = async (label: string) => {
      await page.getByRole('button', { name: /流程干预/ }).click();
      await page.getByRole('menuitem', { name: label, exact: true }).click();
    };
    await intervene('催办');
    const urge = page.getByRole('dialog', { name: '催办', exact: true });
    await ok(urge).click();
    await expect(urge.getByText('命令 ID')).toBeVisible();
    await urge.getByRole('button', { name: /取\s*消/ }).click();
    await expect(urge).toBeHidden();
    await intervene('终止计划');
    const terminate = page.getByRole('dialog', { name: '终止计划', exact: true });
    await expect(terminate).toContainText(blocked);
    await expect(ok(terminate)).toBeDisabled();
    expect(calls.filter((call) => call.method !== 'GET')).toHaveLength(1);
  });

  test('AC-FE-F147-10 模板复制结果未知：同一模板的停用一并锁定', async ({ page }) => {
    const calls = await mockIdp(page, { writeStatus: 500 });
    await openIdp(page, '发展计划模板');
    const line = page.getByRole('row', { name: /合成发展计划模板/ });
    await line.getByRole('button', { name: /复\s*制/ }).click();
    const copy = page.getByRole('dialog', { name: '复制发展计划模板' });
    await ok(copy).click();
    await expect(copy.getByText('命令 ID')).toBeVisible();
    await copy.getByRole('button', { name: /取\s*消/ }).click();
    await expect(copy).toBeHidden();
    await line.getByRole('button', { name: /停\s*用/ }).click();
    const disable = page.getByRole('dialog', { name: '停用', exact: true });
    await expect(disable).toContainText(blocked);
    await expect(ok(disable)).toBeDisabled();
    expect(calls).toHaveLength(1);
  });

  test('AC-FE-F147-11 流程删除结果未知：同一流程的编辑一并锁定', async ({ page }) => {
    const calls = await mockIdp(page, { writeStatus: 500 });
    await openIdp(page, '发展计划流程');
    const line = page.getByRole('row', { name: /合成发展计划流程/ });
    await line.getByRole('button', { name: /删\s*除/ }).click();
    const remove = page.getByRole('dialog', { name: '删除', exact: true });
    await ok(remove).click();
    await expect(remove.getByText('命令 ID')).toBeVisible();
    await remove.getByRole('button', { name: /取\s*消/ }).click();
    await expect(remove).toBeHidden();
    await line.getByRole('button', { name: /编\s*辑/ }).click();
    const form = page.getByRole('dialog', { name: '编辑发展计划流程' });
    await expect(form).toContainText(blocked);
    await expect(form.getByRole('button', { name: /保\s*存/ })).toBeDisabled();
    expect(calls).toHaveLength(1);
  });
});
