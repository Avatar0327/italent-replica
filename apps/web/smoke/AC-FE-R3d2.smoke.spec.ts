import { actionButton } from './action-button.js';
import type { Page } from '@playwright/test';
import { IDP_OBJECTS } from '../../../packages/domain/src/idp/catalog.js';
import { test, expect, user } from './fixtures.js';
import { goalId, mockIdp, planId, process, processId, taskId, templateId, type IdpCall } from './r3d2-fixtures.js';
test.use({ viewport: { width: 1440, height: 1000 } });
const SUB_FIELDS = IDP_OBJECTS.subProcess.fields.map((field) => field.code);
const IDENTITY_HIDDEN = '已有记录的标识无权查看，保存会被当成删除后重建，暂不开放新增、编辑、移除和排序';
const FIELDS_HIDDEN = '提交必需的字段无权查看，保存无法带回原值，暂不开放新增、编辑、移除和排序';

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}
async function asUser(page: Page) {
  await page.goto('/idp');
  await page.getByLabel('切换演示身份').selectOption(user);
  await expect(page).toHaveURL(/\/staff$/);
}
async function openMenu(page: Page, name: string) {
  await asUser(page);
  // 左侧只列当前应用菜单，跨应用经顶栏全部菜单面板进入（main F-132 布局壳）
  await page.getByRole('button', { name: '应用导航' }).click();
  await page.getByRole('dialog', { name: '全部菜单' }).getByRole('link', { name: '人才发展计划', exact: true }).click();
  // 应用入口先落到第一张有权限的列表，再点下一层菜单，避免与入口重定向竞争
  await expect(page).toHaveURL(/\/idp\/plans$/);
  // 左侧是人才应用菜单，本片分组默认收起，先展开再点下一层
  await page.getByRole('menuitem', { name: '人才发展计划', exact: true }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}
const writes = (calls: IdpCall[], method: string, path: string | RegExp) =>
  calls.filter(
    (call) => call.method === method && (typeof path === 'string' ? call.path === path : path.test(call.path)),
  );

test('AC-FE-R3d2-01 发展计划：状态列、高级筛选字段、整页详情与居中新增弹窗', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await mockIdp(page);
  await openMenu(page, '发展计划');
  await expect(page).toHaveURL(/\/idp\/plans$/);
  await expect(page.getByRole('heading', { name: '未开始&进行中' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '状态', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '进行中', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('plans.png'), fullPage: true, animations: 'disabled' });

  await page.getByRole('button', { name: '高级筛选' }).click();
  const filter = page.locator('.ant-drawer-content');
  for (const label of ['姓名', '指导人', '当前阶段'])
    await expect(filter.locator('label', { hasText: new RegExp(`^${label}$`) })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(filter).toBeHidden();

  // 详情整页打开（原站 05），返回后回到列表
  await page.getByRole('button', { name: '合成发展计划', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/idp/plans\\?plan=${planId}$`));
  const detail = page.getByRole('region', { name: '合成发展计划' });
  await expect(detail.getByRole('heading', { level: 1, name: '合成员工甲' })).toBeVisible();
  await expect(detail.getByText('计划：合成发展计划')).toBeVisible();
  await expect(page.locator('.ant-drawer-content')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('plan-detail.png'), fullPage: true, animations: 'disabled' });
  await detail.getByRole('button', { name: /返\s*回/ }).click();
  await expect(page).toHaveURL(/\/idp\/plans$/);
  await expect(page.getByRole('heading', { name: '未开始&进行中' })).toBeVisible();

  // 新增走居中弹窗（B2_01），不是抽屉
  await page.getByRole('button', { name: /新\s*增/, exact: true }).click();
  await expect(page.locator('.ant-modal').getByLabel('计划名称')).toBeVisible();
  await expect(page.locator('.ant-drawer-content')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('AC-FE-R3d2-02 计划详情：展示综述与回顾内容，按节点按钮添加 / 编辑 / 删除任务（含任务描述）', async ({ page }) => {
  const errors = watchErrors(page);
  const calls = await mockIdp(page);
  await asUser(page);
  await page.goto(`/idp/plans?plan=${planId}`);
  const detail = page.getByRole('region', { name: '合成发展计划' });
  for (const text of ['合成现状分析', '合成待发展项', '合成阶段总结', '合成改进方法'])
    await expect(detail.getByText(text)).toBeVisible();
  await expect(detail.getByText('合成任务', { exact: true })).toBeVisible();
  await expect(detail.getByText('合成任务描述')).toBeVisible();

  await detail.getByRole('button', { name: '添加任务' }).click();
  await detail.getByLabel('任务描述').fill('合成新任务描述');
  await detail.getByLabel('任务名称').fill('合成新任务');
  await detail.getByLabel('任务名称').press('Enter');
  const tasks = `/plans/${planId}/goals/${goalId}/tasks`;
  await expect.poll(() => writes(calls, 'POST', tasks).length).toBe(1);
  expect(writes(calls, 'POST', tasks)[0]).toMatchObject({
    body: { name: '合成新任务', description: '合成新任务描述' },
    revision: '3',
  });

  await detail.getByRole('button', { name: '编辑任务：合成任务' }).click();
  await expect(detail.getByLabel('任务描述')).toHaveValue('合成任务描述');
  await detail.getByLabel('任务描述').fill('合成任务描述改');
  await detail.getByLabel('任务名称').fill('合成任务改');
  await detail.getByLabel('任务名称').press('Enter');
  await expect.poll(() => writes(calls, 'PATCH', `${tasks}/${taskId}`).length).toBe(1);
  expect(writes(calls, 'PATCH', `${tasks}/${taskId}`)[0]).toMatchObject({
    body: { name: '合成任务改', description: '合成任务描述改' },
  });

  await detail.getByRole('button', { name: '删除任务：合成任务' }).click();
  await page
    .getByRole('tooltip')
    .getByRole('button', { name: /确\s*定/ })
    .click();
  await expect.poll(() => writes(calls, 'DELETE', `${tasks}/${taskId}`).length).toBe(1);
  expect(errors).toEqual([]);
});

test('AC-FE-R3d2-03 计划详情：节点没有目标编辑按钮时不开放任务操作', async ({ page }) => {
  const errors = watchErrors(page);
  await mockIdp(page, { goalButtons: [] });
  await asUser(page);
  await page.goto(`/idp/plans?plan=${planId}`);
  const detail = page.getByRole('region', { name: '合成发展计划' });
  await expect(detail.getByText('合成任务', { exact: true })).toBeVisible();
  await expect(detail.getByRole('button', { name: '添加任务' })).toHaveCount(0);
  await expect(detail.getByRole('button', { name: /编辑任务/ })).toHaveCount(0);
  await expect(detail.getByRole('button', { name: /删除任务/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('AC-FE-R3d2-04 我的发展计划：只列本人计划，表格与原站筛选，整页详情', async ({ page }) => {
  const errors = watchErrors(page);
  await mockIdp(page);
  await asUser(page);
  await page.goto('/self/idp');
  // F-164：页面照原站改名“个人发展计划”
  await expect(page.getByRole('heading', { name: '个人发展计划' })).toBeVisible();
  for (const name of ['名称', '姓名', '指导人', '状态', '当前步骤'])
    await expect(page.getByRole('columnheader', { name, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '合成发展计划', exact: true })).toBeVisible();
  await expect(page.getByText('合成参与计划')).toHaveCount(0);
  // 本人两份：合成发展计划、合成基本信息计划（F-164 夹具）
  await expect(page.getByText('共2条')).toBeVisible();
  for (const label of ['状态', '开始时间', '结束时间'])
    await expect(page.locator('.idp-inline-filters label', { hasText: new RegExp(`^${label}$`) })).toBeVisible();
  await page.getByRole('button', { name: '合成发展计划', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/self/idp\\?plan=${planId}$`));
  await expect(page.getByRole('region', { name: '合成发展计划' }).getByText('合成发展目标')).toBeVisible();
  expect(errors).toEqual([]);
});

test('AC-FE-R3d2-05 模板列表：状态列替代描述列；状态被裁剪的记录仍显示为无权查看', async ({ page }) => {
  const errors = watchErrors(page);
  await mockIdp(page);
  await openMenu(page, '发展计划模板');
  await expect(page).toHaveURL(/\/idp\/templates$/);
  for (const name of ['模板名称', '流程', '状态', '所属组织', '向下公开', '操作'])
    await expect(page.getByRole('columnheader', { name, exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '描述', exact: true })).toHaveCount(0);
  await expect(page.getByRole('row', { name: /合成发展计划模板/ }).getByRole('cell', { name: '开启' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('AC-FE-R3d2-06 模板列表：状态字段无权查看时两个页签都保留该记录', async ({ page }) => {
  const errors = watchErrors(page);
  const viewable = IDP_OBJECTS.template.fields.map((field) => field.code).filter((code) => code !== 'status');
  await mockIdp(page, { fields: { 'IDP.IDPTemplate': { viewable } } });
  await openMenu(page, '发展计划模板');
  const row = page.getByRole('row', { name: /合成发展计划模板/ });
  await expect(row.getByRole('cell', { name: '无权查看' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '状态', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '切换视图' }).click();
  await page.getByRole('menuitem', { name: '已停用的模板' }).click();
  await expect(page.getByRole('heading', { name: '已停用的模板' })).toBeVisible();
  await expect(row.getByRole('cell', { name: '无权查看' })).toBeVisible();
  // 状态未知时无法判断启用 / 停用方向，不给这两个按钮
  await expect(row.getByRole('button', { name: /^(启\s*用|停\s*用)$/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('AC-FE-R3d2-07 模板详情：整页、中文分区与节点名，不出现 DTO 键名或 JSON', async ({ page }) => {
  const errors = watchErrors(page);
  await mockIdp(page);
  await openMenu(page, '发展计划模板');
  await page.getByRole('button', { name: '合成发展计划模板', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/idp/templates\\?template=${templateId}$`));
  const detail = page.getByRole('region', { name: '合成发展计划模板' });
  await expect(detail.getByText('流程：合成发展计划流程')).toBeVisible();
  await expect(detail.getByText('当前模板已被引用')).toBeVisible();
  await expect(detail.getByText('目标设置')).toBeVisible();
  await expect(detail.getByText('各步骤参与角色及权限设置')).toBeVisible();
  await expect(detail.getByText('制定发展目标', { exact: true })).toBeVisible();
  await expect(detail.getByText('目标：新增、编辑')).toBeVisible();
  await detail.getByRole('button', { name: '关键信息' }).click();
  await expect(detail.getByText('展示字段：组织；开始时间')).toBeVisible();
  for (const raw of ['nodeSettings', 'allowCustomGoal', 'keyInfoBlocks', '{"'])
    await expect(detail).not.toContainText(raw);
  await detail.getByRole('button', { name: /返\s*回/ }).click();
  await expect(page).toHaveURL(/\/idp\/templates$/);
  expect(errors).toEqual([]);
});

test('AC-FE-R3d2-08 模板新增：居中弹窗，向下公开默认否，状态开启时创建后再启用', async ({ page }) => {
  const errors = watchErrors(page);
  const calls = await mockIdp(page);
  await openMenu(page, '发展计划模板');
  await page.getByRole('button', { name: /新\s*增/, exact: true }).click();
  const form = page.locator('.ant-modal');
  await expect(page.locator('.ant-drawer-content')).toHaveCount(0);
  await expect(form.getByRole('radio', { name: '否' })).toBeChecked();
  await expect(form.getByRole('radio', { name: '开启' })).toBeChecked();
  await expect(form.getByText('发展计划分类后端未提供，暂不可选')).toBeVisible();
  await form.getByLabel('模板名称').fill('合成新模板');
  await form.getByLabel('流程').click();
  await page.locator('.ant-select-item-option[title="合成发展计划流程"]').click();
  await form.getByLabel('所属组织').click();
  await page.locator('.ant-select-item-option[title="合成研发部"]').click();
  await form.getByRole('button', { name: /保\s*存/ }).click();
  await expect.poll(() => writes(calls, 'POST', `/templates/${templateId}/publish`).length).toBe(1);
  const created = writes(calls, 'POST', '/templates');
  expect(created).toHaveLength(1);
  expect(created[0]!.body).toMatchObject({ name: '合成新模板', publicDown: false });
  expect(created[0]!.body).not.toHaveProperty('status');
  expect(writes(calls, 'POST', `/templates/${templateId}/publish`)[0]!.revision).toBe('2');
  expect(errors).toEqual([]);
});

test('AC-FE-R3d2-09 模板复制：结果未知后关闭再打开不发第二次请求', async ({ page }) => {
  const calls = await mockIdp(page, { writeStatus: 500 });
  await openMenu(page, '发展计划模板');
  const row = page.getByRole('row', { name: /合成发展计划模板/ });
  await row.getByRole('button', { name: /复\s*制/ }).click();
  const dialog = page.getByRole('dialog', { name: '复制发展计划模板' });
  await dialog.getByRole('button', { name: /确\s*定/ }).click();
  await expect(dialog.getByText('命令 ID')).toBeVisible();
  await dialog.getByRole('button', { name: /取\s*消/ }).click();
  await expect(dialog).toBeHidden();
  await row.getByRole('button', { name: /复\s*制/ }).click();
  await expect(dialog.getByText('命令 ID')).toBeVisible();
  await expect(dialog.getByRole('button', { name: /确\s*定/ })).toBeDisabled();
  const copies = writes(calls, 'POST', /\/copy$/);
  expect(copies).toHaveLength(1);
  expect(copies[0]!.revision).toBe('0');
});

test('AC-FE-R3d2-10 子流程按自身字段权限渲染：只读字段禁用，必填字段不可编辑时不能新增', async ({ page }) => {
  const errors = watchErrors(page);
  await mockIdp(page, { fields: { 'IDP.SubProcess': { viewable: SUB_FIELDS, editable: ['name'] } } });
  await openMenu(page, '发展计划流程');
  await page.getByRole('button', { name: /编\s*辑/, exact: true }).click();
  const form = page.getByRole('dialog', { name: '编辑发展计划流程' });
  await expect(form.getByRole('cell', { name: '合成制定阶段' })).toBeVisible();
  await expect(form.getByRole('button', { name: '添加子流程' })).toHaveCount(0);
  await form
    .getByRole('row', { name: /合成制定阶段/ })
    .getByRole('button', { name: /编\s*辑/ })
    .click();
  const sub = page.getByRole('dialog', { name: '子流程' });
  await expect(sub.getByLabel('名称')).toBeEnabled();
  await expect(sub.getByLabel('阶段类型')).toBeDisabled();
  await expect(sub.getByLabel('审批类型')).toBeDisabled();
  expect(errors).toEqual([]);
});

test('AC-FE-R3d2-11 没有数据范围时列表显示空范围提示，不回退演示数据', async ({ page }) => {
  const errors = watchErrors(page);
  await mockIdp(page, { hasDataPermission: false });
  await openMenu(page, '发展计划');
  await expect(page.getByText('当前没有可查看的数据范围')).toBeVisible();
  await expect(page.getByRole('button', { name: '合成发展计划', exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('AC-FE-R3d2-12 子流程只有查看权时不显示移除、上移与新增', async ({ page }) => {
  const errors = watchErrors(page);
  await mockIdp(page, { operations: { 'IDP.SubProcess': { create: false, update: false, delete: false } } });
  await openMenu(page, '发展计划流程');
  await page.getByRole('button', { name: /编\s*辑/, exact: true }).click();
  const form = page.getByRole('dialog', { name: '编辑发展计划流程' });
  const row = form.getByRole('row', { name: /合成制定阶段/ });
  await expect(row).toBeVisible();
  await expect(row.getByRole('button', { name: /^(移\s*除|上\s*移|编\s*辑)$/ })).toHaveCount(0);
  await expect(form.getByRole('button', { name: '添加子流程' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('AC-FE-R3d2-13 目标可编辑但模块未开启或未返回“制定任务”时不开放任务操作', async ({ page }) => {
  const errors = watchErrors(page);
  await mockIdp(page, { taskSwitch: 'missing' });
  await asUser(page);
  await page.goto(`/idp/plans?plan=${planId}`);
  const detail = page.getByRole('region', { name: '合成发展计划' });
  await expect(detail.getByText('合成任务', { exact: true })).toBeVisible();
  await expect(detail.getByRole('button', { name: '添加任务' })).toHaveCount(0);
  await expect(detail.getByRole('button', { name: /编辑任务|删除任务/ })).toHaveCount(0);
  await expect(detail.getByText('服务端未返回本模块“制定任务”开关，暂不开放任务操作')).toBeVisible();

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await mockIdp(page, { taskSwitch: false });
  await page.reload();
  await expect(detail.getByText('合成任务', { exact: true })).toBeVisible();
  await expect(detail.getByRole('button', { name: '添加任务' })).toHaveCount(0);
  await expect(detail.getByText('服务端未返回本模块“制定任务”开关，暂不开放任务操作')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('AC-FE-R3d2-14 归属模块字段被裁剪时目标、综述、回顾仍在“未归属”中显示', async ({ page }) => {
  const errors = watchErrors(page);
  const without = (fields: readonly { code: string }[]) =>
    fields.map((field) => field.code).filter((code) => code !== 'moduleId');
  await mockIdp(page, {
    fields: {
      'IDP.IdpGoal': { viewable: without(IDP_OBJECTS.goal.fields) },
      'IDP.Analysis': { viewable: without(IDP_OBJECTS.analysis.fields) },
      'IDP.Review': { viewable: without(IDP_OBJECTS.review.fields) },
    },
  });
  await asUser(page);
  await page.goto(`/idp/plans?plan=${planId}`);
  const detail = page.getByRole('region', { name: '合成发展计划' });
  const unassigned = detail.getByRole('region', { name: '未归属' });
  for (const text of ['合成发展目标', '合成现状分析', '合成阶段总结'])
    await expect(unassigned.getByText(text)).toBeVisible();
  // 归属不明的目标拿不到所属模块的节点按钮，任务一律只读
  await expect(unassigned.getByRole('button', { name: '添加任务' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('AC-FE-R3d2-15 冲突后重读缺 revision：不解锁、不发 If-Match: 0，提示重读失败', async ({ page }) => {
  const errors = watchErrors(page);
  const calls = await mockIdp(page, { writeStatus: 409, rereadWithoutRevision: true });
  await asUser(page);
  await page.goto(`/idp/plans?plan=${planId}`);
  const detail = page.getByRole('region', { name: '合成发展计划' });
  await detail.getByRole('button', { name: '添加任务' }).click();
  await detail.getByLabel('任务名称').fill('合成新任务');
  await detail.getByLabel('任务名称').press('Enter');
  await expect(detail.getByText(/版本冲突/)).toBeVisible();
  await detail.getByRole('button', { name: '重读最新版本' }).click();
  await expect(detail.getByText('重读失败，请刷新')).toBeVisible();
  await expect(detail.getByRole('button', { name: '已核对差异，继续编辑' })).toHaveCount(0);
  await expect(detail.getByLabel('任务名称')).toBeDisabled();
  await detail.getByLabel('任务名称').press('Enter');
  const tasks = `/plans/${planId}/goals/${goalId}/tasks`;
  expect(writes(calls, 'POST', tasks)).toHaveLength(1);
  expect(calls.filter((call) => call.revision === '0')).toEqual([]);
  expect(errors.filter((text) => !text.includes('409'))).toEqual([]);
});

test('AC-FE-R3d2-16 任务名称被裁剪时不开放编辑，描述被裁剪时描述框禁用，不覆盖看不到的原值', async ({ page }) => {
  const errors = watchErrors(page);
  const calls = await mockIdp(page, {
    fields: {
      'IDP.Task': { viewable: IDP_OBJECTS.task.fields.map((field) => field.code).filter((code) => code !== 'name') },
    },
  });
  await asUser(page);
  await page.goto(`/idp/plans?plan=${planId}`);
  const detail = page.getByRole('region', { name: '合成发展计划' });
  await expect(detail.getByText('合成任务描述')).toBeVisible();
  await expect(detail.getByRole('button', { name: /编辑任务/ })).toHaveCount(0);

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await mockIdp(page, {
    fields: {
      'IDP.Task': {
        viewable: IDP_OBJECTS.task.fields.map((field) => field.code).filter((code) => code !== 'description'),
      },
    },
  });
  await page.reload();
  await detail.getByRole('button', { name: '编辑任务：合成任务' }).click();
  await expect(detail.getByLabel('任务描述')).toBeDisabled();
  expect(writes(calls, 'PATCH', `/plans/${planId}/goals/${goalId}/tasks/${taskId}`)).toEqual([]);
  expect(errors).toEqual([]);
});

test('AC-FE-R3d2-17 子流程 id 被裁剪时整组只读并说明原因，改流程名称不提交子流程', async ({ page }) => {
  const errors = watchErrors(page);
  const calls = await mockIdp(page, {
    fields: { 'IDP.SubProcess': { viewable: SUB_FIELDS.filter((code) => code !== 'id') } },
  });
  await openMenu(page, '发展计划流程');
  await page.getByRole('button', { name: /编\s*辑/, exact: true }).click();
  const form = page.getByRole('dialog', { name: '编辑发展计划流程' });
  const row = form.getByRole('row', { name: /合成制定阶段/ });
  await expect(row).toBeVisible();
  await expect(row.getByRole('button', { name: /^(移\s*除|上\s*移|编\s*辑)$/ })).toHaveCount(0);
  await expect(form.getByText(IDENTITY_HIDDEN)).toBeVisible();
  await expect(form.getByRole('button', { name: '添加子流程' })).toHaveCount(0);
  await form.getByLabel('流程名称').fill('合成发展计划流程（改）');
  await form.getByRole('button', { name: /保\s*存/ }).click();
  await expect.poll(() => writes(calls, 'PATCH', `/processes/${processId}`).length).toBe(1);
  const body = writes(calls, 'PATCH', `/processes/${processId}`)[0]!.body;
  expect(body).toMatchObject({ name: '合成发展计划流程（改）' });
  expect(body).not.toHaveProperty('subProcesses');
  expect(errors).toEqual([]);
});

test('AC-FE-R3d2-18 子流程必填字段被裁剪时整组只读，不出编辑按钮，并说明原因', async ({ page }) => {
  const errors = watchErrors(page);
  await mockIdp(page, { fields: { 'IDP.SubProcess': { viewable: ['id', 'name', 'category'] } } });
  await openMenu(page, '发展计划流程');
  await page.getByRole('button', { name: /编\s*辑/, exact: true }).click();
  const form = page.getByRole('dialog', { name: '编辑发展计划流程' });
  const row = form.getByRole('row', { name: /合成制定阶段/ });
  await expect(row).toBeVisible();
  await expect(form.getByRole('columnheader', { name: '审批类型' })).toHaveCount(0);
  await expect(row.getByRole('button', { name: /^(移\s*除|上\s*移|编\s*辑)$/ })).toHaveCount(0);
  await expect(form.getByText(FIELDS_HIDDEN)).toBeVisible();
  await expect(form.getByRole('button', { name: '添加子流程' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('AC-FE-R3d2-19 任务 id 被裁剪时不开放编辑与删除，不向缺 id 的路径发请求', async ({ page }) => {
  const errors = watchErrors(page);
  const calls = await mockIdp(page, {
    fields: {
      'IDP.Task': { viewable: IDP_OBJECTS.task.fields.map((field) => field.code).filter((code) => code !== 'id') },
    },
  });
  await asUser(page);
  await page.goto(`/idp/plans?plan=${planId}`);
  const detail = page.getByRole('region', { name: '合成发展计划' });
  await expect(detail.getByText('合成任务', { exact: true })).toBeVisible();
  await expect(detail.getByRole('button', { name: /编辑任务|删除任务/ })).toHaveCount(0);
  await expect(detail.getByRole('button', { name: '添加任务' })).toBeVisible();
  expect(calls.filter((call) => call.path.includes('undefined'))).toEqual([]);
  expect(errors).toEqual([]);
});

test('AC-FE-R3d2-20 子流程规则字段被裁剪、整组只读时，只改流程名称仍可保存，不按缺字段校验开启规则', async ({
  page,
}) => {
  const errors = watchErrors(page);
  const calls = await mockIdp(page, {
    subProcess: { startTimeType: 'relative', referencePoint: 'plan_start', startFrom: 'same_day' },
    fields: { 'IDP.SubProcess': { viewable: SUB_FIELDS.filter((code) => code !== 'referencePoint') } },
  });
  await openMenu(page, '发展计划流程');
  await page.getByRole('button', { name: /编\s*辑/, exact: true }).click();
  const form = page.getByRole('dialog', { name: '编辑发展计划流程' });
  await expect(form.getByText(FIELDS_HIDDEN)).toBeVisible();
  await form.getByLabel('流程名称').fill('合成发展计划流程（改）');
  await form.getByRole('button', { name: /保\s*存/ }).click();
  await expect.poll(() => writes(calls, 'PATCH', `/processes/${processId}`).length).toBe(1);
  expect(writes(calls, 'PATCH', `/processes/${processId}`)[0]!.body).not.toHaveProperty('subProcesses');
  expect(errors).toEqual([]);
});

test('AC-FE-R3d2-21 冲突重读后子流程缺字段、整组只读：冲突前的子流程草稿不再提交，改流程名称可保存', async ({
  page,
}) => {
  const errors = watchErrors(page);
  const calls = await mockIdp(page, { conflictTimes: 1, rereadSubProcessOmit: ['days'] });
  await openMenu(page, '发展计划流程');
  await page.getByRole('button', { name: /编\s*辑/, exact: true }).click();
  const form = page.getByRole('dialog', { name: '编辑发展计划流程' });
  await form
    .getByRole('row', { name: /合成制定阶段/ })
    .getByRole('button', { name: /编\s*辑/ })
    .click();
  const sub = page.getByRole('dialog', { name: '子流程' });
  await sub.getByLabel('名称').fill('合成制定阶段（草稿）');
  await sub.getByRole('button', { name: /确\s*定/ }).click();
  await form.getByRole('button', { name: /保\s*存/ }).click();
  await expect(actionButton(form, '重读最新版本')).toBeVisible();
  await actionButton(form, '重读最新版本').click();
  await expect(form.getByText(FIELDS_HIDDEN)).toBeVisible();
  // 整组只读后子流程表格回到最新记录；内核差异表仍列出“我的修改”供核对，那是 JSON 单元格，不计入
  await expect(form.getByRole('cell', { name: '合成制定阶段', exact: true })).toBeVisible();
  await expect(form.getByRole('cell', { name: '合成制定阶段（草稿）', exact: true })).toHaveCount(0);
  await form.getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
  await form.getByLabel('流程名称').fill('合成发展计划流程（改）');
  await form.getByRole('button', { name: /保\s*存/ }).click();
  await expect.poll(() => writes(calls, 'PATCH', `/processes/${processId}`).length).toBe(2);
  const body = writes(calls, 'PATCH', `/processes/${processId}`)[1]!.body;
  expect(body).toMatchObject({ name: '合成发展计划流程（改）' });
  expect(body).not.toHaveProperty('subProcesses');
  await expect(form).toHaveCount(0);
  expect(errors.filter((text) => !text.includes('409'))).toEqual([]);
});

test('AC-FE-R3d2-22 两次冲突、子流程先缺字段后恢复且服务端新增阶段：确认后显示最新两条，只改名称不提交子流程', async ({
  page,
}) => {
  const errors = watchErrors(page);
  const [stage] = process.subProcesses;
  const { days: _days, ...trimmedStage } = stage!;
  const added = { ...stage!, id: 'b0000000-0000-4000-8000-000000000301', seq: 2, name: '合成回顾阶段' };
  const latest = [stage!, added];
  const calls = await mockIdp(page, {
    conflictTimes: 2,
    processVersions: [
      { ...process, subProcesses: [trimmedStage] },
      { ...process, subProcesses: latest },
    ],
  });
  await openMenu(page, '发展计划流程');
  await page.getByRole('button', { name: /编\s*辑/, exact: true }).click();
  const form = page.getByRole('dialog', { name: '编辑发展计划流程' });
  await form
    .getByRole('row', { name: /合成制定阶段/ })
    .getByRole('button', { name: /编\s*辑/ })
    .click();
  const sub = page.getByRole('dialog', { name: '子流程' });
  await sub.getByLabel('名称').fill('合成制定阶段（草稿）');
  await sub.getByRole('button', { name: /确\s*定/ }).click();
  const reread = actionButton(form, '重读最新版本');
  const confirm = form.getByRole('button', { name: '已核对差异，继续编辑', exact: true });
  await form.getByRole('button', { name: /保\s*存/ }).click();
  await reread.click();
  await expect(form.getByText(FIELDS_HIDDEN)).toBeVisible();
  await confirm.click();
  await form.getByLabel('流程名称').fill('合成发展计划流程（改）');
  await form.getByRole('button', { name: /保\s*存/ }).click();
  await reread.click();
  await expect(form.getByText(FIELDS_HIDDEN)).toHaveCount(0);
  await confirm.click();
  // 子流程恢复可编辑时初值是最新记录：两条最新阶段，不是第一次冲突前的一条草稿
  await expect(form.getByRole('cell', { name: '合成制定阶段', exact: true })).toBeVisible();
  await expect(form.getByRole('cell', { name: '合成回顾阶段', exact: true })).toBeVisible();
  await expect(form.getByRole('cell', { name: '合成制定阶段（草稿）', exact: true })).toHaveCount(0);
  await form.getByRole('button', { name: /保\s*存/ }).click();
  await expect.poll(() => writes(calls, 'PATCH', `/processes/${processId}`).length).toBe(3);
  const saved = writes(calls, 'PATCH', `/processes/${processId}`)[2]!;
  expect(saved.body).toMatchObject({ name: '合成发展计划流程（改）' });
  expect(saved.body).not.toHaveProperty('subProcesses');
  expect(saved.stored?.subProcesses).toEqual(latest);
  await expect(form).toHaveCount(0);
  expect(errors.filter((text) => !text.includes('409'))).toEqual([]);
});

test('AC-FE-R3d2-23 新增流程时子流程必需字段不可见：整组只读、保存禁用，不发必然失败的创建请求', async ({ page }) => {
  const errors = watchErrors(page);
  const calls = await mockIdp(page, {
    fields: { 'IDP.SubProcess': { viewable: SUB_FIELDS.filter((code) => code !== 'days') } },
  });
  await openMenu(page, '发展计划流程');
  await page.getByRole('button', { name: /新\s*增/, exact: true }).click();
  const form = page.getByRole('dialog', { name: '新增发展计划流程' });
  await expect(form.getByText(FIELDS_HIDDEN)).toBeVisible();
  await expect(form.getByRole('button', { name: /保\s*存/ })).toBeDisabled();
  expect(writes(calls, 'POST', '/processes')).toEqual([]);
  expect(errors).toEqual([]);
});
