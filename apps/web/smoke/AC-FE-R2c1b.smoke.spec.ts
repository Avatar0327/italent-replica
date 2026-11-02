// FE-R2c1b 试用设置页：试用结果字典、自动转正（B57）、自动发起考核（B58）、考核并行规则（B59）。
// 接口为有状态合成桩，形态按 probation-settings-fixtures.ts（AC-FE-R2c1b-settings 用真实接口核对夹具）。
import type { Locator, Page } from '@playwright/test';
import { actionButton } from './action-button.js';
import { capture, choose, item, named, save, type Write } from './contracts-fixtures.js';
import { expect, snapshotFixture, test, user } from './fixtures.js';
import {
  COPY_SUFFIX,
  PARALLEL_KEYS,
  SWITCH_KEYS,
  assessmentRule,
  department,
  otherSettingsMenu,
  parallelDefault,
  regularizationRule,
  resultCodeTaken,
  resultPresets,
  revisionConflict,
  rowId,
  runDisabled,
  runReceipt,
  setting,
  settingsPermission,
  type ResultRow,
} from './probation-settings-fixtures.js';

const ROOT = '/api/tenant/employment';
const RESULTS = `${ROOT}/probation-results`;
const RULE_PATHS = { regularization: `${ROOT}/auto-regularization-rules`, assessment: `${ROOT}/auto-assessment-rules` };
const RUN_PATHS = { regularization: `${ROOT}/auto-regularization/run`, assessment: `${ROOT}/auto-assessment/run` };
const SETTINGS = '/api/tenant/settings';
type Kind = keyof typeof RULE_PATHS;
type Rule = Record<string, unknown> & {
  id: string;
  name: string;
  priority: number;
  enabled: boolean;
  revision: number;
};
type Reply = { status: number; json: unknown } | 'abort';
const employeeId = '30000000-0000-4000-8000-0000000000b1';
const cursor = 'c1000000-0000-4000-8000-000000000001';

/** 有状态桩：字典 / 两类规则 / 两层配置 / 立即执行，写入都按 If-Match 核对版本，回执为整行（整份配置）。 */
async function setup(page: Page, { admin = true } = {}) {
  const server = {
    results: resultPresets(),
    rules: { regularization: [] as Rule[], assessment: [] as Rule[] },
    settings: new Map<string, { value: unknown; revision: number }>(),
    writes: [] as Write[],
    override: undefined as ((write: Write) => Reply | undefined) | undefined,
  };
  await page.route('**/permission/me/snapshot', (route) => {
    const body = structuredClone(snapshotFixture);
    if (admin) body.adminMenus = [...body.adminMenus, otherSettingsMenu];
    return route.fulfill({ json: body });
  });
  await page.route('**/permission/me/objects/*', (route) => {
    const code = decodeURIComponent(route.request().url().split('/').at(-1)!);
    if (code !== settingsPermission.objectCode) return route.fallback();
    return admin
      ? route.fulfill({ json: settingsPermission })
      : route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN', message: '无权访问该对象' } } });
  });
  await page.route(/\/org\/organizations(\/[^/?]+)?(\?.*)?$/, (route) =>
    route.fulfill({
      json: route.request().url().includes('?')
        ? { items: [{ id: department, name: 'ZZ_合成试用部门' }] }
        : { id: department, name: 'ZZ_合成试用部门' },
    }),
  );
  const forbidden = { status: 403, json: { error: { code: 'FORBIDDEN', message: '无权访问' } } };
  await page.route(
    (url) =>
      url.pathname.startsWith(RESULTS) || url.pathname.startsWith(`${ROOT}/auto-`) || url.pathname.startsWith(SETTINGS),
    (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (!admin && !path.startsWith(RESULTS)) return route.fulfill(forbidden);
      if (request.method() === 'GET') return route.fulfill({ json: read(server, path) });
      capture(server.writes, request);
      const write = server.writes.at(-1)!;
      const reply = server.override?.(write) ?? apply(server, write);
      return reply === 'abort' ? route.abort('connectionreset') : route.fulfill(reply);
    },
  );
  await page.setViewportSize({ width: 1512, height: 900 });
  await page.goto('/probation-settings');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.waitForURL('**/staff');
  return server;
}
type Server = Awaited<ReturnType<typeof setup>>;

function read(server: Server, path: string) {
  if (path === RESULTS) return { items: [...server.results].sort((a, b) => a.displayOrder - b.displayOrder) };
  for (const kind of ['regularization', 'assessment'] as const)
    if (path === RULE_PATHS[kind]) return { items: [...server.rules[kind]].sort((a, b) => a.priority - b.priority) };
  const key = decodeURIComponent(path.slice(SETTINGS.length + 1));
  return settingOf(server, key);
}
function settingOf(server: Server, key: string) {
  const fallback = Object.values(PARALLEL_KEYS).includes(key as never) ? parallelDefault : false;
  const current = server.settings.get(key) ?? { value: fallback, revision: 0 };
  return setting(key, current.value, current.revision);
}
const conflict: Reply = { status: 409, json: revisionConflict };
function apply(server: Server, write: Write): Reply {
  if (write.path === RESULTS || write.path.startsWith(`${RESULTS}/`)) return applyResult(server, write);
  if (write.path.startsWith(SETTINGS)) {
    const key = decodeURIComponent(write.path.slice(SETTINGS.length + 1));
    const current = settingOf(server, key);
    if (write.revision !== String(current.revision)) return conflict;
    server.settings.set(key, { value: (write.body as { value: unknown }).value, revision: current.revision + 1 });
    return { status: 200, json: settingOf(server, key) };
  }
  const kind: Kind = write.path.includes('assessment') ? 'assessment' : 'regularization';
  if (write.path === RUN_PATHS[kind]) {
    if (settingOf(server, SWITCH_KEYS[kind]).value !== true) return { status: 409, json: runDisabled[kind] };
    const next = (write.body as { cursor?: string }).cursor ? null : cursor;
    return { status: 200, json: runReceipt[kind](employeeId, server.rules[kind][0]?.id ?? rowId(), next) };
  }
  return applyRule(server.rules[kind], write, kind);
}
function applyResult(server: Server, write: Write): Reply {
  const body = write.body as Partial<ResultRow>;
  if (write.method === 'POST') {
    if (server.results.some((row) => row.code.toLowerCase() === body.code!.toLowerCase()))
      return { status: 409, json: resultCodeTaken };
    const created = { id: rowId(), enabled: true, displayOrder: 0, ...body, revision: 1 } as ResultRow;
    server.results.push(created);
    return { status: 201, json: created };
  }
  const row = server.results.find((entry) => write.path.endsWith(`/${entry.id}`));
  if (!row) return { status: 404, json: { error: { code: 'NOT_FOUND', message: '不存在' } } };
  if (write.revision !== String(row.revision)) return conflict;
  Object.assign(row, body, { revision: row.revision + 1 });
  return { status: 200, json: { ...row } };
}
function applyRule(rules: Rule[], write: Write, kind: Kind): Reply {
  const base = RULE_PATHS[kind];
  const fixture = kind === 'regularization' ? regularizationRule : assessmentRule;
  if (write.path === base) {
    const created = fixture({ ...(write.body as object), revision: 1 }) as Rule;
    rules.push(created);
    return { status: 201, json: created };
  }
  const [id, action] = write.path.slice(base.length + 1).split('/');
  const row = rules.find((entry) => entry.id === id);
  if (!row) return { status: 404, json: { error: { code: 'NOT_FOUND', message: '规则不存在' } } };
  if (action === 'copy') {
    const copy = { ...row, id: rowId(), name: `${row.name}${COPY_SUFFIX}`, enabled: false, revision: 1 };
    rules.push(copy);
    return { status: 201, json: copy };
  }
  if (write.revision !== String(row.revision)) return conflict;
  if (write.method === 'DELETE') {
    rules.splice(rules.indexOf(row), 1);
    return { status: 200, json: { id, deleted: true } };
  }
  Object.assign(row, write.body, { revision: row.revision + 1 });
  return { status: 200, json: { ...row } };
}

const TABS = { results: '试用结果', regularization: '自动转正', assessment: '自动发起考核', parallel: '考核并行规则' };
const PATHS = {
  results: 'results',
  regularization: 'auto-regularization',
  assessment: 'auto-assessment',
  parallel: 'parallel',
};
const open = async (page: Page, tab: keyof typeof TABS) => {
  await page.goto(`/probation-settings/${PATHS[tab]}`);
  await expect(page.getByRole('tab', { name: TABS[tab], selected: true })).toBeVisible();
};
const root = (page: Page) => page.locator('.probation-settings');
const table = (page: Page) => root(page).locator('.ant-table-tbody');
const rowOf = (page: Page, text: string) =>
  table(page)
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: text, exact: true }) });
const confirmPop = (page: Page) => page.getByRole('tooltip').getByRole('button', named('确定')).click();
const dialog = (page: Page, name: string): Locator => page.getByRole('dialog', { name, exact: true });
const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const writesOf = (server: Server) =>
  server.writes.map(({ method, path, revision, body }) => [method, path, revision, body]);

test('AC-FE-R2c1b-01 试用结果字典：列出预置项 → 新增（编码重复 409 保留输入）→ 改名 → 停用', async ({ page }) => {
  const server = await setup(page);
  await open(page, 'results');
  await expect(table(page).getByRole('row')).toHaveCount(3);
  await root(page).getByRole('button', named('新增')).click();
  const create = dialog(page, '新增试用结果');
  await expect(item(create, '显示顺序').getByRole('spinbutton')).toHaveValue('40');
  await item(create, '编码').getByRole('textbox').fill('NORMAL');
  await item(create, '名称').getByRole('textbox').fill('ZZ_合成结果');
  await create.getByRole('button', save).click();
  await expect(item(create, '编码').locator('.ant-form-item-explain-error')).toHaveText('编码已存在，请换一个编码');
  await expect(item(create, '名称').getByRole('textbox')).toHaveValue('ZZ_合成结果');
  await item(create, '编码').getByRole('textbox').fill('zz_pass');
  await create.getByRole('button', save).click();
  await expect(create).toHaveCount(0);
  await expect(rowOf(page, 'zz_pass')).toContainText('ZZ_合成结果');
  const id = server.results.find((row) => row.code === 'zz_pass')!.id;

  await rowOf(page, 'zz_pass').getByRole('button', named('编辑')).click();
  const edit = dialog(page, '编辑试用结果');
  await expect(item(edit, '编码').getByRole('textbox')).toHaveCount(0);
  await item(edit, '名称').getByRole('textbox').fill('ZZ_改名结果');
  await edit.getByRole('button', save).click();
  await expect(edit).toHaveCount(0);
  await expect(rowOf(page, 'zz_pass')).toContainText('ZZ_改名结果');
  await rowOf(page, 'zz_pass').getByRole('button', named('停用')).click();
  await confirmPop(page);
  await expect(rowOf(page, 'zz_pass')).toContainText('已停用');
  const created = { name: 'ZZ_合成结果', enabled: true, displayOrder: 40 };
  expect(writesOf(server)).toEqual([
    ['POST', RESULTS, '0', { code: 'NORMAL', ...created }],
    ['POST', RESULTS, '0', { code: 'zz_pass', ...created }],
    ['PUT', `${RESULTS}/${id}`, '1', { name: 'ZZ_改名结果' }],
    ['PUT', `${RESULTS}/${id}`, '2', { enabled: false }],
  ]);
  expect(new Set(server.writes.map((write) => write.command)).size).toBe(server.writes.length);
});

async function fillRule(page: Page, form: Locator, kind: Kind) {
  await item(form, '规则名称').getByRole('textbox').fill(`ZZ_${TABS[kind]}规则`);
  await item(form, '优先级').getByRole('spinbutton').fill('2');
  await choose(form, '适用组织', 'ZZ_合成试用部门');
  await page.keyboard.press('Escape');
  if (kind === 'regularization') {
    await choose(form, '业务处理规则', '自动发起转正申请');
    await item(form, '试用期到期前天数').getByRole('spinbutton').fill('0');
    await choose(form, '试用结果', '正常转正');
  } else {
    await choose(form, '考核类型', '试用中考核');
    await item(form, '入职后天数').getByRole('spinbutton').fill('30');
  }
  await choose(form, '发起人', '当前管理员');
}

test('AC-FE-R2c1b-02 自动转正：打开总开关 → 新增规则 → 编辑整份提交 → 复制 → 停用 → 删除', async ({ page }) => {
  const server = await setup(page);
  await open(page, 'regularization');
  const panel = region(page, '自动转正');
  await expect(panel.getByRole('switch', { name: '自动转正' })).not.toBeChecked();
  await panel.getByRole('switch', { name: '自动转正' }).click();
  await panel.getByRole('button', save).click();
  await expect(panel.getByRole('switch', { name: '自动转正' })).toBeChecked();

  await root(page).getByRole('button', named('新增')).click();
  const create = dialog(page, '新增自动转正规则');
  await item(create, '试用期到期前天数').getByRole('spinbutton').fill('1000');
  await create.getByRole('button', save).click();
  await expect(item(create, '试用期到期前天数').locator('.ant-form-item-explain-error')).toHaveText(
    '请设置0至999的整数',
  );
  await fillRule(page, create, 'regularization');
  await create.getByRole('button', save).click();
  await expect(create).toHaveCount(0);
  const name = 'ZZ_自动转正规则';
  await expect(rowOf(page, name)).toContainText('ZZ_合成试用部门');
  await expect(rowOf(page, name)).toContainText('自动发起转正申请');
  const id = server.rules.regularization[0]!.id;

  await rowOf(page, name).getByRole('button', named('编辑')).click();
  const edit = dialog(page, '编辑自动转正规则');
  await item(edit, '试用期到期前天数').getByRole('spinbutton').fill('3');
  await edit.getByRole('button', save).click();
  await expect(edit).toHaveCount(0);
  await rowOf(page, name).getByRole('button', named('复制')).click();
  await confirmPop(page);
  await expect(rowOf(page, `${name}${COPY_SUFFIX}`)).toContainText('已停用');
  const copy = server.rules.regularization[1]!.id;
  await rowOf(page, name).getByRole('button', named('停用')).click();
  await confirmPop(page);
  await expect(rowOf(page, name)).toContainText('已停用');
  await rowOf(page, `${name}${COPY_SUFFIX}`).getByRole('button', named('删除')).click();
  await confirmPop(page);
  await expect(rowOf(page, `${name}${COPY_SUFFIX}`)).toHaveCount(0);

  const body = {
    name,
    priority: 2,
    orgIds: [department],
    includeSubordinates: true,
    initiatorType: 'rule_operator',
    enabled: true,
    mode: 'application',
    daysBefore: 0,
    probationResult: 'normal',
  };
  const path = RULE_PATHS.regularization;
  expect(writesOf(server)).toEqual([
    ['PUT', `${SETTINGS}/${encodeURIComponent(SWITCH_KEYS.regularization)}`, '0', { value: true }],
    ['POST', path, '0', body],
    // 整份严格提交：未改项（含 enabled / includeSubordinates / probationResult）一并带上。
    ['PUT', `${path}/${id}`, '1', { ...body, daysBefore: 3 }],
    ['POST', `${path}/${id}/copy`, '0', {}],
    ['PUT', `${path}/${id}/enabled`, '2', { enabled: false }],
    ['DELETE', `${path}/${copy}`, '1', {}],
  ]);
});

test('AC-FE-R2c1b-03 立即执行：开关关闭明确拒绝；打开后显示回执并可续跑；结果未知只读锁定', async ({ page }) => {
  const server = await setup(page);
  server.rules.regularization.push(regularizationRule() as Rule);
  await open(page, 'regularization');
  const run = actionButton(root(page), '立即执行');
  await run.click();
  await confirmPop(page);
  await expect(page.getByText('自动转正未开启')).toBeVisible();
  server.settings.set(SWITCH_KEYS.regularization, { value: true, revision: 1 });
  await run.click();
  await confirmPop(page);
  const result = region(page, '执行结果');
  await expect(result).toContainText('2026-10-01');
  await expect(result).toContainText('已发起 1 人');
  await expect(result).toContainText('本次未扫描完，可继续执行。');
  await result.getByRole('button', named('继续执行')).click();
  await expect(result).toContainText('本次已扫描完。');
  expect(writesOf(server)).toEqual([
    ['POST', RUN_PATHS.regularization, '0', {}],
    ['POST', RUN_PATHS.regularization, '0', {}],
    ['POST', RUN_PATHS.regularization, '0', { cursor }],
  ]);

  server.override = () => 'abort';
  await run.click();
  await confirmPop(page);
  await expect(page.getByText('上次执行结果待确认，请刷新页面核对后再执行')).toBeVisible();
  await expect(run).toBeDisabled();
  await page.getByRole('tab', { name: '试用结果' }).click();
  await page.getByRole('tab', { name: '自动转正' }).click();
  await expect(actionButton(root(page), '立即执行')).toBeDisabled();
  expect(server.writes).toHaveLength(4);
});

test('AC-FE-R2c1b-04 自动发起考核：新增 → 编辑遇版本冲突重读后按最新版本整份重提', async ({ page }) => {
  const server = await setup(page);
  await open(page, 'assessment');
  await root(page).getByRole('button', named('新增')).click();
  const create = dialog(page, '新增自动发起考核规则');
  await fillRule(page, create, 'assessment');
  await create.getByRole('button', save).click();
  await expect(create).toHaveCount(0);
  const name = 'ZZ_自动发起考核规则';
  await expect(rowOf(page, name)).toContainText('试用中考核');
  const rule = server.rules.assessment[0]!;

  await rowOf(page, name).getByRole('button', named('编辑')).click();
  const edit = dialog(page, '编辑自动发起考核规则');
  Object.assign(rule, { priority: 7, revision: 2 });
  await item(edit, '入职后天数').getByRole('spinbutton').fill('45');
  await edit.getByRole('button', save).click();
  await expect(edit.getByText('版本冲突：输入已保留')).toBeVisible();
  await actionButton(edit, '重读最新版本').click();
  await edit.getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
  await edit.getByRole('button', save).click();
  await expect(edit).toHaveCount(0);
  const body = {
    name,
    priority: 2,
    orgIds: [department],
    includeSubordinates: true,
    initiatorType: 'rule_operator',
    enabled: true,
    assessmentType: 'probation',
    daysAfterEntry: 30,
  };
  const path = `${RULE_PATHS.assessment}/${rule.id}`;
  expect(writesOf(server)).toEqual([
    ['POST', RULE_PATHS.assessment, '0', body],
    ['PUT', path, '1', { ...body, daysAfterEntry: 45 }],
    // 重读后未改项取最新（他人改的优先级 7），本人改的入职后天数保留。
    ['PUT', path, '2', { ...body, priority: 7, daysAfterEntry: 45 }],
  ]);
});

test('AC-FE-R2c1b-05 考核并行规则：打开开关出现多选，按候选提交；关闭时 allowed 提交空', async ({ page }) => {
  const server = await setup(page);
  await open(page, 'parallel');
  const panel = region(page, '转正考核审批中时允许发起');
  const toggle = panel.getByRole('switch', { name: '转正考核审批中时允许发起' });
  await expect(toggle).not.toBeChecked();
  await expect(panel.getByRole('checkbox')).toHaveCount(0);
  await toggle.click();
  await expect(panel.getByRole('checkbox')).toHaveCount(2);
  await panel.getByRole('checkbox', { name: '转正', exact: true }).check();
  await panel.getByRole('button', save).click();
  await expect(panel.getByRole('checkbox', { name: '转正', exact: true })).toBeChecked();
  await toggle.click();
  await panel.getByRole('button', save).click();
  await expect(panel.getByRole('checkbox')).toHaveCount(0);
  const path = `${SETTINGS}/${encodeURIComponent(PARALLEL_KEYS.regularization_assessment)}`;
  expect(writesOf(server)).toEqual([
    ['PUT', path, '0', { value: { enabled: true, allowed: ['regularization'] } }],
    ['PUT', path, '1', { value: { enabled: false, allowed: [] } }],
  ]);
  const other = region(page, '试用中考核审批中时允许发起');
  await other.getByRole('switch', { name: '试用中考核审批中时允许发起' }).click();
  await expect(other.getByRole('checkbox')).toHaveCount(3);
});

test('AC-FE-R2c1b-06 无配置权限：字典只读，规则与配置页签明确提示无权，不出现任何写入口', async ({ page }) => {
  const server = await setup(page, { admin: false });
  await open(page, 'results');
  await expect(table(page).getByRole('row')).toHaveCount(3);
  await expect(root(page).getByText('当前账号没有修改试用设置的权限，以下内容只读。')).toBeVisible();
  for (const tab of ['results', 'regularization', 'assessment', 'parallel'] as const) {
    await open(page, tab);
    for (const name of ['新增', '编辑', '停用', '复制', '删除', '立即执行', '保存'])
      await expect(root(page).getByRole('button', named(name))).toHaveCount(0);
  }
  await open(page, 'regularization');
  await expect(root(page).getByText('无权访问').first()).toBeVisible();
  expect(server.writes).toEqual([]);
});
