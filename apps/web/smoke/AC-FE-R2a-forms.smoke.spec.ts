// F-127b：A9～A12 合同表单、类型 / 规则 / 设置保存、审批中行内操作（接口全部为合成桩）。
import { test, expect } from './fixtures.js';
import type { Locator, Page } from '@playwright/test';
import {
  capture,
  choose,
  id,
  item,
  named,
  pickDate,
  record,
  requestId,
  save,
  setupContracts,
  type Write,
} from './contracts-fixtures.js';

const created = '40000000-0000-4000-8000-000000000009';
type Op = 'create' | 'change' | 'renew' | 'terminate';
const contract = (status = 'valid', extra = {}) => ({
  id: created,
  employeeId: 'employee',
  revision: 1,
  status,
  approvalStatus: 'effective',
  ...extra,
});
/** 每种操作：入口按钮、弹窗标题、填写步骤、成功回执、预期请求体。 */
const cases: Record<Op, { button: string; title: string; receipt: object; fields: object }> = {
  create: {
    button: '新签',
    title: '新签合同',
    receipt: contract(),
    fields: { companyId: 'company', typeId: 'type', termType: 'fixed', effectiveDate: '2026-11-01', termMonths: 12 },
  },
  change: {
    button: '发起变更申请',
    title: '发起合同变更申请',
    receipt: {
      id: requestId,
      employeeId: 'employee',
      revision: 1,
      operation: 'change',
      status: 'in_review',
      targetId: id,
    },
    fields: { number: 'DEMO-CT-002', effectiveDate: '2026-11-01' },
  },
  renew: { button: '续签', title: '续签合同', receipt: contract(), fields: { termMonths: 24 } },
  terminate: {
    button: '终止',
    title: '终止合同',
    receipt: contract('terminated', { id }),
    fields: { actualTerminationDate: '2026-12-31' },
  },
};
async function open(page: Page, op: Op) {
  await setupContracts(page);
  if (op === 'create') {
    await page.getByRole('button', { name: '入职缺失', exact: true }).click();
    await page.locator('.ant-table').getByRole('button', named('新签')).click();
  } else {
    await page.getByRole('button', { name: '查看合同', exact: true }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: '2020-03-01' })).toBeVisible();
    await page.getByRole('button', named(cases[op].button)).click();
  }
  const form = page.getByRole('dialog', { name: cases[op].title, exact: true });
  await expect(form).toBeVisible();
  return form;
}
async function fill(form: Locator, op: Op) {
  // 原合同期限为 12 个月，续签填 24 才触发期限联动。
  const months = () =>
    item(form, '合同期限（月）')
      .getByRole('spinbutton')
      .fill(op === 'renew' ? '24' : '12');
  if (op === 'create') {
    await choose(form, '公司', '合成公司');
    await choose(form, '合同类型', '合成合同类型');
    await pickDate(form, '生效日期', '2026-11-01');
    await months();
  }
  if (op === 'change') {
    await item(form, '编号').getByRole('textbox').fill('DEMO-CT-002');
    await pickDate(form, '生效日期', '2026-11-01');
  }
  if (op === 'renew') await months();
  if (op === 'terminate') await pickDate(form, '实际终止时间', '2026-12-31');
  // 期限月数联动出终止日期（linkTerm），失焦后才会提交 InputNumber 的值。
  if (op === 'create' || op === 'renew') await expect(item(form, '终止日期').getByRole('textbox')).not.toHaveValue('');
}
async function commands(page: Page, respond: (count: number) => object) {
  const writes: Write[] = [];
  await page.route('**/api/tenant/contracts/commands', (route) => {
    capture(writes, route.request());
    const { status = 200, json } = respond(writes.length) as { status?: number; json: unknown };
    return route.fulfill({ status, json });
  });
  return writes;
}

for (const op of ['create', 'change', 'renew', 'terminate'] as const) {
  test(`AC-FE-R2a-10 ${cases[op].title}：按权限打开、经内核提交并按回执形态分流`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const form = await open(page, op);
    const writes = await commands(page, () => ({ json: cases[op].receipt }));
    await fill(form, op);
    await form.getByRole('button', save).click();
    await expect(form).toHaveCount(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      path: '/api/tenant/contracts/commands',
      method: 'POST',
      revision: op === 'create' ? '0' : String(record.revision),
      body: {
        operation: op,
        mode: op === 'change' ? 'application' : 'direct',
        employeeId: 'employee',
        ...(op === 'create' ? {} : { targetId: id }),
        fields: cases[op].fields,
      },
    });
    expect(writes[0]!.command).toMatch(/^[\da-f-]{36}$/);
    if (op === 'create' || op === 'renew') await page.waitForURL(`**/contracts/records/${created}`);
    if (op === 'change') await expect(page.getByText('申请已提交，审批通过并到生效日后生效')).toBeVisible();
    if (op === 'terminate') await expect(page.getByText('已保存', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
  test(`AC-FE-R2a-11 ${cases[op].title}：业务拒绝保留输入可改正，结果未知锁定不重发`, async ({ page }) => {
    const form = await open(page, op);
    const writes = await commands(page, (count) =>
      count === 1
        ? { status: 409, json: { error: { code: 'CONFLICT', message: '该合同已有未完成申请' } } }
        : { status: 500, json: { error: { code: 'INTERNAL' } } },
    );
    await fill(form, op);
    await form.getByRole('button', save).click();
    await expect(form.getByText('该合同已有未完成申请')).toBeVisible();
    await expect(form.getByRole('button', save)).toBeEnabled();
    await form.getByRole('button', save).click();
    await expect(form).toContainText('处理中 / 结果待确认');
    await expect(form.getByRole('button', save)).toBeDisabled();
    if (op !== 'create') await expect(form.getByRole('button', { name: '回查原单', exact: true })).toBeVisible();
    expect(writes).toHaveLength(2);
    expect(writes[0]!.command).not.toBe(writes[1]!.command);
  });
}
for (const op of ['change', 'renew', 'terminate'] as const) {
  test(`AC-FE-R2a-12 ${cases[op].title}：版本冲突保留输入，重读核对后带新版本重提`, async ({ page }) => {
    const form = await open(page, op);
    const writes = await commands(page, (count) =>
      count === 1 ? { status: 409, json: { error: { code: 'REVISION_CONFLICT' } } } : { json: cases[op].receipt },
    );
    await page.route('**/api/tenant/contracts/records/*', (route) =>
      route.fulfill({ json: { ...record, number: '他人编号', revision: record.revision + 1 } }),
    );
    await fill(form, op);
    await form.getByRole('button', save).click();
    await form.getByRole('button', { name: '重读最新版本', exact: true }).click();
    await form.getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
    await form.getByRole('button', save).click();
    await expect(form).toHaveCount(0);
    expect(writes.map((write) => write.revision)).toEqual([String(record.revision), String(record.revision + 1)]);
  });
}
// 第 2 轮：变更 / 续签 / 终止三种入口各按自己的状态规则判断（规格 32 CT-R3，后端 assertOperationState）。
const entries = ['变更', '发起变更申请', '续签', '终止'];
for (const [status, approvalStatus, shown] of [
  ['valid', 'effective', entries],
  ['terminated', 'effective', ['续签']],
  ['terminated', 'in_review', []],
  ['void', 'effective', []],
] as const) {
  test(`AC-FE-R2a-22 ${status} / ${approvalStatus} 合同的业务入口按各自状态规则显示`, async ({ page }) => {
    await setupContracts(page);
    await page.route('**/api/tenant/contracts/records/*', (route) =>
      route.fulfill({ json: { ...record, status, approvalStatus } }),
    );
    await page.getByRole('button', { name: '查看合同', exact: true }).first().click();
    const heading = page.locator('.contract-heading');
    await expect(page.locator('.contract-detail .contract-card')).toContainText('DEMO-CT-001');
    for (const label of entries)
      await expect(heading.getByRole('button', named(label))).toHaveCount(
        (shown as readonly string[]).includes(label) ? 1 : 0,
      );
    if (!shown.length) return;
    await heading.getByRole('button', named('续签')).click();
    await expect(page.getByRole('dialog', { name: '续签合同', exact: true })).toBeVisible();
  });
}
const section = (form: Locator, title: string) =>
  form.locator('section').filter({ has: form.page().getByRole('heading', { name: title, exact: true }) });
// 第 2 轮：表单按原站先任职信息分区；新合同区首位是人员；原合同信息带期限月数。
for (const op of ['create', 'change', 'renew'] as const) {
  test(`AC-FE-R2a-23 ${cases[op].title}：任职信息分区、人员在合同区首位、原合同期限月数`, async ({ page }) => {
    const form = await open(page, op);
    const titles = { create: '合同信息', change: '变更后合同信息', renew: '续签合同信息' };
    await expect(form.locator('h2.form-group-title').first()).toHaveText('任职信息');
    const employment = section(form, '任职信息');
    await expect(item(employment, '入职日期')).toContainText(op === 'create' ? '2021-05-01' : '2020-03-01');
    await expect(item(employment, '部门')).toContainText('合成部门');
    await expect(item(employment, '职务')).toContainText('合成职务');
    const first = section(form, titles[op]).locator('.ant-form-item').first();
    await expect(first.locator('.ant-form-item-label')).toHaveText(/人员/);
    await expect(first).toContainText('合成甲');
    if (op === 'create') return;
    await expect(item(section(form, '原合同信息'), '合同期限（月）')).toContainText('12');
  });
}
