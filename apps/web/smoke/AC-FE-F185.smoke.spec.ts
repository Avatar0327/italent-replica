import type { Page } from '@playwright/test';
import { test, expect, user } from './fixtures.js';
import { mockInfo, infoId, positionId } from './f154-fixtures.js';

const targets = ['targetProfessionalLineId', 'targetLevelId', 'targetPostId'];
const labels = ['发展条线', '拟晋升职级', '拟晋升职务'];
const kinds = ['professional-lines', 'levels', 'posts'];
const jobId = (n: number) => `c1850000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const allFields = [
  'employeeId',
  'startDate',
  'endDate',
  'strengths',
  'developmentItems',
  'targetPositionId',
  ...targets,
  'currentLevelId',
  'currentPositionId',
  'currentPostId',
];
async function setup(page: Page, options: Parameters<typeof mockInfo>[1] = {}) {
  const calls = await mockInfo(page, {
    ...options,
    careerValues: {
      ...Object.fromEntries(targets.map((key) => [key, jobId(201)])),
      currentLevelId: jobId(1),
      currentPositionId: positionId,
      currentPostId: jobId(2),
      currentPostName: '合成快照职务',
      ...options.careerValues,
    },
  });
  const queries: URL[] = [];
  await page.route(/\/api\/tenant\/job\/(professional-lines|levels|posts|level-types)(\/|\?|$)/, (route) => {
    const url = new URL(route.request().url());
    queries.push(url);
    const [kind, id] = url.pathname.split('/').slice(4);
    const index = kinds.indexOf(kind!);
    const prefix = index < 0 ? '合成类别' : labels[index];
    const rows = Array.from({ length: kind === 'level-types' ? 2 : 232 }, (_, i) => ({
      id: jobId(i + 1),
      name: kind === 'posts' && i === 1 ? '合成停用职务' : `${prefix}${i + 1}`,
      revision: 1,
      enabled: i !== 1,
      displayOrder: i + 1,
      levelTypeId: jobId((i % 2) + 1),
      level: i + 1,
    }));
    const visible = url.searchParams.get('enabled') === 'true' ? rows.filter((r) => r.enabled) : rows;
    const pageNo = Number(url.searchParams.get('page') ?? 1);
    const size = Number(url.searchParams.get('pageSize') ?? 200);
    return route.fulfill({
      json: id
        ? rows.find((r) => r.id === id)
        : {
            items: visible.slice((pageNo - 1) * size, pageNo * size),
            page: pageNo,
            pageSize: size,
            today: '2026-10-18',
            hasDataPermission: true,
          },
    });
  });
  return { calls, queries };
}
async function enter(page: Page) {
  await page.goto('/');
  await page.getByLabel('切换演示身份').selectOption(user);
  await expect(page).toHaveURL(/\/staff$/);
  await page.goto('/idp/careers');
}
async function edit(page: Page) {
  await page.getByRole('button', { name: '编辑', exact: true }).first().click();
}
async function choose(page: Page, label: string, name: string) {
  const input = page.getByRole('dialog').getByLabel(label, { exact: true });
  await input.fill(name);
  await page
    .locator('.ant-select-dropdown:visible .ant-select-item-option-content')
    .getByText(name, { exact: true })
    .click();
}
async function save(page: Page) {
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /保\s*存/ })
    .click();
}

async function mockLevelSorting(
  page: Page,
  levels: Record<string, unknown>[],
  categories: Record<string, unknown>[] = [],
) {
  const queries: URL[] = [];
  await page.route(/\/api\/tenant\/job\/(levels|level-types)\?/, (route) => {
    const url = new URL(route.request().url());
    queries.push(url);
    const rows = url.pathname.endsWith('/levels') ? levels : categories;
    // 职务主数据接口默认只返回启用项；includeDisabled=true 才包含授权范围内的停用项。
    const enabled = url.searchParams.get('enabled');
    const items = rows.filter((row) =>
      enabled === null && url.searchParams.get('includeDisabled') === 'true'
        ? true
        : row.enabled === (enabled !== 'false'),
    );
    return route.fulfill({
      json: { items, page: 1, pageSize: 200, today: '2026-10-18', hasDataPermission: true },
    });
  });
  return queries;
}

test('AC-FE-F185-03 新建选择跨页三目标，只提交目标字段', async ({ page }) => {
  const { calls, queries } = await setup(page);
  await enter(page);
  await page
    .locator('.page-heading')
    .getByRole('button', { name: /新\s*建/ })
    .click();
  const dialog = page.getByRole('dialog');
  for (const target of targets) await expect(dialog.locator(`.info-field-${target}`)).toContainText('请选择');
  await choose(page, '发展员工', '合成员工甲');
  for (const [label, value] of [
    ['开始时间', '2027-01-01'],
    ['结束时间', '2027-02-01'],
  ]) {
    const input = dialog.getByRole('group', { name: label, exact: true }).getByRole('textbox');
    await input.fill(value!);
    await input.press('Enter');
  }
  for (const label of labels) {
    await choose(page, label, `${label}232`);
    await expect(dialog.getByText(`${label}232`, { exact: true })).toBeVisible();
  }
  await save(page);
  await expect(dialog).toBeHidden();
  expect(calls[0]!.body).toMatchObject(Object.fromEntries(targets.map((key) => [key, jobId(232)])));
  expect(Object.keys(calls[0]!.body).filter((key) => key.startsWith('current'))).toEqual([]);
  for (const kind of kinds) {
    const pages = queries.filter((url) => url.pathname.endsWith(kind) && url.searchParams.has('page'));
    expect(pages.some((url) => url.searchParams.get('page') === '2')).toBe(true);
    expect(pages.every((url) => url.searchParams.get('enabled') === 'true')).toBe(true);
    expect(pages.every((url) => !url.searchParams.has('orgId') && !url.searchParams.has('professionalLineId'))).toBe(
      true,
    );
  }
});

test('AC-FE-F185-04 编辑回显、清空发 null，当前三列只读且使用记录快照', async ({ page }) => {
  const { calls } = await setup(page);
  await enter(page);
  const table = page.getByRole('table');
  for (const name of ['拟晋升职级1', '合成轮岗职位', '合成快照职务']) await expect(table).toContainText(name);
  await edit(page);
  const dialog = page.getByRole('dialog');
  for (const label of ['当前职级', '当前职位', '当前职务'])
    await expect(dialog.getByText(label, { exact: true })).toHaveCount(0);
  for (const [i, label] of labels.entries()) {
    await expect(dialog).toContainText(`${label}201`);
    const control = dialog.locator(`.info-field-${targets[i]}`);
    await control.hover();
    await control.locator('.ant-select-clear').click();
  }
  await save(page);
  await expect(dialog).toBeHidden();
  expect(calls[0]!.body).toEqual(Object.fromEntries(targets.map((key) => [key, null])));
});

test('AC-FE-F185-05 裁剪字段不展示不查询，记录保留；无编辑权只读', async ({ page }) => {
  const { calls, queries } = await setup(page, {
    fields: {
      'IDP.Career': {
        viewable: allFields.filter(
          (f) => !['currentLevelId', 'currentPositionId', 'currentPostId', 'targetPostId'].includes(f),
        ),
        editable: ['strengths'],
      },
    },
  });
  await enter(page);
  await expect(page.getByText('共4条', { exact: true })).toBeVisible();
  for (const label of ['当前职级', '当前职位', '当前职务', '拟晋升职务'])
    await expect(page.getByRole('columnheader', { name: label, exact: true })).toHaveCount(0);
  await edit(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('发展条线201');
  await expect(dialog.locator('.info-field-targetProfessionalLineId .ant-select-disabled')).toBeVisible();
  await expect(dialog.getByText('拟晋升职务', { exact: true })).toHaveCount(0);
  await dialog.getByLabel('优势项', { exact: true }).fill('合成更新');
  await save(page);
  await expect(dialog).toBeHidden();
  expect(calls[0]!.body).toEqual({ strengths: '合成更新' });
  expect(queries.some((url) => url.pathname.endsWith(`/levels/${jobId(1)}`))).toBe(false);
});

test('AC-FE-F185-06 空快照显示空值，不从实时任职回填', async ({ page }) => {
  await setup(page, {
    careerValues: { currentLevelId: null, currentPositionId: null, currentPostId: null, currentPostName: null },
  });
  let currentReads = 0;
  await page.route('**/api/tenant/employment/employees/*/records**', (route) => {
    currentReads++;
    return route.fulfill({
      json: {
        items: [
          { id: infoId, revision: 1, isCurrent: true, fields: { levelId: jobId(1), positionId, postId: jobId(2) } },
        ],
        page: 1,
        pageSize: 200,
      },
    });
  });
  await enter(page);
  const row = page.locator(`tr[data-row-key="${infoId}"]`);
  await expect(page.getByRole('columnheader', { name: '当前职务', exact: true })).toBeVisible();
  const headers = await page.getByRole('columnheader').allTextContents();
  for (const label of ['当前职级', '当前职位', '当前职务']) {
    await expect(row.locator('td').nth(headers.indexOf(label))).toHaveText('--');
  }
  expect(currentReads).toBe(0);
});

test('AC-FE-F185-07 409 重读保留已改目标、回填未改目标并用新 revision 重提', async ({ page }) => {
  const { calls } = await setup(page, { conflictTimes: 1, conflictValues: { targetPostId: jobId(202) } });
  await enter(page);
  await edit(page);
  await choose(page, '发展条线', '发展条线203');
  await save(page);
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '重读最新版本' }).click();
  await expect(dialog).toContainText('拟晋升职务202');
  await expect(dialog).toContainText('发展条线203');
  await dialog.getByRole('button', { name: '已核对差异，继续编辑' }).click();
  await save(page);
  await expect(dialog).toBeHidden();
  expect(calls.map((c) => c.revision)).toEqual(['1', '2']);
  expect(calls[1]!.body).toEqual({ targetProfessionalLineId: jobId(203) });
});

test('AC-FE-F185-08 新字段结果未知换页重开仍锁定原单', async ({ page }) => {
  const { calls } = await setup(page, { writeStatus: 503 });
  await enter(page);
  await edit(page);
  await choose(page, '拟晋升职级', '拟晋升职级203');
  await save(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('结果待确认');
  await dialog.getByRole('button', { name: /取\s*消/ }).click();
  await page.getByRole('menuitem', { name: '轮岗信息', exact: true }).click();
  await page.getByRole('menuitem', { name: '职业发展信息', exact: true }).click();
  await edit(page);
  await expect(dialog.getByRole('button', { name: /保\s*存/ })).toBeDisabled();
  expect(calls).toHaveLength(1);
  expect(calls[0]!.path).toContain(infoId);
});

test('AC-FE-F185-09 职级按类别与级别排序，停用项不进入候选', async ({ page }) => {
  await setup(page, { careerValues: { targetLevelId: null } });
  await enter(page);
  await edit(page);
  await page.getByRole('dialog').getByLabel('拟晋升职级', { exact: true }).fill('拟晋升职级');
  const options = page.locator('.ant-select-dropdown:visible .ant-select-item-option-content');
  await expect(options.first()).toHaveText('拟晋升职级1');
  await expect(options.nth(1)).toHaveText('拟晋升职级3');
  await expect(options.nth(2)).toHaveText('拟晋升职级5');
  await page.getByRole('dialog').getByLabel('拟晋升职级', { exact: true }).fill('拟晋升职级2');
  await expect(options.getByText('拟晋升职级2', { exact: true })).toHaveCount(0);
});

test('AC-FE-F185-10 已保存的停用目标可回显，但不重新加入启用候选', async ({ page }) => {
  const { queries } = await setup(page, { careerValues: { targetPostId: jobId(2) } });
  await enter(page);
  await edit(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.info-field-targetPostId')).toContainText('合成停用职务');
  await dialog.getByLabel('拟晋升职务', { exact: true }).fill('合成停用职务');
  const options = page.locator('.ant-select-dropdown:visible .ant-select-item-option-content');
  await expect
    .poll(() => queries.some((url) => url.pathname.endsWith('/posts') && url.searchParams.get('page') === '2'))
    .toBe(true);
  await expect(options.getByText('合成停用职务', { exact: true })).toHaveCount(0);
});

test('AC-FE-F185-11 当前快照查看权独立于员工字段，裁剪员工不吞记录', async ({ page }) => {
  await setup(page, {
    fields: {
      'IDP.Career': {
        viewable: ['startDate', 'endDate', 'currentLevelId', 'currentPositionId', 'currentPostId'],
        editable: [],
      },
    },
  });
  await enter(page);
  await expect(page.getByText('共4条', { exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '发展员工', exact: true })).toHaveCount(0);
  for (const value of ['拟晋升职级1', '合成轮岗职位', '合成快照职务'])
    await expect(page.getByRole('table')).toContainText(value);
});

test('AC-FE-F185-12 停用类别下仍启用的职级按类别顺序展示且可选择', async ({ page }) => {
  const { calls } = await setup(page, { careerValues: { targetLevelId: null } });
  const categories = ['A', 'B', 'C'].map((name, i) => ({
    id: jobId(i + 1),
    name,
    revision: 1,
    enabled: name !== 'B',
    displayOrder: i + 1,
  }));
  const levels = [...categories].reverse().map((category, i) => ({
    id: jobId(i + 10),
    name: `合成职级${category.name}`,
    revision: 1,
    enabled: true,
    levelTypeId: category.id,
    level: 1,
  }));
  const queries = await mockLevelSorting(page, levels, categories);
  await enter(page);
  await edit(page);
  await page.getByRole('dialog').getByLabel('拟晋升职级', { exact: true }).fill('合成职级');
  const options = page.locator('.ant-select-dropdown:visible .ant-select-item-option-content');
  await expect(options).toHaveText(['合成职级A', '合成职级B', '合成职级C']);
  await options.getByText('合成职级B', { exact: true }).click();
  await save(page);
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(calls[0]!.body).toEqual({ targetLevelId: jobId(11) });
  expect(
    queries
      .filter((url) => url.pathname.endsWith('/levels'))
      .every((url) => url.searchParams.get('enabled') === 'true'),
  ).toBe(true);
});

test('AC-FE-F185-13 显式空类别的职级仍按数值级别升序展示', async ({ page }) => {
  await setup(page, { careerValues: { targetLevelId: null } });
  await mockLevelSorting(
    page,
    [10, 1].map((level) => ({
      id: jobId(level + 10),
      name: `合成空类别职级${level}`,
      revision: 1,
      enabled: true,
      levelTypeId: null,
      level,
    })),
  );
  await enter(page);
  await edit(page);
  await page.getByRole('dialog').getByLabel('拟晋升职级', { exact: true }).fill('合成空类别');
  await expect(page.locator('.ant-select-dropdown:visible .ant-select-item-option-content')).toHaveText([
    '合成空类别职级1',
    '合成空类别职级10',
  ]);
});

for (const trimmed of ['levelTypeId', 'level']) {
  test(`AC-FE-F185-14 裁剪 ${trimmed} 时不使用该字段排序`, async ({ page }) => {
    await setup(page, { careerValues: { targetLevelId: null } });
    await mockLevelSorting(
      page,
      [10, 1].map((level) =>
        Object.fromEntries(
          Object.entries({
            id: jobId(level + 10),
            name: `合成裁剪职级${level}`,
            revision: 1,
            enabled: true,
            levelTypeId: null,
            level,
          }).filter(([key]) => key !== trimmed),
        ),
      ),
    );
    await enter(page);
    await edit(page);
    await page.getByRole('dialog').getByLabel('拟晋升职级', { exact: true }).fill('合成裁剪');
    await expect(page.locator('.ant-select-dropdown:visible .ant-select-item-option-content')).toHaveText([
      '合成裁剪职级10',
      '合成裁剪职级1',
    ]);
  });
}

test('AC-FE-F185-15 空10 / A / 空1 混合时仍按组内级别升序', async ({ page }) => {
  await setup(page, { careerValues: { targetLevelId: null } });
  await mockLevelSorting(
    page,
    [
      { id: jobId(10), name: '合成空类别10', enabled: true, levelTypeId: null, level: 10, displayOrder: 1 },
      { id: jobId(11), name: '合成类别A1', enabled: true, levelTypeId: jobId(1), level: 1, displayOrder: 2 },
      { id: jobId(12), name: '合成空类别1', enabled: true, levelTypeId: null, level: 1, displayOrder: 3 },
    ],
    [{ id: jobId(1), name: '合成类别A', enabled: true, displayOrder: 1 }],
  );
  await enter(page);
  await edit(page);
  await page.getByRole('dialog').getByLabel('拟晋升职级', { exact: true }).fill('合成');
  await expect(page.locator('.ant-select-dropdown:visible .ant-select-item-option-content')).toHaveText([
    '合成类别A1',
    '合成空类别1',
    '合成空类别10',
  ]);
});

test('AC-FE-F185-16 有类别 / 空类别 / 缺键混合时类别为 A、B、C，缺键项原位保留', async ({ page }) => {
  await setup(page, { careerValues: { targetLevelId: null } });
  const levels = [
    { name: '合成类别C1', levelTypeId: jobId(3), level: 1 },
    { name: '合成裁剪类别', level: 9 },
    { name: '合成空类别10', levelTypeId: null, level: 10 },
    { name: '合成类别A1', levelTypeId: jobId(1), level: 1 },
    { name: '合成类别B1', levelTypeId: jobId(2), level: 1 },
    { name: '合成空类别1', levelTypeId: null, level: 1 },
  ].map((value, i) => ({ ...value, id: jobId(i + 10), enabled: true, revision: 1, displayOrder: i + 1 }));
  const categories = ['A', 'B', 'C'].map((name, i) => ({
    id: jobId(i + 1),
    name: `合成类别${name}`,
    enabled: name !== 'B',
    revision: 1,
    displayOrder: i + 1,
  }));
  await mockLevelSorting(page, levels, categories);
  await enter(page);
  await edit(page);
  await page.getByRole('dialog').getByLabel('拟晋升职级', { exact: true }).fill('合成');
  await expect(page.locator('.ant-select-dropdown:visible .ant-select-item-option-content')).toHaveText([
    '合成类别A1',
    '合成裁剪类别',
    '合成类别B1',
    '合成类别C1',
    '合成空类别1',
    '合成空类别10',
  ]);
});
