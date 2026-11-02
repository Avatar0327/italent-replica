// FE-R2c2b：离职设置页的交接事项（B64）、交接发起规则（B65）、黑名单与自动加黑规则（B68）。接口为有状态合成桩，
// 行 / 回执形态按 exit-settings-fixtures.ts（AC-FE-R2c2b-exit-settings 用真实接口逐键核对）。
import type { Page, Route } from '@playwright/test';
import { actionButton } from './action-button.js';
import { otherSettingsMenu } from './account-stop-fixtures.js';
import { capture, choose, item, named, save, type Write } from './contracts-fixtures.js';
import { settingsPermission } from './exit-fixtures.js';
import {
  autoBlacklistDefault,
  blacklistEntry,
  blacklistPage,
  blacklistPermission,
  blacklistRule,
  deletedReceipt,
  handoverItem,
  revisionConflict,
  triggerDefault,
} from './exit-settings-fixtures.js';
import { expect, snapshotFixture, test, user } from './fixtures.js';

const EMPLOYMENT = '/api/tenant/employment';
const ITEMS = `${EMPLOYMENT}/exit-handover-items`;
const RULES = `${EMPLOYMENT}/blacklist-rules`;
const BLACKLIST = `${EMPLOYMENT}/blacklist`;
const ORG = { id: blacklistRule.orgIds[0]!, name: '合成总部' };
type Row = Record<string, unknown> & { id: string; revision: number };
type Reply = { status: number; json: unknown } | 'abort';
type Setting = typeof triggerDefault;

function createServer() {
  return {
    items: [{ ...handoverItem }] as Row[],
    rules: [{ ...blacklistRule }] as Row[],
    blacklist: [{ ...blacklistEntry }] as Row[],
    settings: {
      [triggerDefault.key]: { ...triggerDefault },
      [autoBlacklistDefault.key]: { ...autoBlacklistDefault },
    } as Record<string, Setting>,
    writes: [] as Write[],
    queries: [] as string[],
    override: undefined as ((write: Write) => Reply | undefined) | undefined,
    sequence: 1,
    admin: true,
  };
}
type Server = ReturnType<typeof createServer>;

async function setup(page: Page, { admin = true, permission = blacklistPermission } = {}) {
  const server = { ...createServer(), admin };
  await page.route('**/permission/me/snapshot', (route) => {
    const body = structuredClone(snapshotFixture);
    if (admin) body.adminMenus = [...body.adminMenus, otherSettingsMenu];
    return route.fulfill({ json: body });
  });
  await page.route('**/permission/me/objects/*', (route) => {
    const code = decodeURIComponent(route.request().url().split('/').at(-1)!);
    if (code === settingsPermission.objectCode) return route.fulfill({ json: settingsPermission });
    if (code === permission.objectCode) return route.fulfill({ json: permission });
    return route.fallback();
  });
  await page.route('**/api/tenant/org/organizations?*', (route) =>
    route.fulfill({ json: { items: [ORG], total: 1, page: 1, pageSize: 200 } }),
  );
  await page.route(
    (url) => url.pathname.startsWith(EMPLOYMENT) || url.pathname.startsWith('/api/tenant/settings/'),
    (route) => handle(server, route),
  );
  await page.setViewportSize({ width: 1512, height: 754 });
  await page.goto('/exit-settings');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.waitForURL('**/staff');
  return server;
}

function handle(server: Server, route: Route) {
  const request = route.request();
  const url = new URL(request.url());
  if (request.method() === 'GET') {
    if (url.pathname === BLACKLIST) server.queries.push(url.search);
    // 租户设置读写都要其他设置权（tenant-settings/policy.ts），无权时 403。
    if (url.pathname.startsWith('/api/tenant/settings/') && !server.admin)
      return route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN', message: '无权访问' } } });
    return route.fulfill({ json: read(server, url) });
  }
  capture(server.writes, request);
  const write = server.writes.at(-1)!;
  const reply = server.override?.(write) ?? apply(server, write);
  return reply === 'abort' ? route.abort('connectionreset') : route.fulfill(reply);
}
function read(server: Server, url: URL) {
  if (url.pathname === ITEMS) return { items: server.items };
  if (url.pathname === RULES) return { items: server.rules };
  if (url.pathname === BLACKLIST) {
    const query = url.searchParams;
    const items = server.blacklist.filter(
      (row) =>
        row.status === query.get('status') &&
        (!query.get('reason') || row.reason === query.get('reason')) &&
        (!query.get('name') || row.name === query.get('name')),
    );
    return blacklistPage(items as never, Number(query.get('page')), Number(query.get('pageSize')));
  }
  return server.settings[url.pathname.split('/').at(-1)!];
}

const conflict: Reply = { status: 409, json: revisionConflict };
function apply(server: Server, write: Write): Reply {
  if (write.path.startsWith('/api/tenant/settings/')) {
    const setting = server.settings[write.path.split('/').at(-1)!]!;
    if (write.revision !== String(setting.revision)) return conflict;
    const value = (write.body as { value: unknown }).value;
    server.settings[setting.key] = { ...setting, value, source: 'tenant', revision: setting.revision + 1 };
    return { status: 200, json: server.settings[setting.key] };
  }
  if (write.path === `${BLACKLIST}/remove` || write.path === `${BLACKLIST}/delete`) return batch(server, write);
  const created = COLLECTIONS[write.path];
  const key = created ?? COLLECTIONS[write.path.replace(/\/[^/]+$/, '')]!;
  const rows = server[key];
  if (created) {
    if (write.revision !== '0') return conflict;
    const row = { ...defaults(key), ...(write.body as object), id: `new-${server.sequence++}`, revision: 1 };
    rows.push(row);
    return { status: 201, json: row };
  }
  const id = write.path.split('/').at(-1)!;
  const index = rows.findIndex((row) => row.id === id);
  if (index < 0 || write.revision !== String(rows[index]!.revision)) return conflict;
  if (write.method === 'DELETE') {
    rows.splice(index, 1);
    return { status: 200, json: deletedReceipt(id) };
  }
  rows[index] = { ...rows[index]!, ...(write.body as object), revision: rows[index]!.revision + 1 };
  return { status: 200, json: rows[index] };
}
const COLLECTIONS: Record<string, 'items' | 'rules' | 'blacklist'> = {
  [ITEMS]: 'items',
  [RULES]: 'rules',
  [BLACKLIST]: 'blacklist',
};
function defaults(key: string) {
  if (key !== 'blacklist') return {};
  const { id: _id, ...entry } = blacklistEntry;
  return { ...entry, mobilePhone: null, source: 'manual', status: 'active' };
}
function batch(server: Server, write: Write): Reply {
  const [target] = (write.body as { items: { id: string; revision: number }[] }).items;
  const index = server.blacklist.findIndex((row) => row.id === target!.id);
  if (index < 0 || server.blacklist[index]!.revision !== target!.revision) return conflict;
  if (write.path.endsWith('/delete')) {
    server.blacklist.splice(index, 1);
    return { status: 200, json: { deleted: 1 } };
  }
  const row = { ...server.blacklist[index]!, status: 'removed', removedAt: '2026-11-01T02:00:00.000Z' };
  server.blacklist[index] = { ...row, revision: row.revision + 1 };
  return { status: 200, json: { items: [server.blacklist[index]] } };
}

const openTab = async (page: Page, tab: string, label: string) => {
  await page.goto(`/exit-settings/${tab}`);
  await expect(page.getByRole('tab', { name: label, selected: true })).toBeVisible();
};
const dialog = (page: Page) => page.getByRole('dialog');
const textbox = (page: Page, label: string) => item(dialog(page), label).getByRole('textbox');
const spin = (page: Page, label: string) => item(dialog(page), label).getByRole('spinbutton');
const row = (page: Page, text: string) => page.getByRole('row').filter({ hasText: text });
const confirmPop = async (page: Page) => page.locator('.ant-popconfirm').getByRole('button', named('确定')).click();
const commands = (server: Server) => new Set(server.writes.map((write) => write.command)).size;

test('AC-FE-R2c2b-01 交接事项：按类别分组；新增 / 编辑 / 删除带版本，回执核对后刷新', async ({ page }) => {
  const server = await setup(page);
  await openTab(page, 'handover-items', '交接事项');
  await expect(page.getByRole('region', { name: '行政' })).toContainText('归还门禁卡');

  await page.getByRole('button', named('新增')).click();
  await textbox(page, '事项类别').fill('财务');
  await textbox(page, '待办事项').fill('结清借款');
  await expect(spin(page, '序号')).toHaveValue('2');
  await choose(dialog(page), '待办类别', '其他');
  await dialog(page).getByRole('button', save).click();
  await expect(page.getByRole('region', { name: '财务' })).toContainText('结清借款');

  await row(page, '归还门禁卡').getByRole('button', named('编辑')).click();
  await textbox(page, '备注').fill('交至前台');
  await dialog(page).getByRole('button', save).click();
  await expect(row(page, '归还门禁卡')).toContainText('交至前台');

  await row(page, '结清借款').getByRole('button', named('删除')).click();
  await confirmPop(page);
  await expect(page.getByRole('region', { name: '财务' })).toHaveCount(0);
  expect(server.writes.map(({ method, path, revision, body }) => [method, path, revision, body])).toEqual([
    [
      'POST',
      ITEMS,
      '0',
      { category: '财务', sequenceNo: 2, todoType: 'other', title: '结清借款', formRef: null, remark: null },
    ],
    [
      'PUT',
      `${ITEMS}/${handoverItem.id}`,
      '1',
      {
        category: '行政',
        sequenceNo: 1,
        todoType: 'work_handover',
        title: '归还门禁卡',
        formRef: null,
        remark: '交至前台',
      },
    ],
    ['DELETE', `${ITEMS}/new-1`, '1', null],
  ]);
  expect(commands(server)).toBe(3);
});

test('AC-FE-R2c2b-02 交接事项冲突：重读核对后按最新版本重提；结果未知时本行锁定', async ({ page }) => {
  const server = await setup(page);
  await openTab(page, 'handover-items', '交接事项');
  // 打开编辑后他人改了标题（版本 2）。
  await row(page, '归还门禁卡').getByRole('button', named('编辑')).click();
  server.items[0] = { ...server.items[0]!, title: '归还工牌', revision: 2 };
  await textbox(page, '备注').fill('交至前台');
  await dialog(page).getByRole('button', save).click();
  await expect(dialog(page).getByText('版本冲突：输入已保留')).toBeVisible();
  await actionButton(dialog(page), '重读最新版本').click();
  await dialog(page).getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
  await expect(textbox(page, '待办事项')).toHaveValue('归还工牌');
  await expect(textbox(page, '备注')).toHaveValue('交至前台');
  await dialog(page).getByRole('button', save).click();
  await expect(row(page, '归还工牌')).toContainText('交至前台');
  expect(server.writes.map(({ revision, body }) => [revision, (body as Row).title])).toEqual([
    ['1', '归还门禁卡'],
    ['2', '归还工牌'],
  ]);

  server.override = () => 'abort';
  await row(page, '归还工牌').getByRole('button', named('删除')).click();
  await confirmPop(page);
  await expect(row(page, '归还工牌').getByText('处理中 / 结果待确认')).toBeVisible();
  await expect(row(page, '归还工牌').getByRole('button', named('编辑'))).toBeDisabled();
  await expect(row(page, '归还工牌').getByRole('button', named('删除'))).toBeDisabled();
  expect(server.writes).toHaveLength(3);
});

test('AC-FE-R2c2b-03 黑名单：手工加黑先校验联系标识；移出逐条带版本；筛选换条件回到第 1 页', async ({ page }) => {
  const server = await setup(page);
  await openTab(page, 'blacklist', '黑名单');
  await expect(row(page, '外部人员甲')).toContainText('13800000001');

  await page.getByRole('button', named('手工加黑')).click();
  await textbox(page, '姓名').fill('外部人员乙');
  await choose(dialog(page), '加黑原因', '诚信问题');
  await dialog(page).getByRole('button', save).click();
  await expect(dialog(page).getByText('证件号码、手机号、邮箱至少填写一项')).toBeVisible();
  expect(server.writes).toEqual([]);
  await textbox(page, '邮箱').fill('b@example.com');
  await dialog(page).getByRole('button', save).click();
  await expect(row(page, '外部人员乙')).toContainText('b@example.com');

  await row(page, '外部人员甲').getByRole('button', named('移出')).click();
  await confirmPop(page);
  await expect(row(page, '外部人员甲')).toHaveCount(0);
  await page.getByText('已移出', { exact: true }).click();
  await expect(row(page, '外部人员甲')).toBeVisible();
  // 已移出的记录不能再移出或编辑，只能删除。
  await expect(row(page, '外部人员甲').getByRole('button', named('移出'))).toHaveCount(0);
  await expect(row(page, '外部人员甲').getByRole('button', named('编辑'))).toHaveCount(0);

  await page.getByText('在名单', { exact: true }).click();
  // 筛选项没有表单标签，按下拉的无障碍名定位。
  await page.locator('.exit-settings-filter').getByRole('combobox', { name: '加黑原因' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '诚信问题' }).click();
  await page.getByRole('button', named('查询')).click();
  await expect(row(page, '外部人员乙')).toBeVisible();
  expect(server.writes.map(({ method, path, revision, body }) => [method, path, revision, body])).toEqual([
    ['POST', BLACKLIST, '0', { name: '外部人员乙', email: 'b@example.com', reason: 'integrity' }],
    ['POST', `${BLACKLIST}/remove`, undefined, { items: [{ id: blacklistEntry.id, revision: 1 }] }],
  ]);
  expect(server.queries.at(-1)).toBe('?status=active&reason=integrity&page=1&pageSize=20');
});

test('AC-FE-R2c2b-04 自动加黑：总开关带版本保存；规则新增与编辑整份提交，未改条件原样带回', async ({ page }) => {
  const server = await setup(page);
  await openTab(page, 'blacklist-rules', '自动加黑规则');
  await expect(row(page, '离职三次永久')).toContainText('合成总部');
  await expect(row(page, '离职三次永久')).toContainText('离职次数 ≥ 3');

  await page.getByRole('switch', { name: '离职后自动加入黑名单' }).click();
  await expect(page.getByRole('switch', { name: '离职后自动加入黑名单' })).toBeChecked();

  await page.getByRole('button', named('新增')).click();
  await textbox(page, '规则名称').fill('离职两次');
  await spin(page, '优先级').fill('2');
  await choose(dialog(page), '适用组织', '合成总部');
  await spin(page, '离职次数大于等于（次）').fill('2');
  await dialog(page).getByText('离职当月', { exact: true }).click();
  await choose(dialog(page), '加黑原因', '稳定性差');
  await dialog(page).getByRole('button', save).click();
  await expect(row(page, '离职两次')).toContainText('离职次数 ≥ 2');

  await row(page, '离职三次永久').getByRole('button', named('编辑')).click();
  await spin(page, '优先级').fill('5');
  await dialog(page).getByRole('button', save).click();
  await expect(row(page, '离职三次永久')).toContainText('5');
  const { id: _id, revision: _revision, ...rule } = blacklistRule;
  expect(server.writes.map(({ method, path, revision, body }) => [method, path, revision, body])).toEqual([
    ['PUT', '/api/tenant/settings/exit.auto_blacklist_enabled', '0', { value: true }],
    [
      'POST',
      RULES,
      '0',
      {
        name: '离职两次',
        priority: 2,
        orgIds: [ORG.id],
        description: null,
        conditions: [{ field: 'exitCount', operator: 'gte', value: 2 }],
        term: 'exit_month',
        reason: 'instability',
        note: null,
      },
    ],
    ['PUT', `${RULES}/${blacklistRule.id}`, '1', { ...rule, priority: 5 }],
  ]);
  expect(commands(server)).toBe(3);
});

test('AC-FE-R2c2b-05 交接发起规则：按发起方式显示附加项并整份保存', async ({ page }) => {
  const server = await setup(page);
  await openTab(page, 'handover-trigger', '交接发起规则');
  const form = page.getByRole('region', { name: '交接发起规则' });
  await expect(form.getByText('当前为系统默认值，保存后改为本租户设置。')).toBeVisible();
  await choose(form, '发起方式', '最后工作日前若干天发起');
  await item(form, '提前天数').getByRole('spinbutton').fill('3');
  await form.getByRole('button', save).click();
  await expect(page.getByText('已保存')).toBeVisible();
  await expect.poll(() => server.settings['exit.handover_trigger']!.revision).toBe(1);
  expect(server.writes.map(({ revision, body }) => [revision, body])).toEqual([
    [
      '0',
      {
        value: { ...(triggerDefault.value as object), method: 'days_before_last_work_date', daysBeforeLastWorkDate: 3 },
      },
    ],
  ]);
});

// 无“管理单元设置”可编辑菜单，且黑名单手机号不可查看：fail-closed 只读，裁剪列占位、不进筛选。
test('AC-FE-R2c2b-06 无其他设置权时各页只读；被裁剪的列显示占位且不进筛选', async ({ page }) => {
  const hidden = {
    ...blacklistPermission,
    viewableFields: blacklistPermission.viewableFields.filter((field) => field !== 'mobilePhone'),
    editableFields: [],
    dataOperations: { create: false, update: false, delete: false },
  };
  const readonly = await setup(page, { admin: false, permission: hidden });
  readonly.blacklist = [
    Object.fromEntries(Object.entries(blacklistEntry).filter(([key]) => key !== 'mobilePhone')) as Row,
  ];
  await openTab(page, 'handover-items', '交接事项');
  await expect(row(page, '归还门禁卡')).toBeVisible();
  await expect(page.getByRole('button', named('新增'))).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: '操作' })).toHaveCount(0);
  await openTab(page, 'handover-trigger', '交接发起规则');
  await expect(page.getByText('暂无访问权限')).toBeVisible();
  await expect(page.getByRole('switch', { name: '启用离职交接' })).toHaveCount(0);
  await openTab(page, 'blacklist-rules', '自动加黑规则');
  await expect(row(page, '离职三次永久')).toBeVisible();
  await expect(page.getByRole('switch', { name: '离职后自动加入黑名单' })).toHaveCount(0);
  await expect(page.getByText('无权查看“离职后自动加入黑名单”开关')).toBeVisible();
  await expect(page.getByRole('button', named('新增'))).toHaveCount(0);
  await openTab(page, 'blacklist', '黑名单');
  await expect(row(page, '外部人员甲').getByRole('cell').nth(2)).toHaveText('—');
  await expect(page.getByRole('textbox', { name: '手机号' })).toHaveCount(0);
  await expect(page.getByRole('button', named('手工加黑'))).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: '操作' })).toHaveCount(0);
  expect(readonly.queries.every((query) => !query.includes('mobilePhone'))).toBe(true);
  expect(readonly.writes).toEqual([]);
});

// ---- 第 2 轮返工：Sol P2-1～P2-3、Claude P3-2 / P3-6，以及新建结果未知后重开的锁定探针 ----------------------------------
const filterBox = (page: Page, label: string) =>
  page.locator('.exit-settings-filter').getByRole('textbox', { name: label });

test('AC-FE-R2c2b-07 输入上限与后端一致：65 字姓名精确查询；手机号第 33 字输不进；第 51 个组织被拦', async ({
  page,
}) => {
  const server = await setup(page);
  const prefix = '甲'.repeat(64);
  server.blacklist = [
    { ...blacklistEntry, id: '64000000-0000-4000-8000-000000000065', name: `${prefix}乙` },
    { ...blacklistEntry, id: '64000000-0000-4000-8000-000000000066', name: `${prefix}丙` },
  ];
  await openTab(page, 'blacklist', '黑名单');
  await filterBox(page, '姓名').fill(`${prefix}乙`);
  await expect(filterBox(page, '姓名')).toHaveValue(`${prefix}乙`);
  await page.getByRole('button', named('查询')).click();
  await expect(page.locator('.ant-table-tbody .ant-table-row')).toHaveCount(1);
  await expect(row(page, `${prefix}乙`)).toBeVisible();
  expect(new URLSearchParams(server.queries.at(-1)).get('name')).toBe(`${prefix}乙`);
  await filterBox(page, '手机号').fill('1'.repeat(33));
  await expect(filterBox(page, '手机号')).toHaveValue('1'.repeat(32));

  // 规则已选 50 个组织，再选第 51 个：表单给出可见提示，保存不发请求。
  const orgs = Array.from({ length: 51 }, (_, i) => ({
    id: `63000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    name: `合成组织${String(i + 1).padStart(2, '0')}`,
  }));
  await page.route('**/api/tenant/org/organizations?*', (route) =>
    route.fulfill({ json: { items: orgs, total: orgs.length, page: 1, pageSize: 200 } }),
  );
  server.rules[0] = { ...server.rules[0]!, orgIds: orgs.slice(0, 50).map((org) => org.id) };
  await openTab(page, 'blacklist-rules', '自动加黑规则');
  await row(page, '离职三次永久').getByRole('button', named('编辑')).click();
  await item(dialog(page), '适用组织').locator('.ant-select-selector').click();
  await page.keyboard.type('合成组织51');
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '合成组织51' }).click();
  await expect(dialog(page).getByText('适用组织最多选择 50 个')).toBeVisible();
  await dialog(page).getByRole('button', save).click();
  await expect(dialog(page).getByText('适用组织最多选择 50 个')).toBeVisible();
  expect(server.writes).toEqual([]);
});

test('AC-FE-R2c2b-08 关闭催办后隐藏的天数不挡保存：清空天数 → 关闭催办 → 保存发出 PUT，天数取有效值', async ({
  page,
}) => {
  const server = await setup(page);
  await openTab(page, 'handover-trigger', '交接发起规则');
  const form = page.getByRole('region', { name: '交接发起规则' });
  await item(form, '最后工作日前（天）').getByRole('spinbutton').fill('');
  await form.getByRole('switch', { name: '交接催办' }).click();
  await form.getByRole('button', save).click();
  await expect(page.getByText('已保存')).toBeVisible();
  expect(server.writes.map(({ method, revision, body }) => [method, revision, body])).toEqual([
    [
      'PUT',
      '0',
      {
        value: {
          ...(triggerDefault.value as object),
          remind: { enabled: false, daysBeforeLastWorkDate: 5, daysAfterLastWorkDate: 15 },
        },
      },
    ],
  ]);
});

test('AC-FE-R2c2b-09 多条件规则：显示最大阈值；不改阈值原样保留，改了合并为一条并提示', async ({ page }) => {
  const server = await setup(page);
  const conditions = [
    { field: 'exitCount', operator: 'gte', value: 3 },
    { field: 'exitCount', operator: 'gte', value: 9 },
  ];
  server.rules[0] = { ...server.rules[0]!, conditions };
  await openTab(page, 'blacklist-rules', '自动加黑规则');
  await row(page, '离职三次永久').getByRole('button', named('编辑')).click();
  await expect(spin(page, '离职次数大于等于（次）')).toHaveValue('9');
  await expect(dialog(page).getByText('保存后合并为一条')).toHaveCount(0);
  await spin(page, '优先级').fill('5');
  await dialog(page).getByRole('button', save).click();
  await expect(dialog(page)).toHaveCount(0);

  await row(page, '离职三次永久').getByRole('button', named('编辑')).click();
  await spin(page, '离职次数大于等于（次）').fill('10');
  await expect(dialog(page).getByText('该规则原有 2 条条件，保存后合并为一条')).toBeVisible();
  await dialog(page).getByRole('button', save).click();
  await expect(row(page, '离职三次永久')).toContainText('离职次数 ≥ 10');
  expect(server.writes.map(({ revision, body }) => [revision, (body as Row).conditions])).toEqual([
    ['1', conditions],
    ['2', [{ field: 'exitCount', operator: 'gte', value: 10 }]],
  ]);
});

test('AC-FE-R2c2b-10 手工加黑的有效截止日期：早于今天（租户时区）的日期禁选', async ({ page }) => {
  await setup(page);
  await openTab(page, 'blacklist', '黑名单');
  await page.getByRole('button', named('手工加黑')).click();
  await item(dialog(page), '有效截止日期').getByPlaceholder('选择日期').click();
  const cell = (date: string) => page.locator(`.ant-picker-dropdown:visible td[title="${date}"]`);
  await expect(cell(snapshotFixture.session.today)).not.toHaveClass(/ant-picker-cell-disabled/);
  await expect(cell('2026-10-12')).toHaveClass(/ant-picker-cell-disabled/);
});

test('AC-FE-R2c2b-11 设置不可覆盖（overridable=false）时只读：不给保存与开关', async ({ page }) => {
  const server = await setup(page);
  for (const key of Object.keys(server.settings))
    server.settings[key] = { ...server.settings[key]!, overridable: false };
  await openTab(page, 'handover-trigger', '交接发起规则');
  const form = page.getByRole('region', { name: '交接发起规则' });
  await expect(form.getByText('该设置由系统统一管控，本租户不可修改。')).toBeVisible();
  await expect(form.getByRole('button', save)).toHaveCount(0);
  await openTab(page, 'blacklist-rules', '自动加黑规则');
  await expect(page.getByRole('switch', { name: '离职后自动加入黑名单' })).toBeDisabled();
  expect(server.writes).toEqual([]);
});

test('AC-FE-R2c2b-12 新建结果未知：关闭重开、切页签回来后仍锁定，不重复提交', async ({ page }) => {
  const server = await setup(page);
  await openTab(page, 'blacklist-rules', '自动加黑规则');
  await page.getByRole('button', named('新增')).click();
  await textbox(page, '规则名称').fill('结果未知规则');
  await choose(dialog(page), '适用组织', '合成总部');
  await spin(page, '离职次数大于等于（次）').fill('2');
  await choose(dialog(page), '加黑原因', '稳定性差');
  server.override = () => 'abort';
  await dialog(page).getByRole('button', save).click();
  await expect(dialog(page).getByText('处理中 / 结果待确认')).toBeVisible();
  const lockedAgain = async () => {
    await page.getByRole('button', named('新增')).click();
    await expect(dialog(page).getByText('处理中 / 结果待确认')).toBeVisible();
    await expect(dialog(page).getByRole('button', save)).toBeDisabled();
    await dialog(page).getByRole('button', named('取消')).click();
    await expect(dialog(page)).toHaveCount(0);
  };
  await dialog(page).getByRole('button', named('取消')).click();
  await lockedAgain();
  await page.getByRole('tab', { name: '黑名单' }).click();
  await expect(page.getByRole('tab', { name: '黑名单', selected: true })).toBeVisible();
  await page.getByRole('tab', { name: '自动加黑规则' }).click();
  await lockedAgain();
  expect(server.writes).toHaveLength(1);
});
