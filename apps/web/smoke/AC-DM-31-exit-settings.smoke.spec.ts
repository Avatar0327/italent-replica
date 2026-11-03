import { actionButton } from './action-button.js';
// R2-T03 FE2b：离职类型 / 离职原因 / 离职去向三个字典设置页（接口全部为合成桩，形态按 exit-dictionaries.ts）。
import { test, expect, user } from './fixtures.js';
import type { Locator, Page } from '@playwright/test';
import { capture, item, named, save, type Write } from './contracts-fixtures.js';
import { presetRows, rowId, settingsPermission, type EntryRow, type Kind } from './exit-fixtures.js';

const base = '/api/tenant/employment/exits/dictionaries';
const labels: [Kind, string][] = [
  ['types', '离职类型'],
  ['reasons', '离职原因'],
  ['whereabouts', '离职去向'],
];
type Reply = { status: number; json: unknown } | 'abort';
type Override = (write: Write, row?: EntryRow) => Reply | undefined;

/** 有状态的字典桩：按显示顺序、编码排列；新增查重不分大小写；修改按 If-Match 核对版本，回执为整行。 */
async function setupExit(page: Page, { admin = true } = {}) {
  const rows: Record<Kind, EntryRow[]> = {
    types: presetRows('types'),
    reasons: presetRows('reasons'),
    whereabouts: presetRows('whereabouts'),
  };
  const server = { rows, writes: [] as Write[], override: undefined as Override | undefined };
  await page.route('**/permission/me/objects/*', (route) => {
    const code = decodeURIComponent(route.request().url().split('/').at(-1)!);
    if (code !== settingsPermission.objectCode) return route.fallback();
    return admin
      ? route.fulfill({ json: settingsPermission })
      : route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN', message: '无权访问该对象' } } });
  });
  await page.route(
    (url) => url.pathname.startsWith(`${base}/`),
    (route) => {
      const request = route.request();
      const [kind, id] = new URL(request.url()).pathname.slice(base.length + 1).split('/') as [Kind, string?];
      const list = rows[kind];
      if (request.method() === 'GET') {
        const items = [...list].sort((a, b) => a.displayOrder - b.displayOrder || a.code.localeCompare(b.code));
        return route.fulfill({ json: { items } });
      }
      capture(server.writes, request);
      const write = server.writes.at(-1)!;
      const row = list.find((entry) => entry.id === id);
      const reply = server.override?.(write, row) ?? apply(list, write, row);
      return reply === 'abort' ? route.abort('connectionreset') : route.fulfill(reply);
    },
  );
  await page.setViewportSize({ width: 1512, height: 754 });
  await page.goto('/exit-settings');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.waitForURL('**/staff');
  return server;
}
function apply(list: EntryRow[], write: Write, row?: EntryRow): Reply {
  const body = write.body as Partial<EntryRow>;
  if (write.method === 'POST') {
    if (list.some((entry) => entry.code.toLowerCase() === body.code!.toLowerCase()))
      return {
        status: 409,
        json: {
          error: { code: 'CONFLICT', message: '离职字典编码已存在', details: { reason: 'EXIT_DICTIONARY_CODE_TAKEN' } },
        },
      };
    const created = { id: rowId(), enabled: true, displayOrder: 0, ...body, revision: 1 } as EntryRow;
    list.push(created);
    return { status: 201, json: created };
  }
  if (!row) return { status: 404, json: { error: { code: 'NOT_FOUND' } } };
  if (write.revision !== String(row.revision))
    return { status: 409, json: { error: { code: 'REVISION_CONFLICT', message: '版本冲突' } } };
  Object.assign(row, body, { revision: row.revision + 1 });
  return { status: 200, json: { ...row } };
}
const open = async (page: Page, kind: Kind) => {
  await page.goto(`/exit-settings/${kind}`);
  await expect(page.getByRole('tab', { name: labels.find(([k]) => k === kind)![1], selected: true })).toBeVisible();
};
const table = (page: Page) => page.locator('.exit-settings .ant-table-tbody');
// 按编码列整格匹配：voluntary 是 involuntary 的子串。
const rowOf = (page: Page, code: string) =>
  table(page)
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: code, exact: true }) });
const confirmPop = (page: Page) => page.getByRole('tooltip').getByRole('button', named('确定')).click();
const codes = (page: Page) => table(page).locator('tr td:first-child').allInnerTexts();
const dialog = (page: Page, name: string): Locator => page.getByRole('dialog', { name, exact: true });

for (const [kind, label] of labels)
  test(`AC-DM-31-FE2b-01 ${label}：新增（编码重复 409 保留输入）→ 改名 → 停用 → 启用 → 调序`, async ({ page }) => {
    const server = await setupExit(page);
    await open(page, kind);
    const presets = presetRows(kind);
    expect(await codes(page)).toEqual(presets.map((row) => row.code));
    const order = presets.length * 10 + 10;
    await page.getByRole('button', named('新增')).click();
    const create = dialog(page, `新增${label}`);
    // 显示顺序默认排在最后；编码与已有项只差大小写也算重复（后端不分大小写）。
    await expect(item(create, '显示顺序').getByRole('spinbutton')).toHaveValue(String(order));
    await item(create, '编码').getByRole('textbox').fill(presets[0]!.code.toUpperCase());
    await item(create, '名称').getByRole('textbox').fill('合成新增项');
    await create.getByRole('button', save).click();
    await expect(item(create, '编码').locator('.ant-form-item-explain-error')).toHaveText('编码已存在，请换一个编码');
    await expect(item(create, '名称').getByRole('textbox')).toHaveValue('合成新增项');
    await item(create, '编码').getByRole('textbox').fill('fe2b_new');
    await create.getByRole('button', save).click();
    await expect(create).toHaveCount(0);
    expect(await codes(page)).toEqual([...presets.map((row) => row.code), 'fe2b_new']);
    const id = server.rows[kind].find((row) => row.code === 'fe2b_new')!.id;

    await rowOf(page, 'fe2b_new').getByRole('button', named('编辑')).click();
    const edit = dialog(page, `编辑${label}`);
    // 编码保存后不可改：只读显示，不提交。
    await expect(item(edit, '编码').getByRole('textbox')).toHaveCount(0);
    await expect(item(edit, '编码')).toContainText('fe2b_new');
    await item(edit, '名称').getByRole('textbox').fill('合成改名项');
    await edit.getByRole('button', save).click();
    await expect(edit).toHaveCount(0);
    await expect(rowOf(page, 'fe2b_new')).toContainText('合成改名项');

    await rowOf(page, 'fe2b_new').getByRole('button', named('停用')).click();
    await confirmPop(page);
    await expect(rowOf(page, 'fe2b_new')).toContainText('已停用');
    await rowOf(page, 'fe2b_new').getByRole('button', named('启用')).click();
    await confirmPop(page);
    await expect(rowOf(page, 'fe2b_new')).not.toContainText('已停用');
    await expect(rowOf(page, 'fe2b_new').getByRole('button', named('停用'))).toBeVisible();

    await rowOf(page, 'fe2b_new').getByRole('button', named('上移')).click();
    const codesAfter = [...presets.slice(0, -1), { code: 'fe2b_new' }, presets.at(-1)!].map((row) => row.code);
    await expect.poll(() => codes(page)).toEqual(codesAfter);
    const path = `${base}/${kind}`;
    const target = (presets.length - 1) * 10 + 5;
    expect(server.writes.map(({ method, path: at, revision, body }) => [method, at, revision, body])).toEqual([
      [
        'POST',
        path,
        '0',
        { code: presets[0]!.code.toUpperCase(), name: '合成新增项', enabled: true, displayOrder: order },
      ],
      ['POST', path, '0', { code: 'fe2b_new', name: '合成新增项', enabled: true, displayOrder: order }],
      ['PUT', `${path}/${id}`, '1', { name: '合成改名项' }],
      ['PUT', `${path}/${id}`, '2', { enabled: false }],
      ['PUT', `${path}/${id}`, '3', { enabled: true }],
      ['PUT', `${path}/${id}`, '4', { displayOrder: target }],
    ]);
    // 明确拒绝后改正重提是新命令；每个写命令一个命令编号。
    expect(new Set(server.writes.map((write) => write.command)).size).toBe(server.writes.length);
  });

test('AC-DM-31-FE2b-02 非管理员只读：照常列出（停用项标“已停用”），不显示新增 / 编辑 / 停用 / 启用 / 调序', async ({
  page,
}) => {
  const server = await setupExit(page, { admin: false });
  server.rows.reasons[1]!.enabled = false;
  for (const [kind] of labels) {
    await open(page, kind);
    await expect(table(page).getByRole('row')).toHaveCount(server.rows[kind].length);
    for (const name of ['新增', '编辑', '停用', '启用', '上移', '下移'])
      await expect(page.locator('.exit-settings').getByRole('button', named(name))).toHaveCount(0);
  }
  await open(page, 'reasons');
  await expect(rowOf(page, 'family')).toContainText('已停用');
  expect(server.writes).toEqual([]);
});

test('AC-DM-31-FE2b-03 改名遇版本冲突：重读核对差异后按最新版本重提，只带本人改过的字段', async ({ page }) => {
  const server = await setupExit(page);
  await open(page, 'types');
  const target = server.rows.types[0]!;
  await rowOf(page, target.code).getByRole('button', named('编辑')).click();
  const edit = dialog(page, '编辑离职类型');
  // 打开后他人改了名称与显示顺序。
  Object.assign(target, { name: '他人改名', displayOrder: 5, revision: target.revision + 1 });
  await item(edit, '名称').getByRole('textbox').fill('本人改名');
  await edit.getByRole('button', save).click();
  await expect(edit.getByText('版本冲突：输入已保留')).toBeVisible();
  await actionButton(edit, '重读最新版本').click();
  await expect(edit.locator('.ant-table')).toContainText('他人改名');
  await edit.getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
  await expect(item(edit, '名称').getByRole('textbox')).toHaveValue('本人改名');
  await expect(item(edit, '显示顺序').getByRole('spinbutton')).toHaveValue('5');
  await edit.getByRole('button', save).click();
  await expect(edit).toHaveCount(0);
  expect(server.writes.map(({ revision, body }) => [revision, body])).toEqual([
    ['1', { name: '本人改名' }],
    ['2', { name: '本人改名' }],
  ]);
  await expect(rowOf(page, target.code)).toContainText('本人改名');
});

test('AC-DM-31-FE2b-04 停用结果未知：只读锁定，编辑与调序同样锁定；换字典再回来仍锁定，不另起命令', async ({
  page,
}) => {
  const server = await setupExit(page);
  server.override = (write) => (write.method === 'PUT' ? 'abort' : undefined);
  await open(page, 'whereabouts');
  const code = server.rows.whereabouts[1]!.code;
  await rowOf(page, code).getByRole('button', named('停用')).click();
  await confirmPop(page);
  await expect(rowOf(page, code)).toContainText('处理中 / 结果待确认');
  const locked = async () => {
    await expect(rowOf(page, code).getByRole('button', named('停用'))).toBeDisabled();
    await expect(rowOf(page, code).getByRole('button', named('上移'))).toBeDisabled();
    await rowOf(page, code).getByRole('button', named('编辑')).click();
    const edit = dialog(page, '编辑离职去向');
    await expect(edit.getByText('本对象有未确认的其他操作')).toBeVisible();
    await expect(edit.getByRole('button', save)).toBeDisabled();
    await edit.getByRole('button', named('取消')).click();
  };
  await locked();
  await page.getByRole('tab', { name: '离职类型' }).click();
  await expect(page).toHaveURL(/\/exit-settings\/types$/);
  await page.getByRole('tab', { name: '离职去向' }).click();
  await locked();
  expect(server.writes).toHaveLength(1);
});
