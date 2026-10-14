// F-127b：合同类型 / 续签规则 / 合同设置保存与规则删除，审批中行内催办 / 转交 / 撤销（接口全部为合成桩）。
import { test, expect, user } from './fixtures.js';
import type { Page } from '@playwright/test';
import {
  capture,
  instance,
  item,
  named,
  requestId,
  ruleRow,
  save,
  settingsRow,
  setupContracts,
  task,
  typeRow,
  type Write,
} from './contracts-fixtures.js';

async function writesTo(page: Page, pattern: string, respond: (write: Write) => object) {
  const writes: Write[] = [];
  await page.route(pattern, (route) => {
    if (route.request().method() === 'GET') return route.fallback();
    capture(writes, route.request());
    const { status = 200, json } = respond(writes.at(-1)!) as { status?: number; json: unknown };
    return route.fulfill({ status, json });
  });
  return writes;
}
const tab = (page: Page, label: string) => page.getByRole('link', { name: label, exact: true }).click();

test('AC-FE-R2a-13 合同类型新建 / 编辑 / 行内停用：新建 revision 0，编辑带原版本，重名拒绝可改正', async ({ page }) => {
  await setupContracts(page);
  const writes = await writesTo(page, '**/api/tenant/contracts/master-data/types{,/*}', (write) =>
    write.method === 'POST' && (write.body as { code?: string }).code === 'DEMO-DUP'
      ? { status: 409, json: { error: { code: 'CONFLICT', message: '合同编号或主数据编码已存在' } } }
      : { json: { id: write.method === 'POST' ? 'type-new' : typeRow.id, revision: Number(write.revision) + 1 } },
  );
  await tab(page, '合同类型');
  await page.getByRole('button', named('新建')).click();
  const create = page.getByRole('dialog', { name: '新建', exact: true });
  await item(create, '合同类型编码').getByRole('textbox').fill('DEMO-DUP');
  await item(create, '合同类型名称').getByRole('textbox').fill('合成新类型');
  await create.getByRole('button', save).click();
  await expect(create.getByText('合同编号或主数据编码已存在')).toBeVisible();
  await item(create, '合同类型编码').getByRole('textbox').fill('DEMO-T2');
  await create.getByRole('button', save).click();
  await expect(create).toHaveCount(0);
  await page.locator('.ant-table').getByRole('button', named('编辑')).click();
  const edit = page.getByRole('dialog', { name: '编辑', exact: true });
  // 原站编辑时编码只读，启停不在表单里。
  await expect(item(edit, '合同类型编码').getByRole('textbox')).toHaveCount(0);
  await expect(item(edit, '启用')).toHaveCount(0);
  await item(edit, '合同类型名称').getByRole('textbox').fill('合成改名类型');
  await edit.getByRole('button', save).click();
  await expect(edit).toHaveCount(0);
  await page.locator('.ant-table').getByRole('button', named('停用')).click();
  await page.getByRole('tooltip').getByRole('button', named('确定')).click();
  await expect.poll(() => writes.length).toBe(4);
  expect(writes.map(({ path, method, revision }) => [path, method, revision])).toEqual([
    ['/api/tenant/contracts/master-data/types', 'POST', '0'],
    ['/api/tenant/contracts/master-data/types', 'POST', '0'],
    ['/api/tenant/contracts/master-data/types/type', 'PUT', String(typeRow.revision)],
    ['/api/tenant/contracts/master-data/types/type', 'PUT', String(typeRow.revision)],
  ]);
  expect(writes[1]!.body).toEqual({ code: 'DEMO-T2', name: '合成新类型', enabled: true });
  expect(writes[2]!.body).toEqual({ code: typeRow.code, name: '合成改名类型', enabled: true });
  expect(writes[3]!.body).toEqual({ code: typeRow.code, name: typeRow.name, enabled: false });
});

test('AC-FE-R2a-14 续签规则编辑提交完整请求体，删除二次确认后带版本发送', async ({ page }) => {
  await setupContracts(page);
  const writes = await writesTo(page, '**/api/tenant/contracts/rules/*', (write) => ({
    json: write.method === 'DELETE' ? { id: ruleRow.id, deleted: true } : { id: ruleRow.id, revision: 6 },
  }));
  await tab(page, '自动续签规则');
  await page.locator('.ant-table').getByRole('button', named('编辑')).click();
  const edit = page.getByRole('dialog', { name: '编辑自动续签规则', exact: true });
  await expect(edit.getByRole('heading', { name: '流程发起规则', exact: true })).toBeVisible();
  await item(edit, '规则名称').getByRole('textbox').fill('合成改名规则');
  await edit.getByRole('button', save).click();
  await expect(edit).toHaveCount(0);
  await page.locator('.ant-table').getByRole('button', named('删除')).click();
  await page
    .getByRole('tooltip')
    .getByRole('button', { name: /确\s*定/ })
    .click();
  await expect.poll(() => writes.length).toBe(2);
  const { id: _id, revision: _revision, ...body } = ruleRow;
  expect(writes[0]).toMatchObject({ method: 'PUT', revision: '5', body: { ...body, name: '合成改名规则' } });
  expect(writes[1]).toMatchObject({ method: 'DELETE', revision: '5', path: '/api/tenant/contracts/rules/rule' });
});

test('AC-FE-R2a-15 合同设置按差异保存，回执须为本租户下一版本', async ({ page }) => {
  await setupContracts(page);
  const writes = await writesTo(page, '**/api/tenant/contracts/settings', () => ({
    json: { ...settingsRow, autoTerminate: false, revision: settingsRow.revision + 1 },
  }));
  await tab(page, '合同管理设置');
  await page.getByRole('button', named('编辑')).click();
  const edit = page.getByRole('dialog', { name: '编辑合同管理设置', exact: true });
  await edit.getByRole('switch', { name: '到期后自动终止', exact: true }).click();
  await edit.getByRole('button', save).click();
  await expect(edit).toHaveCount(0);
  expect(writes).toEqual([expect.objectContaining({ method: 'PUT', revision: '2', body: { autoTerminate: false } })]);
});

async function approvals(page: Page, urge: () => object = () => ({ json: {} })) {
  const writes: Write[] = [];
  await page.route('**/api/tenant/approval/**', (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET') {
      capture(writes, route.request());
      const { status = 200, json } = (url.pathname.endsWith('/urge') ? urge() : { json: {} }) as {
        status?: number;
        json: unknown;
      };
      return route.fulfill({ status, json });
    }
    if (url.pathname.endsWith('/instances'))
      return route.fulfill({
        json: {
          items:
            url.searchParams.get('businessId') === requestId
              ? [{ id: instance, title: '合成合同变更申请', status: 'running', approvalType: 'contract', revision: 4 }]
              : [],
        },
      });
    return route.fulfill({
      json: {
        id: instance,
        title: '合成合同变更申请',
        revision: 4,
        status: 'running',
        approvalType: 'contract',
        actions: ['urge', 'transfer', 'withdraw'],
        recordsHidden: false,
        form: { values: {} },
        tasks: [{ id: task, nodeName: '合成审批节点', status: 'pending', assigneeUserId: user }],
        logs: [],
      },
    });
  });
  await setupContracts(page);
  await page.getByRole('button', { name: '审批中合同协议', exact: true }).click();
  return writes;
}
const row = (page: Page, label: string) => page.locator('.ant-table').getByRole('button', { name: label, exact: true });

test('AC-FE-R2a-16 审批中行内催办 / 转交 / 撤销复用审批中心命令', async ({ page }) => {
  const writes = await approvals(page);
  await row(page, '催办').click();
  await expect(page.getByText('已催办', { exact: true })).toBeVisible();
  await row(page, '转交').click();
  const detail = page.getByRole('dialog', { name: '合成合同变更申请' });
  await detail.getByRole('button', { name: /^转\s*交$/ }).click();
  await page.getByLabel('转交给（账号编号）').fill(user);
  await page.getByRole('button', save).click();
  await expect(detail).toHaveCount(0);
  await row(page, '撤销').click();
  await detail.getByRole('button', { name: /^撤\s*销$/ }).click();
  await page.getByRole('button', save).click();
  await expect(detail).toHaveCount(0);
  expect(writes.map(({ path, revision }) => [path, revision])).toEqual([
    [`/api/tenant/approval/instances/${instance}/urge`, '4'],
    [`/api/tenant/approval/tasks/${task}/transfer`, '4'],
    [`/api/tenant/approval/instances/${instance}/withdraw`, '4'],
  ]);
  expect(writes[1]!.body).toEqual({ comment: null, toUserId: user });
});

test('AC-FE-R2a-17 催办结果未知锁定本行催办，不自动重发', async ({ page }) => {
  const writes = await approvals(page, () => ({ status: 500, json: { error: { code: 'INTERNAL' } } }));
  await row(page, '催办').click();
  await expect(row(page, '催办')).toBeDisabled();
  await expect(row(page, '转交')).toBeEnabled();
  expect(writes).toHaveLength(1);
});
