import type { Page } from '@playwright/test';
import { test, expect, tenant, user, snapshotFixture } from './fixtures.js';
import { fallbackFixture } from '../../../tests/acceptance/support/f304-fixture.js';
import { flowId, flowPermission } from '../../../tests/acceptance/support/f315-fixture.js';
import { messages as kernel } from '../src/foundation/forms/messages.js';

const path = `/config-center/workflow/processes/${flowId}`;
const ids = [1, 2, 3].map((n) => `a3000000-0000-4000-8000-00000000000${n}`);
const people = ids.map((userId, i) => ({
  userId,
  name: `合成人员${i + 1}`,
  code: `S${i}`,
  departmentName: '合成部门',
}));
async function setup(page: Page, baseURL: string, writable = true) {
  await page.context().addCookies([
    { name: 'italent_demo_tenant', value: tenant, url: baseURL },
    { name: 'italent_demo_user', value: user, url: baseURL },
  ]);
  const state = { flow: fallbackFixture(), mode: 'ok', writes: [] as Record<string, unknown>[], candidates: people };
  Object.assign(state.flow.latestVersion.nodes[0]!, { fallbackUserIds: [ids[0]] });
  Object.assign(state.flow.latestVersion.nodes[1]!, { fallbackUserIds: [ids[1]] });
  await page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        apps: snapshotFixture.apps.map((app) =>
          app.app === 'approval' ? { ...app, entryObjects: ['TenantBase.ApprovalProcess'] } : app,
        ),
        adminMenus: [
          ...snapshotFixture.adminMenus,
          { code: 'matrix.manage', path: '流程矩阵/矩阵管理', implemented: false, editable: false },
        ],
      },
    }),
  );
  await page.route('**/permission/me/objects/TenantBase.ApprovalProcess', (route) =>
    route.fulfill({
      json: {
        ...flowPermission,
        editableFields: writable ? ['nodes'] : [],
      },
    }),
  );
  await page.route('**/approval/designer/person-candidates**', (route) => {
    const query = new URL(route.request().url()).searchParams;
    const requested = query.get('userIds')?.split(',');
    return route.fulfill({
      json: {
        items: state.candidates.filter((p) => !requested || requested.includes(p.userId)),
        page: 1,
        hasMore: false,
      },
    });
  });
  await page.route('**/approval/processes/**', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: state.flow });
    const body = route.request().postDataJSON();
    state.writes.push(body);
    if (state.mode === 'unknown') return route.abort('failed');
    if (state.mode === 'rejected')
      return route.fulfill({
        status: 422,
        json: { error: { code: 'VALIDATION_FAILED', message: '合成兜底处理人校验拒绝' } },
      });
    if (state.mode === 'conflict') {
      state.mode = 'ok';
      state.flow.revision++;
      return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT', message: '版本冲突' } } });
    }
    state.flow = {
      ...state.flow,
      revision: state.flow.revision + 1,
      latestVersion: { ...state.flow.latestVersion, ...body },
    };
    return route.fulfill({ json: state.flow });
  });
  return state;
}
async function pick(page: Page, name = '合成人员3') {
  await page.getByRole('combobox', { name: '兜底处理人', exact: true }).click();
  await page.getByRole('option', { name: new RegExp(name) }).click();
  await page.keyboard.press('Escape');
}
const save = (page: Page) => page.getByRole('button', { name: '保存草稿', exact: true }).click();

test('AC-FE-F304-04 两节点回显、选择增删、保存重读；其他节点隐藏', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL!);
  await page.goto(path);
  await expect(page.getByRole('heading', { name: '设计器', exact: true })).toBeVisible();
  await expect(page.getByText(/合成人员1/).first()).toBeVisible();
  await pick(page);
  await save(page);
  await expect(page.getByText('草稿已保存', { exact: true })).toBeVisible();
  expect(state.flow.latestVersion.nodes[0]?.fallbackUserIds).toEqual([ids[0], ids[2]]);
  await page.reload();
  await expect(page.getByText(/合成人员3/).first()).toBeVisible();
  await page
    .getByRole('navigation', { name: '流程节点' })
    .getByRole('button', { name: /其他事项交接/ })
    .click();
  await expect(page.getByText(/合成人员2/).first()).toBeVisible();
  await page
    .getByRole('navigation', { name: '流程节点' })
    .getByRole('button', { name: /员工确认/ })
    .click();
  await expect(page.getByRole('combobox', { name: '兜底处理人', exact: true })).toHaveCount(0);
});
test('AC-FE-F304-05 已失效标注与服务端拒绝保留输入', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL!);
  state.candidates = people.slice(1);
  state.mode = 'rejected';
  await page.goto(path);
  await expect(page.getByText(/已失效/).first()).toBeVisible();
  await pick(page);
  await save(page);
  await expect(page.getByText('合成兜底处理人校验拒绝', { exact: true })).toBeVisible();
  await expect(page.getByText(/合成人员3/).first()).toBeVisible();
  expect(state.writes).toHaveLength(1);
});
for (const changed of [false, true])
  test(`AC-FE-F304-06 冲突结构变化=${changed}`, async ({ page, baseURL }) => {
    const state = await setup(page, baseURL!);
    state.mode = 'conflict';
    await page.goto(path);
    await pick(page);
    await save(page);
    await expect(page.getByRole('button', { name: kernel.reload, exact: true })).toBeVisible();
    if (changed) state.flow.latestVersion.nodes = state.flow.latestVersion.nodes.slice(1);
    await page.getByRole('button', { name: kernel.reload, exact: true }).click();
    if (changed) {
      await expect(
        page.getByText('流程版本或节点结构已变更，请返回列表重新打开后核对。', { exact: true }),
      ).toBeVisible();
      expect(state.writes).toHaveLength(1);
    } else {
      await page.getByRole('button', { name: kernel.confirm, exact: true }).click();
      await save(page);
      await expect(page.getByText('草稿已保存', { exact: true })).toBeVisible();
      expect(state.flow.latestVersion.nodes[0]?.fallbackUserIds).toEqual([ids[0], ids[2]]);
    }
  });
test('AC-FE-F304-07 无编辑权只读；未知结果退出重开仍锁定', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL!, false);
  await page.goto(path);
  await expect(page.getByRole('combobox', { name: '兜底处理人', exact: true })).toBeDisabled();
  expect(state.writes).toHaveLength(0);
});
