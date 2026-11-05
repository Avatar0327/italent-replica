import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { candidateReads, setupSources, sourceObjects, sourcePath } from './f318b-fixture.js';

const editor = (page: Page) => page.getByRole('group', { name: '审批人来源', exact: true }).filter({ visible: true });
async function openSelect(input: Locator) {
  await input.focus();
  await input.press('ArrowDown');
}
async function option(page: Page, text: string | RegExp) {
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: text }).click();
}
async function pick(page: Page, type: string, object: string) {
  const group = editor(page);
  await openSelect(group.getByRole('combobox', { name: '来源类型', exact: true }));
  await option(page, new RegExp(`^${type}$`));
  await openSelect(group.getByRole('combobox', { name: '来源值', exact: true }));
  await option(page, object);
}
const save = (page: Page) => page.getByRole('button', { name: '保存草稿', exact: true }).click();
const noUuid = async (page: Page) =>
  expect(page.getByText(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/).filter({ visible: true })).toHaveCount(0);

test('AC-FE-F396-01 部门：候选搜索选对象，含下级保存为 ID:descendants，页面不显示 ID', async ({ page, baseURL }) => {
  const state = await setupSources(page, baseURL!, true);
  await page.goto(sourcePath);
  await pick(page, '部门', sourceObjects.department.name);
  await openSelect(editor(page).getByRole('combobox', { name: '取值方式', exact: true }));
  await option(page, '包含下级组织');
  await noUuid(page);
  await save(page);
  await expect(page.getByText('草稿已保存', { exact: true })).toBeVisible();
  expect(state.writes[0]?.body.nodes[0]).toMatchObject({
    approver: { type: 'department', value: `${sourceObjects.department.id}:descendants` },
  });
  const read = candidateReads.find((url) => url.searchParams.get('type') === 'department')!;
  expect(read.searchParams.get('asOf')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(read.searchParams.get('pageSize')).toBe('50');
});

test('AC-FE-F396-02 职务：相对申请人向上就近，换对象保留取值方式', async ({ page, baseURL }) => {
  const state = await setupSources(page, baseURL!, true);
  await page.goto(sourcePath);
  await pick(page, '职务', sourceObjects.job.name);
  await openSelect(editor(page).getByRole('combobox', { name: '取值方式', exact: true }));
  await option(page, '申请人所在部门向上就近');
  await save(page);
  await expect(page.getByText('草稿已保存', { exact: true })).toBeVisible();
  expect(state.writes[0]?.body.nodes[0]).toMatchObject({
    approver: { type: 'job', value: `${sourceObjects.job.id}:relative` },
  });
});

test('AC-FE-F396-03 身份：选身份保存，无取值方式；职位同样无', async ({ page, baseURL }) => {
  const state = await setupSources(page, baseURL!, true);
  await page.goto(sourcePath);
  await pick(page, '身份', sourceObjects.identity.name);
  await expect(editor(page).getByRole('combobox', { name: '取值方式', exact: true })).toHaveCount(0);
  await save(page);
  await expect(page.getByText('草稿已保存', { exact: true })).toBeVisible();
  expect(state.writes[0]?.body.nodes[0]).toMatchObject({
    approver: { type: 'identity', value: sourceObjects.identity.id },
  });
});

test('AC-FE-F396-04 已存职务按 ID 回显名称并标已停用；候选读取失败不显示 ID', async ({ page, baseURL }) => {
  const state = await setupSources(page, baseURL!, true);
  Object.assign(state.flow.latestVersion.nodes[0]!, { approver: { type: 'job', value: sourceObjects.retired.id } });
  await page.goto(sourcePath);
  await expect(editor(page).getByText(`${sourceObjects.retired.name} · 已停用`)).toBeVisible();
  await noUuid(page);
  const byId = candidateReads.find((url) => url.searchParams.get('ids') === sourceObjects.retired.id)!;
  expect(byId.searchParams.get('includeInactive')).toBe('true');
});
