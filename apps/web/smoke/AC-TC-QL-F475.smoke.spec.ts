import { test, expect, user } from './fixtures.js';
import { actionButton } from './action-button.js';

const id = '31000000-0000-4000-8000-000000000001';
const level = '31000000-0000-4000-8000-000000000002';
const grade = '31000000-0000-4000-8000-000000000003';
const fields = [
  'name',
  'code',
  'classId',
  'categoryId',
  'enabled',
  'createdBy',
  'createdAt',
  'type',
  'typeId',
  'description',
  'displayOrder',
  'layerId',
  'jobLinkType',
  'jobLinks',
  'details',
  'levelIds',
  'dimensions',
  'abilityNote',
  'potentialNote',
  'experienceNote',
  'achievementNote',
  'evalMode',
  'isCommon',
  'gradeSchemeId',
  'publicDown',
];
const scheme = {
  id,
  revision: 1,
  name: '合成等级方案',
  description: '合成说明',
  enabled: true,
  details: [{ id: grade, grade: 1, name: '基础', description: '合成级别说明', score: null }],
};

test.beforeEach(async ({ page }) => {
  await page.route('**/permission/me/objects/**', (route) =>
    route.fulfill({
      json: {
        objectCode: decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!),
        dataOperations: { view: true, create: true, update: true },
        viewableFields: fields,
        editableFields: fields,
        buttons: [
          { buttonCode: 'create', level: 'list' },
          { buttonCode: 'update', level: 'detail' },
        ],
      },
    }),
  );
  await page.route('**/api/tenant/qualification/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('grade-schemes'))
      return route.fulfill({ json: path.endsWith(id) ? scheme : { items: [scheme] } });
    const row = {
      id,
      revision: 1,
      name: '合成指标',
      code: 'T01',
      typeId: id,
      enabled: true,
      description: '合成指标说明',
      evalMode: 'score',
    };
    return route.fulfill({ json: path.endsWith(id) ? row : { items: [row] } });
  });
  await page.route('**/api/tenant/talent/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const row = {
      id,
      revision: 1,
      name: '合成标准',
      enabled: true,
      categoryId: id,
      abilityNote: '合成能力说明',
      potentialNote: '合成潜力说明',
      experienceNote: '合成经历说明',
      achievementNote: '合成成就说明',
      dimensions: [
        {
          dimensionId: id,
          type: 'ability',
          target: null,
          weight: 0,
          dimension: { name: '合成能力', definition: '能力定义' },
        },
        { dimensionId: level, type: 'potential', dimension: { name: '合成潜力', definition: '潜力定义' } },
      ],
    };
    if (path.includes('/forms/'))
      return route.fulfill({ json: { editableFields: fields, requiredFields: ['name', 'categoryId'] } });
    return route.fulfill({ json: path.endsWith(id) ? row : { items: [row] } });
  });
  await page.goto('/talent');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.waitForURL('**/staff');
});

test('AC-TC 四页签整页详情，潜力/经历不带能力列，成就不制造空表', async ({ page }) => {
  await page.goto('/talent?view=criteria');
  await page.getByRole('button', { name: '合成标准', exact: true }).click();
  const detail = page.locator('.catalog-detail-page');
  await expect(detail).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(detail.getByRole('columnheader')).toContainText(['指标名称', '指标定义', '指标类别', '目标', '权重']);
  await detail.getByRole('tab', { name: '潜力', exact: true }).click();
  await expect(detail.getByRole('tabpanel').filter({ visible: true }).getByRole('columnheader')).toHaveText([
    '',
    '指标名称',
    '指标定义',
    '操作',
    '',
  ]);
  await detail.getByRole('tab', { name: '经历', exact: true }).click();
  await expect(detail.getByText('这里什么都没有...')).toBeVisible();
  await expect(detail.getByRole('tabpanel').filter({ visible: true }).getByRole('columnheader')).toHaveText([
    '',
    '指标名称',
    '类别名称',
    '操作',
    '',
  ]);
  await detail.getByRole('tab', { name: '成就', exact: true }).click();
  await expect(detail.getByRole('tabpanel').filter({ visible: true }).getByRole('table')).toHaveCount(0);
  await actionButton(page, '返回').click();
  await expect(page.locator('.catalog-detail-page')).toHaveCount(0);
});

test('AC-QL 指标页使用真实字段结构，等级方案按两组字段编辑并保留明细 ID', async ({ page }) => {
  await page.goto('/qualification?view=targets');
  await expect(page.getByRole('heading', { name: '全部指标', exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader')).toHaveText([
    '名称',
    '编码',
    '指标类型',
    '指标说明',
    '顺序号',
    '状态',
    '操作',
    '',
  ]);
  await page.goto('/qualification?view=grade-schemes');
  const writes: Record<string, unknown>[] = [];
  await page.route('**/qualification/grade-schemes/*', (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON();
      writes.push(body);
      return route.fulfill({ json: { ...scheme, ...body, revision: 2 } });
    }
    return route.fulfill({ json: scheme });
  });
  await actionButton(page, '编辑').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '等级方案信息', exact: true })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: '等级明细', exact: true })).toBeVisible();
  await dialog.getByLabel('名称', { exact: true }).fill('合成等级方案乙');
  await dialog.getByLabel('等级名称 1', { exact: true }).fill('基础乙');
  await actionButton(page, '保存').click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toEqual([{ name: '合成等级方案乙', details: [{ ...scheme.details[0], name: '基础乙' }] }]);
});

for (const scenario of [
  { module: 'qualification', key: 'grade-schemes', label: '等级方案', other: '任职级别', row: scheme },
  {
    module: 'qualification',
    key: 'targets',
    label: '指标',
    other: '任职级别',
    row: {
      id,
      revision: 1,
      name: '合成指标',
      code: 'T01',
      typeId: id,
      enabled: true,
      description: '合成指标说明',
      evalMode: 'score',
      isCommon: false,
      gradeSchemeId: null,
      displayOrder: 1,
      publicDown: false,
    },
  },
  {
    module: 'talent',
    key: 'criterion-categories',
    label: '人才标准的分类',
    other: '指标库',
    row: {
      id,
      revision: 1,
      name: '合成分类',
      displayOrder: 1,
      ownerOrgId: id,
    },
  },
]) {
  test(`AC-TC/QL ${scenario.label} 409 重读后改回原值仍可提交，采用最新 revision`, async ({ page }) => {
    let current = scenario.row;
    const sent: { revision: string | undefined; body: unknown }[] = [];
    await page.route(`**/${scenario.module}/${scenario.key}/*`, (route) => {
      if (route.request().method() === 'PATCH') {
        sent.push({ revision: route.request().headers()['if-match'], body: route.request().postDataJSON() });
        if (sent.length === 1) {
          current = { ...scenario.row, revision: 2, name: '服务端名称' };
          return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT', message: '版本冲突' } } });
        }
        return route.fulfill({ json: { ...current, ...route.request().postDataJSON(), revision: 3 } });
      }
      return route.fulfill({ json: current });
    });
    await page.goto(`/${scenario.module}?view=${scenario.key}`);
    await actionButton(page, '编辑').click();
    await page
      .getByRole('dialog')
      .getByLabel(scenario.key === 'criterion-categories' ? '分类名称' : '名称', { exact: true })
      .fill('用户修改');
    await actionButton(page, '保存').click();
    await page.getByRole('button', { name: '重读最新版本' }).click();
    await page.getByRole('button', { name: '已核对差异，继续编辑' }).click();
    await page
      .getByRole('dialog')
      .getByLabel(scenario.key === 'criterion-categories' ? '分类名称' : '名称', { exact: true })
      .fill(scenario.row.name);
    await actionButton(page, '保存').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(sent.at(-1)).toEqual({ revision: '2', body: { name: scenario.row.name } });
  });

  test(`AC-TC/QL ${scenario.label} 回执丢失关闭并切换页面后重开仍锁定，不发送第二个命令`, async ({ page }) => {
    let writes = 0;
    await page.route(`**/${scenario.module}/${scenario.key}/*`, (route) => {
      if (route.request().method() === 'PATCH') {
        writes++;
        return route.abort('failed');
      }
      return route.fulfill({ json: scenario.row });
    });
    await page.goto(`/${scenario.module}?view=${scenario.key}`);
    await actionButton(page, '编辑').click();
    await page
      .getByRole('dialog')
      .getByLabel(scenario.key === 'criterion-categories' ? '分类名称' : '名称', { exact: true })
      .fill('结果未知名称');
    await actionButton(page, '保存').click();
    await expect(actionButton(page, '保存')).toBeDisabled();
    await actionButton(page, '取消').click();
    await page.getByRole('menuitem', { name: scenario.other, exact: true }).click();
    await page.getByRole('menuitem', { name: scenario.label, exact: true }).click();
    await actionButton(page, '编辑').click();
    await expect(actionButton(page, '保存')).toBeDisabled();
    expect(writes).toBe(1);
  });
}

test('F475 P2-2 人才标准无重复摘要，概览有根节点和连线，三个表格完整列序', async ({ page }) => {
  await page.goto('/talent?view=criteria');
  await page.getByRole('button', { name: '合成标准', exact: true }).click();
  const detail = page.locator('.catalog-detail-page');
  await expect.soft(detail.locator('.catalog-detail-summary')).toHaveCount(0);
  await expect.soft(detail.getByText('合成能力说明', { exact: true })).toHaveCount(1);
  await expect.soft(detail.locator('.catalog-overview-root')).toHaveText('能力标准概览');
  const connector = detail.locator('.catalog-overview-connector');
  await expect.soft(connector).toHaveCount(1);
  if (await connector.count()) {
    await expect(connector).toHaveCSS('border-left-width', '1px');
    expect((await connector.boundingBox())!.height).toBeGreaterThan(0);
  }
  for (const [tab, columns] of [
    ['能力', ['', '指标名称', '指标定义', '指标类别', '目标', '权重', '操作', '']],
    ['潜力', ['', '指标名称', '指标定义', '操作', '']],
    ['经历', ['', '指标名称', '类别名称', '操作', '']],
  ] as const) {
    await detail.getByRole('tab', { name: tab, exact: true }).click();
    const panel = detail.getByRole('tabpanel').filter({ visible: true });
    await expect.soft(panel.getByRole('columnheader')).toHaveText([...columns]);
    await expect.soft(panel.getByRole('button', { name: '列设置', exact: true })).toBeDisabled();
  }
});

test('F475 P2-3 资格详情级别导航和目录工具栏保持取证顺序及两层明细', async ({ page }) => {
  await page.route('**/api/tenant/qualification/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/levels'))
      return route.fulfill({
        json: {
          items: [
            { id, revision: 1, name: '合成一级' },
            { id: level, revision: 1, name: '合成二级' },
          ],
        },
      });
    if (path.includes('/standards')) {
      const row = {
        id,
        revision: 1,
        name: '合成资格标准',
        levelIds: [id, level],
        details: [
          {
            levelId: id,
            targetId: grade,
            targetValue: '60',
            weight: 70,
            abilities: [{ content: '一级能力', targetValue: '80', weight: 90 }],
          },
          {
            levelId: level,
            targetId: grade,
            targetValue: '61',
            weight: 71,
            abilities: [{ content: '二级能力', targetValue: '81', weight: 91 }],
          },
        ],
      };
      return route.fulfill({ json: path.endsWith(id) ? row : { items: [row] } });
    }
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto('/qualification?view=standards');
  await page.getByRole('button', { name: '合成资格标准', exact: true }).click();
  const detail = page.locator('.catalog-detail-page');
  await expect.soft(detail.locator('header').getByRole('button')).toHaveText([/返\s*回/, '编辑基本信息', '查看图谱']);
  await expect.soft(detail.getByRole('heading', { name: '任职级别', exact: true })).toBeVisible();
  await expect.soft(detail.getByRole('textbox', { name: '搜索任职级别', exact: true })).toBeDisabled();
  for (const name of ['合成一级', '合成二级']) {
    await detail.getByRole('tab', { name, exact: true }).click();
    const panel = detail.getByRole('tabpanel').filter({ visible: true });
    await expect.soft(panel.getByRole('heading', { name, exact: true })).toBeVisible();
    await expect(panel.getByRole('columnheader')).toHaveText([
      '指标',
      '指标目标值',
      '指标权重（%）',
      '能力标准',
      '能力目标值',
      '目标等级',
      '能力权重（%）',
    ]);
    await expect(panel.getByRole('row').last().getByRole('cell')).toHaveText(
      name === '合成一级'
        ? [grade, '60', '70', '一级能力', '80', '—', '90']
        : [grade, '61', '71', '二级能力', '81', '—', '91'],
    );
  }
  for (const view of ['categories', 'levels']) {
    await page.goto(`/qualification?view=${view}`);
    await expect
      .soft(page.locator('.page-heading > .ant-space').getByRole('button').filter({ visible: true }))
      .toHaveText(['引入岗职务', /新\s*建/, /导\s*入/]);
  }
});

test('F475 P2-4 人才标准新增只标名称红星，分类仍按接口必填校验', async ({ page }) => {
  let posts = 0;
  await page.route('**/api/tenant/talent/criteria', (route) => {
    posts++;
    return route.fulfill({ status: 422, json: { error: { code: 'VALIDATION_FAILED', message: '分类必填' } } });
  });
  await page.goto('/talent?view=criteria');
  await actionButton(page, '新增').click();
  const dialog = page.getByRole('dialog');
  const markers = await dialog.locator('.ant-form-item-label > label').evaluateAll((labels) =>
    labels
      .filter((label) => {
        const style = getComputedStyle(label, '::before');
        return style.content.includes('*') && style.display !== 'none' && style.visibility !== 'hidden';
      })
      .map((label) => label.textContent),
  );
  expect.soft(markers).toEqual(['名称']);
  await dialog.getByLabel('名称', { exact: true }).fill('合成新标准');
  await actionButton(page, '保存').click();
  await expect(dialog.locator('.ant-form-item').filter({ has: page.locator('label[for="categoryId"]') })).toContainText(
    '请填写此项',
  );
  expect(posts).toBe(0);
});
