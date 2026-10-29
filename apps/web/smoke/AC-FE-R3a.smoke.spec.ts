import { actionButton } from './action-button.js';
import { test, expect, user, snapshotFixture } from './fixtures.js';

const rows = [
  {
    id: '30000000-0000-4000-8000-000000000011',
    revision: 1,
    name: '合成配置',
    code: 'DEMO',
    type: 'ability',
    enabled: true,
    displayOrder: 1,
    categoryId: '30000000-0000-4000-8000-000000000011',
    levelIds: [],
    details: [],
    dimensions: [],
  },
];

test.beforeEach(async ({ page }) => {
  await page.route('**/api/tenant/permission/me/objects/**', (route) =>
    route.fulfill({
      json: {
        objectCode: decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!),
        dataOperations: { view: true, create: true, update: true },
        viewableFields: [
          'name',
          'code',
          'type',
          'enabled',
          'displayOrder',
          'classId',
          'categoryId',
          'levelIds',
          'details',
          'dimensions',
          'libraryId',
          'definition',
          'layerId',
        ],
        editableFields: [
          'details',
          'dimensions',
          'name',
          'code',
          'type',
          'enabled',
          'displayOrder',
          'classId',
          'categoryId',
          'levelIds',
          'libraryId',
          'definition',
          'layerId',
        ],
        buttons: [
          { buttonCode: 'create', level: 'list' },
          { buttonCode: 'update', level: 'detail' },
        ],
      },
    }),
  );
  for (const module of ['talent', 'qualification']) {
    await page.route(`**/api/tenant/${module}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.includes('development-channel'))
        return route.fulfill({ json: { current: null, vertical: [], horizontal: [] } });
      if (path.includes('/forms/'))
        return route.fulfill({
          json: {
            editableFields: [
              'details',
              'dimensions',
              'name',
              'code',
              'type',
              'enabled',
              'displayOrder',
              'libraryId',
              'categoryId',
              'definition',
            ],
            requiredFields: ['name'],
          },
        });
      return route.fulfill({
        json: path.endsWith(rows[0]!.id) ? rows[0] : { items: rows, total: 1, hasDataPermission: true },
      });
    });
  }
});

for (const [path, title] of [
  ['/talent?view=libraries', '指标库'],
  ['/talent?view=dimensions', '指标'],
  ['/talent?view=criteria', '人才标准'],
  ['/qualification?view=categories', '任职类别'],
  ['/qualification?view=levels', '任职级别'],
  ['/qualification?view=standards', '任职资格标准'],
]) {
  test(`AC-FE-R3a ${title} 身份切换、列表、详情、表单抽屉`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto('/staff');
    await page.getByLabel('切换演示身份').selectOption(user);
    await page.goto(path!);
    await expect(page.getByRole('heading', { name: title!, exact: true })).toBeVisible();
    await expect(page.locator('.ant-breadcrumb')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '切换视图' })).toBeVisible();
    await expect(page.locator('.ant-pagination-options')).toContainText('15条/页');
    const cell = page.locator('.catalog-page .ant-table-tbody > tr > td').first();
    await expect(cell).toHaveCSS('font-size', '12px');
    await expect(cell).toHaveCSS('height', '40px');
    await page.getByRole('button', { name: '合成配置', exact: true }).first().click();
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await expect(page.getByRole('dialog')).toContainText('合成配置');
    await expect(page.locator('.detail-drawer')).toBeVisible();
    await page.getByRole('button', { name: '关闭详情' }).click();
    await page.getByRole('button', { name: /^新\s*建$/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByLabel('名称', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^取\s*消$/ }).click();
    await page.getByRole('switch', { name: '注释' }).click();
    await expect(page.locator('.catalog-page .decision-note')).toBeVisible();
    if (title === '任职资格标准') await page.screenshot({ path: '../../.demo/fe-r3a/standards.png', fullPage: true });
    expect(errors).toEqual([]);
  });
}

test('AC-FE-R3a 员工发展通道空态，无资格不伪造路径', async ({ page }) => {
  await page.goto('/staff');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.goto('/qualification?view=channels');
  await expect(page.getByRole('heading', { name: '员工发展通道', exact: true })).toBeVisible();
  await expect(page.getByText('选择员工后查看当前任职资格与发展路径')).toBeVisible();
});

test('AC-FE-R3a 编辑按当前详情 revision 提交，仅发送改动字段', async ({ page }) => {
  const writes: { body: unknown; revision?: string; key?: string }[] = [];
  await page.route('**/api/tenant/qualification/categories/*', (route) => {
    if (route.request().method() === 'PATCH') {
      const headers = route.request().headers();
      writes.push({
        body: route.request().postDataJSON(),
        revision: headers['if-match'],
        key: headers['idempotency-key'],
      });
      return route.fulfill({ json: { ...rows[0], name: '更新后的合成类别', revision: 2 } });
    }
    return route.fulfill({ json: rows[0] });
  });
  await page.goto('/staff');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.goto('/qualification?view=categories');
  await actionButton(page, '编辑').click();
  await page.getByLabel('名称', { exact: true }).fill('更新后的合成类别');
  await actionButton(page, '保存').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(writes).toEqual([{ body: { name: '更新后的合成类别' }, revision: '1', key: expect.any(String) }]);
});

test('AC-FE-R3a 无按钮权限隐藏新建和编辑，隐藏字段不生成列表列', async ({ page }) => {
  await page.route('**/permission/me/objects/Qualification.EmploymentLevel', (route) =>
    route.fulfill({
      json: {
        objectCode: 'Qualification.EmploymentLevel',
        dataOperations: { view: true },
        viewableFields: ['name'],
        editableFields: [],
        buttons: [],
      },
    }),
  );
  await page.goto('/staff');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.goto('/qualification?view=levels');
  await expect(page.getByRole('heading', { name: '任职级别', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^新\s*建$/ })).toHaveCount(0);
  await expect(actionButton(page, '编辑')).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: '编码' })).toHaveCount(0);
});

test('AC-FE-R3a 员工当前级别与标准详情来自接口', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const id = rows[0]!.id;
  await page.route('**/api/tenant/personnel/employees?*', (route) =>
    route.fulfill({ json: { items: [{ id, name: '合成员工' }] } }),
  );
  await page.route('**/api/tenant/qualification/employees/**', (route) =>
    route.fulfill({
      json: route.request().url().includes('/levels/')
        ? {
            level: {
              description: '合成级别说明',
              cells: [{ levelId: id, targetId: id, abilities: [{ content: '能够独立完成合成任务' }] }],
            },
          }
        : {
            asOf: '2026-10-12',
            current: { categoryId: id, levelId: id, startDate: '2026-01-01' },
            vertical: [{ levelId: id }],
            horizontal: [],
          },
    }),
  );
  await page.goto('/staff');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.goto('/qualification?view=channels');
  await page.getByRole('combobox', { name: '选择人员', exact: true }).click();
  await page.getByText('合成员工', { exact: true }).click();
  await expect(page.getByText('当前任职资格', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '查看级别标准' }).click();
  await expect(page.getByRole('dialog')).toContainText('能够独立完成合成任务');
  expect(errors).toEqual([]);
});

test('AC-FE-R3a 新建标准提交选定级别与指标网格，不发送空白默认字段', async ({ page }) => {
  let body: unknown;
  await page.route('**/api/tenant/qualification/standards', (route) => {
    body = route.request().postDataJSON();
    expect(route.request().headers()['if-match']).toBe('0');
    return route.fulfill({ status: 201, json: rows[0] });
  });
  await page.goto('/staff');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.goto('/qualification?view=standards');
  await page.getByRole('button', { name: /^新\s*建$/ }).click();
  await page.getByLabel('名称', { exact: true }).fill('合成任职标准');
  for (const label of ['任职类别', '级别范围', '指标范围']) {
    const choice = page.getByLabel(label, { exact: true });
    await choice.click();
    await choice.press('ArrowDown');
    await choice.press('Enter');
    await page.getByLabel('名称', { exact: true }).click();
  }
  await actionButton(page, '保存').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(body).toEqual({
    name: '合成任职标准',
    categoryId: rows[0]!.id,
    levelIds: [rows[0]!.id],
    details: [{ levelId: rows[0]!.id, targetId: rows[0]!.id }],
  });
});

test('AC-FE-R3a 更多配置保留既有六组维护入口', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/staff');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.goto('/talent?view=maintenance');
  for (const title of ['指标库', '指标', '人才标准', '人才标准分类', '指标库分类', '发展建议类型']) {
    await page.getByRole('tab', { name: title, exact: true }).click();
    await expect(page.getByRole('tabpanel')).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('AC-FE-R3a 人才标准引用潜力指标时不提供权重与目标输入', async ({ page }) => {
  let body: Record<string, unknown> | undefined;
  await page.route('**/api/tenant/talent/candidates/dimensions?*', (route) =>
    route.fulfill({ json: { items: [{ ...rows[0], type: 'potential' }] } }),
  );
  await page.route('**/api/tenant/talent/criteria', (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: rows[0] });
  });
  await page.goto('/staff');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.goto('/talent?view=criteria');
  await page.getByRole('button', { name: /^新\s*建$/ }).click();
  await page.getByLabel('名称', { exact: true }).fill('合成人才标准');
  for (const label of ['分类', '引用指标']) {
    const choice = page.getByLabel(label, { exact: true });
    await choice.click();
    await choice.press('ArrowDown');
    await choice.press('Enter');
    await page.getByLabel('名称', { exact: true }).click();
  }
  await expect(page.getByRole('dialog').getByRole('spinbutton')).toHaveCount(0);
  await actionButton(page, '保存').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(body?.dimensions).toEqual([{ dimensionId: rows[0]!.id }]);
});

test('AC-FE-R3a 已选员工无当前资格时显示真实空态', async ({ page }) => {
  await page.route('**/api/tenant/personnel/employees?*', (route) =>
    route.fulfill({ json: { items: [{ id: rows[0]!.id, name: '合成员工' }] } }),
  );
  await page.goto('/staff');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.goto('/qualification?view=channels');
  await page.getByRole('combobox', { name: '选择人员', exact: true }).click();
  await page.getByText('合成员工', { exact: true }).click();
  await expect(page.getByText('暂无发展通道信息', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '查看级别标准' })).toHaveCount(0);
});

for (const changeName of [false, true]) {
  test(`AC-FE-R3a P2-1 清空层级${changeName ? '并改名' : '单独保存'}`, async ({ page }) => {
    const body: unknown[] = [];
    let saved = { ...rows[0], layerId: rows[0]!.id as string | null };
    await page.route('**/api/tenant/qualification/levels/*', (route) => {
      if (route.request().method() === 'PATCH') {
        body.push(route.request().postDataJSON());
        saved = { ...saved, ...route.request().postDataJSON() };
      }
      return route.fulfill({ json: saved });
    });
    await page.goto('/staff');
    await page.getByLabel('切换演示身份').selectOption(user);
    await page.goto('/qualification?view=levels');
    await actionButton(page, '编辑').click();
    const layer = page.getByLabel('层级', { exact: true });
    await expect(page.locator('.ant-form-item').filter({ has: layer })).toContainText('合成配置');
    await page.locator('.ant-form-item').filter({ has: layer }).locator('.ant-select-clear').click();
    if (changeName) await page.getByLabel('名称', { exact: true }).fill('改名后的级别');
    await actionButton(page, '保存').click();
    await expect.poll(() => body).toEqual([changeName ? { name: '改名后的级别', layerId: null } : { layerId: null }]);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await actionButton(page, '编辑').click();
    await expect(page.getByLabel('层级', { exact: true })).toHaveValue('');
  });
}

for (const channel of [false, true]) {
  test(`AC-FE-R3a P2-2 P2-3 ${channel ? '员工通道' : '任职标准'}保留两层目标权重与目标等级`, async ({ page }) => {
    const id = rows[0]!.id;
    const grade = '30000000-0000-4000-8000-000000000021';
    const cells = [
      {
        levelId: id,
        targetId: id,
        targetValue: '80',
        weight: 45,
        abilities: [
          { content: '空值能力标准', targetValue: null, weight: null, targetGradeId: grade },
          { content: '有值能力标准', targetValue: '60', weight: 25, targetGradeId: null },
        ],
      },
    ];
    await page.route('**/api/tenant/qualification/targets/*/grade-descriptions', (route) =>
      route.fulfill({ json: { items: [{ gradeDetailId: grade, name: '优秀', grade: 3 }] } }),
    );
    await page.route('**/api/tenant/qualification/standards/*', (route) =>
      route.fulfill({ json: { ...rows[0], levelIds: [id], details: cells } }),
    );
    await page.route('**/api/tenant/personnel/employees?*', (route) =>
      route.fulfill({ json: { items: [{ id, name: '合成员工' }] } }),
    );
    await page.route('**/api/tenant/qualification/employees/**', (route) =>
      route.fulfill({
        json: route.request().url().includes('/levels/')
          ? { level: { cells } }
          : {
              asOf: '2026-10-13',
              current: { categoryId: id, levelId: id },
              vertical: [{ levelId: id }],
              horizontal: [],
            },
      }),
    );
    await page.goto('/staff');
    await page.getByLabel('切换演示身份').selectOption(user);
    await page.goto(`/qualification?view=${channel ? 'channels' : 'standards'}`);
    if (channel) {
      await page.getByRole('combobox', { name: '选择人员', exact: true }).click();
      await page.getByText('合成员工', { exact: true }).click();
      await page.getByRole('button', { name: '查看级别标准' }).click();
    } else await page.getByRole('button', { name: '合成配置', exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    for (const title of ['指标目标值', '指标权重（%）', '能力目标值', '能力权重（%）', '目标等级'])
      await expect(dialog.getByRole('columnheader', { name: title, exact: true })).toBeVisible();
    const empty = dialog.getByRole('row').filter({ hasText: '空值能力标准' });
    await expect(empty).toContainText('80');
    await expect(empty).toContainText('45');
    await expect(empty).toContainText('优秀');
    const filled = dialog.getByRole('row').filter({ hasText: '有值能力标准' });
    for (const value of ['80', '45', '60', '25'])
      await expect(filled.getByRole('cell', { name: value, exact: true })).toBeVisible();
  });
}

test('AC-FE-R3a P2-4 仅人才标准有权时可进入完整维护，未授权页签不加载', async ({ page }) => {
  const denied: string[] = [];
  // F-114 改为服务端权限快照；入口摘要必须与本场景的对象明细授权一致。
  await page.route('**/api/tenant/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        apps: snapshotFixture.apps.map((app) =>
          app.app === 'talent' ? { ...app, entryObjects: ['TalentCenter.TalentCriterion'] } : app,
        ),
      },
    }),
  );
  await page.route('**/api/tenant/permission/me/objects/TalentCenter.*', (route) => {
    const objectCode = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (objectCode !== 'TalentCenter.TalentCriterion')
      return route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN' } } });
    return route.fulfill({
      json: {
        objectCode,
        dataOperations: { view: true, update: true },
        viewableFields: ['name', 'categoryId', 'enabled', 'dimensions'],
        editableFields: ['name', 'dimensions'],
        buttons: [{ buttonCode: 'update', level: 'detail' }],
      },
    });
  });
  page.on('request', (request) => {
    if (/\/talent\/(libraries|dimensions|dimension-categories|description-types)(\?|$)/.test(request.url()))
      denied.push(request.url());
  });
  await page.goto('/staff');
  await page.getByLabel('切换演示身份').selectOption(user);
  await page.goto('/talent?view=criteria');
  await expect(page.getByRole('menuitem', { name: '更多配置', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: '更多配置', exact: true }).click();
  await expect(page.getByRole('tab', { name: '人才标准', exact: true })).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(1);
  await page.goto('/talent?view=maintenance');
  await expect(page.getByRole('tab', { name: '人才标准', exact: true })).toBeVisible();
  await page.getByRole('tabpanel').getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page.getByRole('tabpanel').locator('form')).toBeVisible();
  expect(denied).toEqual([]);
});
