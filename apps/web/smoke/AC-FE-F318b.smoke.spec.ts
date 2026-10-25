import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { setupSources, sourcePath, sourcePeople } from './f318b-fixture.js';
import { messages as kernel } from '../src/foundation/forms/messages.js';

const editor = (page: Page, empty = false) =>
  page
    .getByRole('group', { name: empty ? '审批人为空时 → 指定人员' : '审批人来源', exact: true })
    .filter({ visible: true });
async function choose(page: Page, group: Locator, type: string, value?: string, index = 0) {
  await group.getByRole('combobox', { name: '来源类型', exact: true }).nth(index).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: type }).click();
  if (value) {
    await group
      .getByRole('combobox', { name: type === '指定人员' ? '指定人员' : '来源值', exact: true })
      .nth(index)
      .click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: value }).click();
    await page.keyboard.press('Escape');
  }
}
const save = (page: Page) => page.getByRole('button', { name: '保存草稿', exact: true }).click();

test('AC-FE-F318b-07 交接选上一节点审批人保存，F-326 灰显和 F-318c 待开放', async ({ page, baseURL }) => {
  const state = await setupSources(page, baseURL!);
  await page.goto(sourcePath);
  const group = editor(page);
  await group.getByRole('combobox', { name: '来源类型', exact: true }).click();
  for (const label of ['公共变量 · 暂不支持', '应用变量 · 暂不支持', '审批矩阵 · 暂不支持', '业务组织 · 待开放']) {
    await expect(page.locator('.ant-select-item-option').filter({ hasText: label })).toHaveClass(/disabled/);
  }
  await page.keyboard.press('Escape');
  await choose(page, group, '上下文变量', '上一节点审批人');
  await save(page);
  await expect(page.getByText('草稿已保存', { exact: true })).toBeVisible();
  expect(state.writes[0]?.body.nodes[0]).toMatchObject({
    approvers: [{ type: 'context_variable', value: 'previous_approved' }],
  });
});

test('AC-FE-F318b-08 会签多条指定人员与空人独立保存，单人无添加按钮', async ({ page, baseURL }) => {
  const state = await setupSources(page, baseURL!);
  await page.goto(sourcePath);
  await choose(page, editor(page), '指定人员', sourcePeople[0]!.name);
  await editor(page).getByRole('button', { name: '添加来源', exact: true }).click();
  await choose(page, editor(page), '指定人员', sourcePeople[1]!.name, 1);
  await editor(page, true).getByRole('button', { name: '添加来源', exact: true }).click();
  await choose(page, editor(page, true), '指定人员', sourcePeople[0]!.name);
  await save(page);
  await expect(page.getByText('草稿已保存', { exact: true })).toBeVisible();
  expect(state.writes[0]?.body.nodes[0]).toMatchObject({
    approvers: sourcePeople.map((p) => ({ type: 'specified', value: p.userId })),
    emptyApproverSources: [{ type: 'specified', value: sourcePeople[0]!.userId }],
    emptyApproverPolicy: 'specified',
    fallbackUserIds: [],
  });
  await page.getByRole('button', { name: /员工确认/ }).click();
  await expect(editor(page).getByRole('button', { name: '添加来源', exact: true })).toHaveCount(0);
});

test('AC-FE-F318b-09 单人动态来源多人 422 保留输入且可改正', async ({ page, baseURL }) => {
  const state = await setupSources(page, baseURL!, true);
  state.mode = '422';
  await page.goto(sourcePath);
  await choose(page, editor(page), '上下文变量', '上一节点审批人');
  await save(page);
  await expect(page.getByText('单人节点解析到多名审批人，请使用会签节点', { exact: true })).toBeVisible();
  await expect(editor(page).getByText('上一节点审批人', { exact: true })).toBeVisible();
  await expect(editor(page).getByRole('combobox', { name: '来源类型', exact: true })).toBeEnabled();
  state.mode = 'ok';
  await choose(page, editor(page), '指定人员', sourcePeople[0]!.name);
  await save(page);
  await expect(page.getByText('草稿已保存', { exact: true })).toBeVisible();
  expect(state.writes[1]?.body.nodes[0]).toMatchObject({
    approver: { type: 'specified', value: sourcePeople[0]!.userId },
  });
});

test('AC-FE-F318b-10 409 重读保留级联编辑并取最新未编辑字段', async ({ page, baseURL }) => {
  const state = await setupSources(page, baseURL!, true);
  state.mode = 'conflict';
  await page.goto(sourcePath);
  await choose(page, editor(page), '指定人员', sourcePeople[0]!.name);
  await save(page);
  await page.getByRole('button', { name: kernel.reload, exact: true }).click();
  await expect(page.getByText(sourcePeople[0]!.userId, { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: kernel.confirm, exact: true }).click();
  await expect(editor(page).getByText(new RegExp(sourcePeople[0]!.name))).toBeVisible();
  await save(page);
  await expect(page.getByText('草稿已保存', { exact: true })).toBeVisible();
  expect(state.writes[1]?.body.nodes[0]).toMatchObject({
    name: '合成最新节点名称',
    approver: { type: 'specified', value: sourcePeople[0]!.userId },
  });
  expect(state.writes[1]?.revision).toContain('5');
});

for (const mode of ['unknown', 'bad-receipt'])
  test(`AC-FE-F318b-11 ${mode} 重开仍锁定且不换命令`, async ({ page, baseURL }) => {
    const state = await setupSources(page, baseURL!, true);
    state.mode = mode;
    await page.goto(sourcePath);
    await choose(page, editor(page), '指定人员', sourcePeople[0]!.name);
    await save(page);
    await expect(page.getByText(kernel.unknown, { exact: true })).toBeVisible();
    await page.getByRole('link', { name: '返回流程列表', exact: true }).click();
    await page.getByRole('link', { name: '合成调动流程', exact: true }).click();
    await expect(editor(page).getByRole('combobox', { name: '来源类型', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: kernel.original, exact: true }).click();
    await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeDisabled();
    expect(state.writes).toHaveLength(1);
    await expect(page.getByText(sourcePeople[0]!.userId, { exact: false })).toHaveCount(0);
  });

test('AC-FE-F318b-12 无编辑权限只读，人员显示姓名工号部门，不显示 UUID', async ({ page, baseURL }) => {
  const state = await setupSources(page, baseURL!, true, false);
  Object.assign(state.flow.latestVersion.nodes[0]!, {
    approver: { type: 'specified', value: sourcePeople[0]!.userId },
  });
  await page.goto(sourcePath);
  await expect(editor(page).getByRole('combobox', { name: '来源类型', exact: true })).toBeDisabled();
  await expect(editor(page).getByText(/来源合成人员1 · SOURCE1 · 合成部门/)).toBeVisible();
  await expect(page.getByText(sourcePeople[0]!.userId, { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});
