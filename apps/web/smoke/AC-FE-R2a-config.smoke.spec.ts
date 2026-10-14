// F-127b：合同类型 / 续签规则 / 合同设置保存与规则删除，审批中行内催办 / 转交 / 撤销（接口全部为合成桩）。
import { test, expect, user } from './fixtures.js';
import type { Locator, Page } from '@playwright/test';
import { objectPermissions } from './contracts-permissions.js';
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

async function approvals(
  page: Page,
  urge: () => object = () => ({ json: {} }),
  actions: string[] = ['urge', 'transfer', 'withdraw'],
) {
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
        actions,
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

test('AC-FE-R2a-17b 催办结果未知的锁存在页面层：切换视图再回来仍锁定，不生成新命令', async ({ page }) => {
  const writes = await approvals(page, () => ({ status: 500, json: { error: { code: 'INTERNAL' } } }));
  await row(page, '催办').click();
  await expect(row(page, '催办')).toBeDisabled();
  await page.getByRole('button', { name: '有效合同协议', exact: true }).click();
  await expect(row(page, '催办')).toHaveCount(0);
  await page.getByRole('button', { name: '审批中合同协议', exact: true }).click();
  await expect(row(page, '催办')).toBeDisabled();
  await expect(page.getByRole('button', { name: '回查原单', exact: true })).toBeVisible();
  expect(writes).toHaveLength(1);
});

test('AC-FE-R2a-16b 行内审批按钮按该行服务端 actions 渲染，空集合不显示', async ({ page }) => {
  await approvals(page, undefined, ['urge']);
  await expect(row(page, '催办')).toBeVisible();
  await expect(row(page, '转交')).toHaveCount(0);
  await expect(row(page, '撤销')).toHaveCount(0);
});
test('AC-FE-R2a-16c 行内审批 actions 为空时本行没有审批按钮', async ({ page }) => {
  await approvals(page, undefined, []);
  await expect(page.locator('.ant-table-row')).toHaveCount(1);
  for (const label of ['催办', '转交', '撤销']) await expect(row(page, label)).toHaveCount(0);
});

test('AC-FE-R2a-19 配置写入口按数据操作判断：buttons 为空照样可写，update=false 时无编辑 / 删除', async ({ page }) => {
  const rules = objectPermissions.rules;
  await setupContracts(page, {
    [rules.objectCode]: { ...rules, dataOperations: { create: true, update: false, delete: false } },
  });
  await tab(page, '自动续签规则');
  await expect(page.getByRole('button', named('新建'))).toBeVisible();
  await expect(page.locator('.ant-table').getByRole('button', named('规则信息'))).toBeVisible();
  await expect(page.locator('.ant-table').getByRole('button', named('编辑'))).toHaveCount(0);
  await expect(page.locator('.ant-table').getByRole('button', named('删除'))).toHaveCount(0);
  await tab(page, '合同管理设置');
  await expect(page.getByRole('button', named('编辑'))).toBeVisible();
});

type Stale = { label: string; tab: string; open: (page: Page) => Promise<void>; dialog: string; read: string };
/** 首次写入返回版本冲突，之后读到服务端新版本；重提须按实际提交的版本核对回执。 */
async function staleOnce(page: Page, read: string, write: string, row: { revision: number }, list: boolean) {
  let current = { ...row };
  const writes: Write[] = [];
  await page.route(read, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: list ? { items: [current], total: 1, page: 1, pageSize: 15 } : current })
      : route.fallback(),
  );
  await page.route(write, (route) => {
    if (route.request().method() === 'GET') return route.fallback();
    capture(writes, route.request());
    if (writes.length === 1) {
      current = { ...current, revision: current.revision + 1 };
      return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT', message: '版本冲突' } } });
    }
    const next = { ...current, revision: current.revision + 1 };
    const id = (next as { id?: string }).id;
    if (route.request().method() === 'DELETE') return route.fulfill({ json: { id, deleted: true } });
    return route.fulfill({ json: list ? { id, revision: next.revision } : next });
  });
  return writes;
}
const resolve = async (scope: Locator) => {
  await scope.getByRole('button', { name: '重读最新版本', exact: true }).click();
  await scope.getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
};
const tableEdit = (page: Page) => page.locator('.ant-table').getByRole('button', named('编辑')).click();
const staleCases: (Stale & { write: string; row: { revision: number }; change: (dialog: Locator) => Promise<void> })[] =
  [
    {
      label: '合同类型',
      tab: '合同类型',
      open: tableEdit,
      dialog: '编辑',
      read: '**/api/tenant/contracts/master-data/types?*',
      write: '**/api/tenant/contracts/master-data/types/type',
      row: typeRow,
      change: (dialog) => item(dialog, '合同类型名称').getByRole('textbox').fill('合成改名类型'),
    },
    {
      label: '续签规则',
      tab: '自动续签规则',
      open: tableEdit,
      dialog: '编辑自动续签规则',
      read: '**/api/tenant/contracts/rules?*',
      write: '**/api/tenant/contracts/rules/rule',
      row: ruleRow,
      change: (dialog) => item(dialog, '规则名称').getByRole('textbox').fill('合成改名规则'),
    },
    {
      label: '合同设置',
      tab: '合同管理设置',
      open: (page) => page.getByRole('button', named('编辑')).click(),
      dialog: '编辑合同管理设置',
      read: '**/api/tenant/contracts/settings',
      write: '**/api/tenant/contracts/settings',
      row: settingsRow,
      change: (dialog) => dialog.getByRole('switch', { name: '到期后自动终止', exact: true }).click(),
    },
  ];
for (const stale of staleCases)
  test(`AC-FE-R2a-18 ${stale.label}冲突重读后重提：回执按实际提交的新版本核对，保存成功`, async ({ page }) => {
    await setupContracts(page);
    const list = stale.label !== '合同设置';
    const writes = await staleOnce(page, stale.read, stale.write, stale.row, list);
    await tab(page, stale.tab);
    await stale.open(page);
    const dialog = page.getByRole('dialog', { name: stale.dialog, exact: true });
    await stale.change(dialog);
    await dialog.getByRole('button', save).click();
    await resolve(dialog);
    await dialog.getByRole('button', save).click();
    await expect(dialog).toHaveCount(0);
    const revision = stale.row.revision;
    expect(writes.map((write) => write.revision)).toEqual([String(revision), String(revision + 1)]);
    expect(writes[0]!.command).not.toEqual(writes[1]!.command);
  });

test('AC-FE-R2a-20 类型启停冲突后可重读、核对、重提', async ({ page }) => {
  await setupContracts(page);
  const writes = await staleOnce(
    page,
    '**/api/tenant/contracts/master-data/types?*',
    '**/api/tenant/contracts/master-data/types/type',
    typeRow,
    true,
  );
  await tab(page, '合同类型');
  const table = page.locator('.ant-table');
  await table.getByRole('button', named('停用')).click();
  await page.getByRole('tooltip').getByRole('button', named('确定')).click();
  await resolve(table);
  await table.getByRole('button', named('停用')).click();
  await page.getByRole('tooltip').getByRole('button', named('确定')).click();
  await expect.poll(() => writes.length).toBe(2);
  await expect(table.getByRole('button', { name: '重读最新版本', exact: true })).toHaveCount(0);
  expect(writes.map(({ revision, body }) => [revision, body])).toEqual([
    [String(typeRow.revision), { code: typeRow.code, name: typeRow.name, enabled: false }],
    [String(typeRow.revision + 1), { code: typeRow.code, name: typeRow.name, enabled: false }],
  ]);
});

test('AC-FE-R2a-21 规则删除冲突后可重读、核对、重提', async ({ page }) => {
  await setupContracts(page);
  const writes = await staleOnce(
    page,
    '**/api/tenant/contracts/rules?*',
    '**/api/tenant/contracts/rules/rule',
    ruleRow,
    true,
  );
  await tab(page, '自动续签规则');
  const table = page.locator('.ant-table');
  await table.getByRole('button', named('删除')).click();
  await page.getByRole('tooltip').getByRole('button', named('确定')).click();
  await resolve(table);
  await table.getByRole('button', named('删除')).click();
  await page.getByRole('tooltip').getByRole('button', named('确定')).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes.map(({ method, revision }) => [method, revision])).toEqual([
    ['DELETE', String(ruleRow.revision)],
    ['DELETE', String(ruleRow.revision + 1)],
  ]);
});

const renewal = (page: Page) => page.getByRole('switch', { name: '合同到期自动续签', exact: true });
test('AC-FE-R2a-25 规则页自动续签开关按差异保存，带设置版本，回执按提交版本核对', async ({ page }) => {
  await setupContracts(page);
  let current = { ...settingsRow };
  const writes = await writesTo(page, '**/api/tenant/contracts/settings', (write) => {
    current = { ...current, ...(write.body as object), revision: current.revision + 1 };
    return { json: current };
  });
  await page.route('**/api/tenant/contracts/settings', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: current }) : route.fallback(),
  );
  await tab(page, '自动续签规则');
  await expect(renewal(page)).not.toBeChecked();
  await renewal(page).click();
  await expect(renewal(page)).toBeChecked();
  expect(writes).toEqual([expect.objectContaining({ method: 'PUT', revision: '2', body: { autoRenew: true } })]);
});

test('AC-FE-R2a-25b 自动续签开关冲突后可重读、核对、重提', async ({ page }) => {
  await setupContracts(page);
  const writes = await staleOnce(
    page,
    '**/api/tenant/contracts/settings',
    '**/api/tenant/contracts/settings',
    settingsRow,
    false,
  );
  await tab(page, '自动续签规则');
  await renewal(page).click();
  await resolve(page.locator('.contract-renewal'));
  await renewal(page).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes.map(({ revision, body }) => [revision, body])).toEqual([
    [String(settingsRow.revision), { autoRenew: true }],
    [String(settingsRow.revision + 1), { autoRenew: true }],
  ]);
});

test('AC-FE-R2a-25c 合同设置无更新权限时规则页开关只读', async ({ page }) => {
  const settings = objectPermissions.settings;
  await setupContracts(page, {
    [settings.objectCode]: { ...settings, dataOperations: { ...settings.dataOperations, update: false } },
  });
  await tab(page, '自动续签规则');
  await expect(renewal(page)).toBeDisabled();
});

const ordered = [
  { ...ruleRow, id: 'rule-a', name: '合成规则甲', priority: 1 },
  { ...ruleRow, id: 'rule-b', name: '合成规则乙', priority: 2 },
  { ...ruleRow, id: 'rule-c', name: '合成规则丙', priority: 3 },
];
async function ruleList(page: Page, items: (typeof ordered)[number][]) {
  await setupContracts(page);
  await page.route('**/api/tenant/contracts/rules?*', (route) =>
    route.fulfill({ json: { items, total: items.length, page: 1, pageSize: 15 } }),
  );
  const writes = await writesTo(page, '**/api/tenant/contracts/rules/*', (write) => ({
    json: { id: write.path.split('/').at(-1), revision: ruleRow.revision + 1 },
  }));
  await tab(page, '自动续签规则');
  return writes;
}
const ruleLine = (page: Page, name: string) => page.locator('.ant-table-row').filter({ hasText: name });
test('AC-FE-R2a-26 规则单条上移 / 下移：只改本条 priority，PUT 完整请求体并带本条版本', async ({ page }) => {
  const writes = await ruleList(page, ordered);
  await expect(ruleLine(page, '合成规则甲').getByRole('button', named('上移'))).toHaveCount(0);
  await expect(ruleLine(page, '合成规则丙').getByRole('button', named('下移'))).toHaveCount(0);
  await ruleLine(page, '合成规则甲').getByRole('button', named('下移')).click();
  await expect.poll(() => writes.length).toBe(1);
  await ruleLine(page, '合成规则丙').getByRole('button', named('上移')).click();
  await expect.poll(() => writes.length).toBe(2);
  const body = (rule: (typeof ordered)[number], priority: number) => {
    const { id: _id, revision: _revision, ...rest } = rule;
    return { ...rest, priority };
  };
  // 甲（1）越过乙（2）、仍在丙（3）之前：取 3，同优先级按 ID 排在丙前；丙越过乙、仍在甲之后：取 1。
  expect(writes).toEqual([
    expect.objectContaining({ method: 'PUT', path: '/api/tenant/contracts/rules/rule-a', revision: '5' }),
    expect.objectContaining({ method: 'PUT', path: '/api/tenant/contracts/rules/rule-c', revision: '5' }),
  ]);
  expect(writes.map((write) => write.body)).toEqual([body(ordered[0]!, 3), body(ordered[2]!, 1)]);
});

test('AC-FE-R2a-26b 单条改优先级无法排到目标位置时不发请求，提示需批量重排', async ({ page }) => {
  const writes = await ruleList(page, [
    { ...ordered[0]!, priority: 0 },
    { ...ordered[1]!, priority: 0 },
  ]);
  await ruleLine(page, '合成规则乙').getByRole('button', named('上移')).click();
  await expect(page.getByText('需要批量重排', { exact: false })).toBeVisible();
  expect(writes).toEqual([]);
});
