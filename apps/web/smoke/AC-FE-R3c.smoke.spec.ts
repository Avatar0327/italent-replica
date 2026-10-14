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
  'calcRuleId',
  'criterionId',
  'downwardPublic',
  'enabled',
  'flowId',
  'modules',
  'steps',
  'permissions',
  'cells',
];

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
  await page.getByRole('menuitem', { name: '人才盘点', exact: true }).click();
  await expect(page.getByRole('button', { name: '合成年度盘点', exact: true })).toBeVisible();
  await expect(page.locator('.page-total')).toBeInViewport();
  await page.getByRole('switch', { name: '注释' }).click();
  await expect(page.locator('.talent-review-page .decision-note')).toContainText('DEC-456');
  await page.getByRole('switch', { name: '注释' }).click();
  await page.screenshot({ path: testInfo.outputPath('list.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '合成年度盘点', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '合成年度盘点', exact: true })).toBeVisible();
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
    await expect(page.getByRole('tabpanel', { name: tab, exact: true })).toContainText('演示数据');
    if (tab === '九宫格')
      await page.screenshot({ path: testInfo.outputPath('grid.png'), fullPage: true, animations: 'disabled' });
  }
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

for (const section of ['盘点模板', '九宫格设置', '盘点校准会']) {
  test(`AC-FE-R3c-02 ${section} 列表与详情渲染无错误`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto('/talent-review');
    await page.getByLabel('切换演示身份').selectOption(user);
    await expect(page).toHaveURL(/\/staff$/);
    await page.getByRole('menuitem', { name: '人才盘点', exact: true }).click();
    await page.getByRole('tab', { name: section, exact: true }).click();
    await page.locator('.list-card tbody button').first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    if (section === '盘点模板') {
      await page.getByRole('button', { name: '编辑模板', exact: true }).click();
      await expect(page.getByRole('dialog', { name: '编辑模板', exact: true })).toBeVisible();
    }
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
  await page.getByRole('menuitem', { name: '人才盘点', exact: true }).click();
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
    await page.getByRole('menuitem', { name: '人才盘点', exact: true }).click();
    await page.getByRole('button', { name: '合成年度盘点', exact: true }).click();
    const detail = page.getByRole('dialog', { name: '合成年度盘点' });
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
  await page.getByRole('menuitem', { name: '人才盘点', exact: true }).click();
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
    await page.getByRole('menuitem', { name: '人才盘点', exact: true }).click();
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

for (const [collection, label] of [
  ['templates', '盘点模板'],
  ['matrices', '九宫格设置'],
] as const) {
  test(`AC-FE-R3c-08 ${label} 刷新缩页使用同一有效页码`, async ({ page }) => {
    let items = Array.from({ length: 16 }, (_, i) => ({ id: `item-${i}`, name: `分页记录${i + 1}` }));
    await page.route(`**/talent-review/${collection}?*`, (route) => route.fulfill({ json: { items } }));
    await page.goto('/talent-review');
    await page.getByLabel('切换演示身份').selectOption(user);
    await expect(page).toHaveURL(/\/staff$/);
    await page.getByRole('menuitem', { name: '人才盘点', exact: true }).click();
    await page.getByRole('tab', { name: label, exact: true }).click();
    await page.locator('.ant-pagination-item[title="2"]').click();
    await expect(page.getByRole('button', { name: '分页记录16', exact: true })).toBeVisible();
    items = items.slice(0, 15);
    await page.getByRole('button', { name: /刷\s*新/, exact: true }).click();
    await expect(page.locator('.page-total')).toHaveText('共15条');
    await expect(page.locator('.ant-pagination-item-active')).toHaveAttribute('title', '1');
    await expect(page.locator('.list-card tbody .ant-table-row')).toHaveCount(15);
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
    await page.route(`**/talent-review/matrices/${id}`, (route) =>
      route.fulfill({ json: { id, name: '合成年度盘点', cells } }),
    );
    await page.goto('/talent-review');
    await page.getByLabel('切换演示身份').selectOption(user);
    await expect(page).toHaveURL(/\/staff$/);
    await page.getByRole('menuitem', { name: '人才盘点', exact: true }).click();
    await page.getByRole('tab', { name: '九宫格设置', exact: true }).click();
    await page.getByRole('button', { name: '合成年度盘点', exact: true }).click();
    const grid = page.getByRole('dialog').locator('.review-grid');
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
