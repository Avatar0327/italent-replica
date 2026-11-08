import type { Page } from '@playwright/test';
import { test, expect, user } from './fixtures.js';
test.use({ viewport: { width: 1440, height: 1000 } });
const id = 'a0000000-0000-4000-8000-000000000001';
const fields = [
  'code',
  'name',
  'status',
  'ownerOrgId',
  'year',
  'period',
  'periodStartDate',
  'periodEndDate',
  'categoryId',
  'sharedOrgIds',
  'calcRuleId',
  'criterionId',
  'downwardPublic',
  'enabled',
  'flowId',
  'modules',
  'steps',
  'permissions',
  'cells',
  'xFieldId',
  'yFieldId',
  'zFieldId',
  'xDraggable',
  'yDraggable',
  'placementSource',
  'greenRateReference',
  'positionFields',
  'axisLevels',
  'ratioGroups',
];
/** 与 apps/api/src/modules/talent-review/matrix-view.ts 的 MatrixView 同形；格子按 xLevelNo / yLevelNo 给出。 */
function matrixItem(cells: { cellNo: number; xLevelNo: number; yLevelNo: number; name: string }[]) {
  return {
    id,
    revision: 1,
    code: 'DEMO_MATRIX',
    name: '合成年度盘点',
    xFieldId: id,
    yFieldId: id,
    zFieldId: null,
    xDraggable: true,
    yDraggable: true,
    placementSource: 'after_else_before',
    greenRateReference: false,
    preset: false,
    sortNo: 1,
    enabled: true,
    createdBy: id,
    createdAt: '2026-10-01T02:00:00.000Z',
    updatedBy: id,
    updatedAt: '2026-10-01T02:00:00.000Z',
    positionFields: [
      { role: 'before', fieldId: id },
      { role: 'after', fieldId: id },
    ],
    axisLevels: [],
    cells: cells.map((cell) => ({
      ...cell,
      color: '#dfeeff',
      textColor: '#1f2329',
      exportOrder: cell.cellNo,
      countsGreen: false,
    })),
    ratioGroups: [],
  };
}
async function routeMatrix(page: Page, cells: Parameters<typeof matrixItem>[0]) {
  const item = matrixItem(cells);
  await page.route(/\/talent-review\/matrices(\/|\?|$)/, (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith(id) ? item : { items: [item], hasDataPermission: true },
    }),
  );
}

test.beforeEach(async ({ page }) => {
  await page.route('**/permission/me/objects/TalentReview.*', (route) =>
    route.fulfill({
      json: {
        objectCode: new URL(route.request().url()).pathname.split('/').at(-1),
        dataOperations: { view: true },
        viewableFields: fields,
        editableFields: fields,
        buttons: ['create', 'update', 'start', 'end', 'restart'].map((buttonCode) => ({
          buttonCode,
          level: buttonCode === 'create' ? 'list' : 'detail',
        })),
      },
    }),
  );
  await page.route('**/api/tenant/talent-review/**', (route) => {
    const url = new URL(route.request().url());
    const item = {
      id,
      revision: 1,
      accessLevel: 'manage',
      code: 'DEMO_REVIEW',
      name: '合成年度盘点',
      status: 'new',
      ownerOrgId: id,
      year: 2026,
      period: '年度',
      periodStartDate: '2026-10-01',
      periodEndDate: '2026-10-31',
      enabled: true,
      createdBy: id,
      createdAt: '2026-10-01T02:00:00.000Z',
      updatedBy: id,
      updatedAt: '2026-10-01T02:00:00.000Z',
      modules: [{ id: 'module-one', name: '合成指标模块', kind: 'indicator', scoring: 'weighted_sum' }],
      steps: [{ nodeKey: 'review', name: '上级评价', stepType: 'evaluate', mode: 'single' }],
      permissions: [{ nodeKey: 'review', roleId: null, moduleName: '合成指标模块', visible: true, weight: 100 }],
      cells: [],
    };
    return route.fulfill({ json: url.pathname.endsWith(id) ? item : { items: [item], hasDataPermission: true } });
  });
});

test('AC-FE-R3c-01 切换演示身份，项目列表、八页签详情与配置抽屉可渲染', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/talent-review');
  await page.getByLabel('切换演示身份').selectOption(user);
  await expect(page).toHaveURL(/\/staff$/);
  await page.getByRole('button', { name: '应用导航' }).click();
  await page.getByRole('dialog', { name: '全部菜单' }).getByRole('link', { name: '人才盘点', exact: true }).click();
  await expect(page.getByRole('button', { name: '合成年度盘点', exact: true })).toBeVisible();
  await expect(page.locator('.page-total')).toBeInViewport();
  await expect
    .soft(page.locator('.review-project-list tbody .ant-table-row').first().getByRole('button'))
    .toHaveText(['合成年度盘点', /编\s*辑/, /结\s*束/, /启\s*动/]);
  await page.getByRole('switch', { name: '注释' }).click();
  await expect(page.locator('.talent-review-page .decision-note')).toContainText('DEC-456');
  await page.getByRole('switch', { name: '注释' }).click();
  await page.screenshot({ path: testInfo.outputPath('list.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '合成年度盘点', exact: true }).click();
  await expect(page.locator('.review-project-detail')).toBeVisible();
  await expect(page.locator('.review-project-detail h1')).toHaveText('合成年度盘点');
  await expect(page.locator('.review-project-list')).toBeHidden();
  for (const tab of [
    '盘点对象',
    '多人评价关系',
    '指标明细',
    '九宫格',
    '组织继任地图',
    '职位继任地图',
    '仪表盘',
    '结果审批流程',
  ]) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await expect(page.getByRole('tabpanel', { name: tab, exact: true })).toContainText('未完成（缺后端契约）');
    if (tab === '九宫格')
      await page.screenshot({ path: testInfo.outputPath('grid.png'), fullPage: true, animations: 'disabled' });
  }
  await expect.soft(page.getByRole('button', { name: '编辑项目', exact: true })).toHaveClass(/ant-btn-primary/);
  await page.getByRole('button', { name: '编辑项目', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '编辑项目', exact: true })).toBeVisible();
  await expect(page.getByLabel('名称', { exact: true })).toHaveValue('合成年度盘点');
  await page.screenshot({ path: testInfo.outputPath('form.png'), fullPage: true, animations: 'disabled' });
  await page
    .getByRole('button', { name: /取\s*消/ })
    .last()
    .click();
  expect(errors).toEqual([]);
});

test('AC-FE-R3c-02 九宫格设置 设置页渲染无错误', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await routeMatrix(page, [{ cellNo: 1, xLevelNo: 1, yLevelNo: 1, name: '合成格' }]);
  await page.goto('/talent-review');
  await page.getByLabel('切换演示身份').selectOption(user);
  await expect(page).toHaveURL(/\/staff$/);
  await page.getByRole('button', { name: '应用导航' }).click();
  await page.getByRole('dialog', { name: '全部菜单' }).getByRole('link', { name: '人才盘点', exact: true }).click();
  await page.getByRole('tab', { name: '九宫格设置', exact: true }).click();
  const settings = page.locator('.matrix-settings');
  await expect(settings.getByRole('tab', { name: '九宫格详细设置', exact: true })).toBeVisible();
  await expect(settings.locator('.ant-radio-button-wrapper-checked')).toHaveText('合成年度盘点');
  await expect(settings.locator('.matrix-section h3')).toHaveText([
    '基础设置',
    '九宫格展示',
    '比例控制及说明',
    '导出设置',
  ]);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /保\s*存/ })).toHaveCount(0);
  await settings.getByRole('tab', { name: '九宫格通用设置', exact: true }).click();
  await expect(settings.locator('.matrix-general')).toContainText('姓名默认宽度设置');
  expect(errors).toEqual([]);
});

for (const section of ['盘点模板', '盘点校准会']) {
  test(`AC-FE-R3c-02 ${section} 列表与详情渲染无错误`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto('/talent-review');
    await page.getByLabel('切换演示身份').selectOption(user);
    await expect(page).toHaveURL(/\/staff$/);
    await page.getByRole('button', { name: '应用导航' }).click();
    await page.getByRole('dialog', { name: '全部菜单' }).getByRole('link', { name: '人才盘点', exact: true }).click();
    await page.getByRole('tab', { name: section, exact: true }).click();
    if (section === '盘点校准会') {
      await expect(page.locator('.review-unavailable')).toContainText('未完成（缺后端契约）');
      await expect(page.locator('.review-unavailable tbody')).toHaveCount(0);
      expect(errors).toEqual([]);
      return;
    }
    // F-475 盘点B：模板点名称进入整页（R3cd spec §2.6），顶部三步导航，不弹窗。
    // 点数据行里的名称（tbody 首个按钮是表格测量行里的齿轮）。
    await page.locator('.list-card tbody .ant-table-row button').first().click();
    await expect(page.locator('.review-template-page')).toBeVisible();
    await expect(page.locator('.review-template-page .ant-steps-item')).toHaveCount(3);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('AC-FE-R3c-03 无范围时空列表不混入演示项目', async ({ page }) => {
  await page.route('**/talent-review/projects*', (route) =>
    route.fulfill({ json: { items: [], hasDataPermission: false } }),
  );
  await page.goto('/talent-review');
  await page.getByLabel('切换演示身份').selectOption(user);
  await expect(page).toHaveURL(/\/staff$/);
  await page.getByRole('button', { name: '应用导航' }).click();
  await page.getByRole('dialog', { name: '全部菜单' }).getByRole('link', { name: '人才盘点', exact: true }).click();
  await expect(page.locator('.list-card')).toContainText('当前没有可查看的数据范围');
  await expect(page.getByRole('button', { name: '合成年度盘点', exact: true })).toHaveCount(0);
});

for (const state of [
  { status: 'new', accessLevel: 'readonly' },
  { status: 'ended', accessLevel: 'manage' },
]) {
  test(`AC-FE-R3c-06 ${state.status}/${state.accessLevel} 详情没有编辑按钮`, async ({ page }) => {
    await page.route(`**/talent-review/projects/${id}`, (route) =>
      route.fulfill({
        json: {
          id,
          name: '合成年度盘点',
          revision: 1,
          ...state,
        },
      }),
    );
    await page.goto('/talent-review');
    await page.getByLabel('切换演示身份').selectOption(user);
    await expect(page).toHaveURL(/\/staff$/);
    await page.getByRole('button', { name: '应用导航' }).click();
    await page.getByRole('dialog', { name: '全部菜单' }).getByRole('link', { name: '人才盘点', exact: true }).click();
    await page.getByRole('button', { name: '合成年度盘点', exact: true }).click();
    const detail = page.locator('.review-project-detail');
    await expect(detail).toBeVisible();
    await expect(detail.getByRole('button', { name: '编辑项目' })).toHaveCount(0);
    if (state.status === 'ended') await expect(detail.getByRole('button', { name: /重\s*启/ })).toBeVisible();
  });
}

test('AC-FE-R3c-07 保存传 revision、命令ID，冲突展示且禁止旧表单盲重提', async ({ page }) => {
  const writes: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  await page.route(`**/talent-review/projects/${id}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    writes.push({ headers: route.request().headers(), body: route.request().postDataJSON() });
    return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT' } } });
  });
  await page.goto('/talent-review');
  await page.getByLabel('切换演示身份').selectOption(user);
  await expect(page).toHaveURL(/\/staff$/);
  await page.getByRole('button', { name: '应用导航' }).click();
  await page.getByRole('dialog', { name: '全部菜单' }).getByRole('link', { name: '人才盘点', exact: true }).click();
  await page.getByRole('button', { name: /编\s*辑/, exact: true }).click();
  const form = page.getByRole('dialog', { name: '编辑项目' });
  await expect(form).toBeVisible();
  await page.getByLabel('名称', { exact: true }).fill('  修改后盘点  ');
  await form.getByRole('button', { name: /保\s*存/ }).click();
  await expect(form.getByRole('alert')).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]?.headers['if-match']).toBe('1');
  expect(writes[0]?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  expect(writes[0]?.body.name).toBe('修改后盘点');
  expect(writes[0]?.body).not.toHaveProperty('status');
  expect(writes[0]?.body).not.toHaveProperty('code');
  await form.getByRole('button', { name: /保\s*存/ }).click();
  await expect(form.getByRole('alert')).toContainText('回查');
  expect(writes).toHaveLength(1);
});

for (const count of [16, 31]) {
  test(`AC-FE-R3c-08 ${count} 个项目的末页唯一项目结束后回到最后有效页`, async ({ page }) => {
    const items = Array.from({ length: count }, (_, i) => ({
      id: `project-${i + 1}`,
      name: `分页项目${i + 1}`,
      status: 'in_progress',
      accessLevel: 'manage',
      revision: 1,
    }));
    await page.route('**/talent-review/projects?*', (route) => route.fulfill({ json: { items } }));
    await page.route(`**/talent-review/projects/project-${count}/end`, (route) => {
      items[count - 1]!.status = 'ended';
      return route.fulfill({ json: { ...items[count - 1], revision: 2 } });
    });
    await page.goto('/talent-review');
    await page.getByLabel('切换演示身份').selectOption(user);
    await expect(page).toHaveURL(/\/staff$/);
    await page.getByRole('button', { name: '应用导航' }).click();
    await page.getByRole('dialog', { name: '全部菜单' }).getByRole('link', { name: '人才盘点', exact: true }).click();
    await page.locator(`.ant-pagination-item[title="${Math.ceil(count / 15)}"]`).click();
    await expect(page.locator('.list-card tbody .ant-table-row')).toHaveCount(1);
    await page.getByRole('button', { name: /^结\s*束$/ }).click();
    await page
      .locator('.ant-popconfirm')
      .getByRole('button', { name: /确\s*定/ })
      .click();
    await expect(page.locator('.page-total')).toHaveText(`共${count - 1}条`);
    await expect(page.locator('.ant-pagination-item-active')).toHaveAttribute('title', String((count - 1) / 15));
    await expect(page.locator('.list-card tbody .ant-table-row')).toHaveCount(15);
    await expect(page.getByRole('button', { name: `分页项目${count - 1}`, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: `分页项目${count}`, exact: true })).toHaveCount(0);
  });
}

for (const [collection, label] of [['templates', '盘点模板']] as const) {
  test(`AC-FE-R3c-08 ${label} 从整页返回后重读缩页，回到有效页`, async ({ page }) => {
    let items = Array.from({ length: 16 }, (_, i) => ({ id: `item-${i}`, name: `分页记录${i + 1}` }));
    await page.route(`**/talent-review/${collection}?*`, (route) => route.fulfill({ json: { items } }));
    await page.route(`**/talent-review/${collection}/item-*`, (route) =>
      route.fulfill({ json: { ...items.at(-1), revision: 1, accessLevel: 'manage' } }),
    );
    await page.goto('/talent-review');
    await page.getByLabel('切换演示身份').selectOption(user);
    await expect(page).toHaveURL(/\/staff$/);
    await page.getByRole('button', { name: '应用导航' }).click();
    await page.getByRole('dialog', { name: '全部菜单' }).getByRole('link', { name: '人才盘点', exact: true }).click();
    await page.getByRole('tab', { name: label, exact: true }).click();
    await page.locator('.ant-pagination-item[title="2"]').click();
    await expect(page.getByRole('button', { name: '分页记录16', exact: true })).toBeVisible();
    // 模板列表没有“刷新”（R3cd spec §3.3）；从整页返回即重读，只剩一页时不显示页码。
    await page.getByRole('button', { name: '分页记录16', exact: true }).click();
    await expect(page.locator('.review-template-page')).toBeVisible();
    items = items.slice(0, 15);
    await page.getByRole('button', { name: /返\s*回/ }).click();
    await expect(page.locator('.page-total')).toHaveText('共15条');
    await expect(page.locator('.list-card tbody .ant-table-row')).toHaveCount(15);
    await expect(page.locator('.review-template-list .ant-pagination')).toHaveCount(0);
  });
}

for (const [xCount, yCount] of [
  [2, 2],
  [2, 3],
  [3, 2],
  [3, 3],
] as const) {
  test(`AC-FE-R3c-09 X${xCount}档 Y${yCount}档配置按坐标展示`, async ({ page }) => {
    const cells = Array.from({ length: xCount * yCount }, (_, i) => ({
      cellNo: i + 1,
      xLevelNo: (i % xCount) + 1,
      yLevelNo: Math.floor(i / xCount) + 1,
      name: `X${(i % xCount) + 1}Y${Math.floor(i / xCount) + 1}`,
    })).reverse();
    await routeMatrix(page, cells);
    await page.goto('/talent-review');
    await page.getByLabel('切换演示身份').selectOption(user);
    await expect(page).toHaveURL(/\/staff$/);
    await page.getByRole('button', { name: '应用导航' }).click();
    await page.getByRole('dialog', { name: '全部菜单' }).getByRole('link', { name: '人才盘点', exact: true }).click();
    await page.getByRole('tab', { name: '九宫格设置', exact: true }).click();
    const grid = page.locator('.matrix-settings .review-grid');
    await expect(grid.locator('.review-cell')).toHaveCount(xCount * yCount);
    const boxes = await grid.locator('.review-cell').evaluateAll((nodes) =>
      nodes.map((node) => {
        const { x, y } = node.getBoundingClientRect();
        return { name: node.textContent, x: Math.round(x), y: Math.round(y) };
      }),
    );
    const columns = [...new Set(boxes.map((box) => box.x))].sort((a, b) => a - b);
    const rows = [...new Set(boxes.map((box) => box.y))].sort((a, b) => b - a);
    expect(columns).toHaveLength(xCount);
    expect(rows).toHaveLength(yCount);
    for (const cell of cells) {
      const box = boxes.find((candidate) => candidate.name === cell.name)!;
      expect([columns.indexOf(box.x) + 1, rows.indexOf(box.y) + 1]).toEqual([cell.xLevelNo, cell.yLevelNo]);
    }
  });
}

const activeHeaders = [
  '',
  '名称',
  '所属分类',
  '盘点场景',
  '所属组织',
  '盘点报告模板',
  '开始时间',
  '结束时间',
  '盘点年度',
  '盘点计算规则',
  '状态',
  '结果审批流程',
  '操作',
  '⚙',
];

const endedHeaders = [
  '',
  '项目名称',
  '所属分类',
  '盘点场景',
  '所属组织',
  '共享组织',
  '参与人数',
  '盘点报告模板',
  '开始时间',
  '结束时间',
  '盘点年度',
  '盘点计算规则',
  '状态',
  '应用场景',
  '操作',
  '⚙',
];

test('AC-TR F-475A 两种项目视图、筛选和选择状态按页面保留，人才池无假数据', async ({ page }) => {
  const ended = {
    id: 'a0000000-0000-4000-8000-000000000002',
    name: '合成已结束项目',
    status: 'ended',
    revision: 1,
    accessLevel: 'manage',
    ownerOrgId: id,
    categoryId: id,
  };
  await page.route('**/talent-review/projects?*', (route) =>
    route.fulfill({
      json: {
        items: [{ ...ended, id, name: '合成进行中项目', status: 'in_progress' }, ended],
        hasDataPermission: true,
      },
    }),
  );
  await page.route('**/org/organizations?*', (route) => route.fulfill({ json: { items: [{ id, name: '合成组织' }] } }));
  await page.goto('/talent-review');
  await page.getByLabel('切换演示身份').selectOption(user);
  await expect(page).toHaveURL(/\/staff$/);
  await page.getByRole('button', { name: '应用导航' }).click();
  await page.getByRole('dialog', { name: '全部菜单' }).getByRole('link', { name: '人才盘点', exact: true }).click();
  const list = page.locator('.review-project-list');
  const headers = list.locator('thead').first().getByRole('columnheader');
  await expect(headers).toHaveText(activeHeaders);
  await list.locator('tbody .ant-table-row').getByRole('checkbox').check();
  await expect(list.locator('.page-total')).toHaveText('已选中1条，共1条');
  await page.getByRole('tab', { name: '已结束的盘点项目', exact: true }).click();
  await expect(headers).toHaveText(endedHeaders);
  await expect(list.locator('.page-total')).toHaveText('共1条');
  await page.getByRole('tab', { name: '进行中的盘点项目', exact: true }).click();
  await list.getByRole('button', { name: '所属组织 ▾', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '所属组织', exact: true });
  await expect(picker.getByRole('heading', { name: '可选组织' })).toBeVisible();
  await picker.locator('section').first().getByRole('checkbox').check();
  await expect(picker.getByRole('heading', { name: '已选组织 1 / 100' })).toBeVisible();
  await picker.getByRole('button', { name: /^确\s*定$/ }).click();
  await expect(list.locator('.page-total')).toHaveText('共1条');
  await list.getByRole('button', { name: '高级筛选', exact: true }).click();
  const advanced = page.getByRole('dialog', { name: '高级筛选', exact: true });
  await expect(advanced.locator('.ant-form-item-label')).toHaveText([
    '名称',
    '所属组织',
    '开始时间',
    '结束时间',
    '盘点场景',
    '盘点年度',
    '所属分类',
  ]);
  await advanced.getByRole('button', { name: /^取\s*消$/ }).click();
  await list.getByRole('button', { name: '合成进行中项目', exact: true }).click();
  const detail = page.locator('.review-project-detail');
  await expect(detail).toBeVisible();
  await detail.getByRole('button', { name: /^返\s*回$/ }).click();
  await expect(list).toBeVisible();
  await expect(list.locator('.page-total')).toHaveText('共1条');
  await page.getByRole('tab', { name: '人才池', exact: true }).click();
  await expect(page.locator('.review-unavailable')).toContainText('人才池卡片、列表及成员管理尚未开放');
  await expect(page.locator('.review-unavailable tbody')).toHaveCount(0);
});

async function openReview(page: Page) {
  await page.goto('/talent-review');
  await page.getByLabel('切换演示身份').selectOption(user);
  await expect(page).toHaveURL(/\/staff$/);
  await page.getByRole('button', { name: '应用导航' }).click();
  await page.getByRole('dialog', { name: '全部菜单' }).getByRole('link', { name: '人才盘点', exact: true }).click();
}

test('AC-TR F-475A 自检：组织名称裁剪后搜索仍保留记录', async ({ page }) => {
  await page.route('**/org/organizations?*', (route) =>
    route.fulfill({ json: { items: [{ id }, { id: 'synthetic-visible-org', name: '合成组织' }] } }),
  );
  await openReview(page);
  await page.locator('.review-project-list').getByRole('button', { name: '所属组织 ▾', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '所属组织', exact: true });
  const rows = picker.locator('section').first().locator('tbody .ant-table-row');
  await expect(rows).toHaveCount(2);
  await picker.getByRole('textbox', { name: '搜索名称', exact: true }).fill('不匹配任何可见名称');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('--');
  await picker.getByRole('button', { name: /^取\s*消$/ }).click();
  await expect(page.locator('.review-project-list .page-total')).toHaveText('共1条');
});

test('AC-TR F-475A 自检：详情读取失败可返回并再次进入', async ({ page }) => {
  await page.route(`**/talent-review/projects/${id}`, (route) =>
    route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: '读取暂不可用' } } }),
  );
  await openReview(page);
  const list = page.locator('.review-project-list');
  await list.getByRole('button', { name: '合成年度盘点', exact: true }).click();
  await expect(list).toBeHidden();
  await expect(page.locator('.talent-review-page > .ant-alert')).toBeVisible();
  await page.getByRole('button', { name: /^返\s*回$/ }).click();
  await expect(list).toBeVisible();
  await page.unroute(`**/talent-review/projects/${id}`);
  await list.getByRole('button', { name: '合成年度盘点', exact: true }).click();
  await expect(page.locator('.review-project-detail h1')).toHaveText('合成年度盘点');
});

/** 计算规则冒烟夹具：权限快照与列表 / 详情 / PATCH 回执，返回收到的写请求。 */
async function routeCalcRules(page: Page) {
  // 计算规则对象另给可见字段（含应用说明），与 calc-rule-view 的列一致。
  const ruleFields = ['id', 'revision', 'name', 'enabled', 'description', 'items', 'createdBy', 'updatedAt'];
  await page.route('**/permission/me/objects/TalentReview.CalcRule', (route) =>
    route.fulfill({
      json: {
        objectCode: 'TalentReview.CalcRule',
        dataOperations: { view: true, create: true, update: true },
        viewableFields: ruleFields,
        editableFields: ruleFields,
        buttons: ['create', 'update'].map((buttonCode) => ({
          buttonCode,
          level: buttonCode === 'create' ? 'list' : 'detail',
        })),
      },
    }),
  );
  // 与对外 GET / 写响应同形：CalcRuleView + hints 投影、items[].formulaBindings。
  const rule = {
    id,
    name: '合成计算规则',
    enabled: true,
    assessmentLatestWindow: 'before_project_end',
    description: '合成说明',
    sortNo: 1,
    revision: 3,
    createdBy: id,
    createdAt: '2026-10-01T02:00:00.000Z',
    updatedBy: id,
    updatedAt: '2026-10-02T02:00:00.000Z',
    items: [
      {
        targetFieldId: id,
        priority: 1,
        formula: '1',
        description: null,
        sortNo: 1,
        usesRanking: false,
        formulaBindings: [],
      },
    ],
    hints: { order: [id], blocked: [], cycles: [], warnings: [] },
  };
  const sent: { ifMatch?: string; key?: string; body?: unknown }[] = [];
  await page.route('**/talent-review/calc-rules**', (route) => {
    const request = route.request();
    if (request.method() === 'PATCH') {
      sent.push({
        ifMatch: request.headers()['if-match'],
        key: request.headers()['idempotency-key'],
        body: request.postDataJSON(),
      });
      return route.fulfill({ json: { ...rule, ...request.postDataJSON(), revision: 4 } });
    }
    const url = new URL(request.url());
    return route.fulfill({
      json: url.pathname.endsWith(id) ? rule : { items: [rule], hasDataPermission: true, page: 1, pageSize: 200 },
    });
  });
  return sent;
}

test('AC-TR F-475B 计算规则列表与基础编辑弹窗：列宽按原站，补丁带版本与命令 ID', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const sent = await routeCalcRules(page);
  await page.goto('/talent-review');
  await page.getByLabel('切换演示身份').selectOption(user);
  await expect(page).toHaveURL(/\/staff$/);
  await page.getByRole('button', { name: '应用导航' }).click();
  await page.getByRole('dialog', { name: '全部菜单' }).getByRole('link', { name: '人才盘点', exact: true }).click();
  // 只核对模块顶层页签；盘点项目页内还有进行中 / 已结束两个视图页签。
  await expect(page.locator('.talent-review-page > .ant-tabs').getByRole('tab')).toHaveText([
    '盘点项目',
    '盘点模板',
    '盘点计算规则',
    '九宫格设置',
    '盘点校准会',
    '人才池',
  ]);
  await page.getByRole('tab', { name: '盘点计算规则', exact: true }).click();
  const list = page.locator('.review-calc-rule-list');
  await expect(list.locator('thead th')).toHaveText([
    '规则名',
    '应用说明',
    '状态',
    '创建人',
    '最近一次修改时间',
    '操作',
    '⚙',
  ]);
  const widths = await list
    .locator('colgroup col')
    .evaluateAll((cols) => cols.map((col) => (col as HTMLElement).style.width));
  expect(widths).toEqual(['211px', '211px', '181px', '201px', '229px', '160px', '24px']);
  await expect(list.locator('tbody .ant-table-row td').nth(4)).toHaveText('2026-10-02 10:00:00');
  await expect(list.locator('.page-total')).toHaveText('共1条');
  await expect(list.locator('.ant-pagination')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('calc-rules.png'), fullPage: true, animations: 'disabled' });
  await list.getByRole('button', { name: /编\s*辑/ }).click();
  const dialog = page.getByRole('dialog', { name: /编辑/ });
  await expect(dialog).toBeVisible();
  // F-502：antd 弹窗入场是缩放动画（起点 scale 0.2，即 750×0.2=150），toBeVisible 在动画中途就成立；
  // 轮询到动画结束的稳定宽度，期望值仍是原站 750，不放宽。
  const modal = page.locator('.review-calc-rule-form .ant-modal');
  await expect.poll(async () => Math.round((await modal.boundingBox())?.width ?? -1)).toBe(750);
  await expect(dialog.getByRole('button', { name: '翻译助手' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '配置表单' })).toBeDisabled();
  await expect(dialog).toContainText('4/200');
  await page.screenshot({ path: testInfo.outputPath('calc-rule-form.png'), fullPage: true, animations: 'disabled' });
  await dialog.getByLabel('规则名', { exact: true }).fill('合成计算规则改');
  await dialog.getByRole('button', { name: /保\s*存/ }).click();
  await expect(dialog).toBeHidden();
  expect(sent).toHaveLength(1);
  expect(sent[0]!.ifMatch).toBe('3');
  expect(sent[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
  expect(sent[0]!.body).toEqual({ name: '合成计算规则改' });
  expect(errors).toEqual([]);
});
