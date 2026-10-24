import type { Page } from '@playwright/test';
import { test, expect, tenant, user, snapshotFixture } from './fixtures.js';
import { flowFixture, flowId, flowPermission } from '../../../tests/acceptance/support/f315-fixture.js';
import { messages as kernel } from '../src/foundation/forms/messages.js';

const path = '/config-center/workflow/processes';
async function setup(page: Page, baseURL: string, writable = true) {
  await page.context().addCookies([
    { name: 'italent_demo_tenant', value: tenant, url: baseURL },
    { name: 'italent_demo_user', value: user, url: baseURL },
  ]);
  const state = {
    flow: flowFixture(),
    mode: 'ok',
    reads: 0,
    writes: [] as { method: string; body: Record<string, unknown>; revision: string; command: string }[],
  };
  await page.route('**/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        apps: snapshotFixture.apps.map((app) =>
          app.app === 'approval' ? { ...app, entryObjects: ['TenantBase.ApprovalProcess'] } : app,
        ),
        adminMenus: writable
          ? [
              ...snapshotFixture.adminMenus,
              { code: 'matrix.manage', path: '流程矩阵/矩阵管理', implemented: false, editable: false },
            ]
          : snapshotFixture.adminMenus,
      },
    }),
  );
  await page.route('**/permission/me/objects/TenantBase.ApprovalProcess', (route) =>
    route.fulfill({ json: flowPermission }),
  );
  await page.route('**/api/tenant/approval/processes**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET') {
      if (url.pathname.endsWith('/processes')) return route.fulfill({ json: { items: [state.flow], page: 1 } });
      state.reads++;
      return route.fulfill({ json: state.flow });
    }
    state.writes.push({
      method: request.method(),
      body: request.postDataJSON() as Record<string, unknown>,
      revision: request.headers()['if-match']!,
      command: request.headers()['idempotency-key']!,
    });
    if (state.mode === 'unknown') return route.abort('failed');
    if (state.mode === 'rejected')
      return route.fulfill({
        status: 422,
        json: { error: { code: 'VALIDATION_FAILED', message: '合成服务端校验拒绝' } },
      });
    if (state.mode === 'conflict') {
      state.flow = {
        ...state.flow,
        revision: state.flow.revision + 1,
        latestVersion: {
          ...state.flow.latestVersion,
          description: '其他人改了流程描述',
          nodes: state.flow.latestVersion.nodes.map((node) => ({ ...node, hideRecords: true })),
        },
      };
      state.mode = 'ok';
      return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT', message: '版本冲突' } } });
    }
    state.flow = {
      ...state.flow,
      revision: state.flow.revision + 1,
      latestVersion: url.pathname.endsWith('/versions')
        ? {
            ...state.flow.latestVersion,
            id: 'a2000000-0000-4000-8000-000000000002',
            versionNo: 2,
            status: 'draft',
            publishedAt: null,
          }
        : { ...state.flow.latestVersion, ...request.postDataJSON() },
    };
    return route.fulfill({ status: url.pathname.endsWith('/versions') ? 201 : 200, json: state.flow });
  });
  return state;
}
async function openDetail(page: Page) {
  await page.goto(path);
  await page.getByRole('link', { name: '合成调动流程', exact: true }).click();
  await expect(page.getByRole('heading', { name: '设计器', exact: true })).toBeVisible();
}

test('AC-FE-F315-07 列表 → 详情 → 修改节点 → 保存 → 重读，使用完整定义及命令头', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL!);
  await openDetail(page);
  await page.getByLabel('节点名称', { exact: true }).fill('修改后的上级审批');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByText('草稿已保存', { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({ method: 'PUT', revision: '4' });
  expect(state.writes[0]!.command).toMatch(/^[0-9a-f-]{36}$/);
  expect(state.flow.latestVersion.nodes[0]?.name).toBe('修改后的上级审批');
  expect(state.flow.latestVersion.conditions).toEqual(flowFixture().latestVersion.conditions);
  expect(state.flow.latestVersion.nodes[1]).toEqual(flowFixture().latestVersion.nodes[1]);
  expect(state.reads).toBeGreaterThanOrEqual(2);
  await page.reload();
  await expect(page.getByLabel('节点名称', { exact: true })).toHaveValue('修改后的上级审批');
  await page.screenshot({ path: test.info().outputPath('flow-designer.png'), fullPage: true });
});
test('AC-FE-F315-08 无流程管理员能力时只读，即使对象按钮有权也不能保存', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL!, false);
  await openDetail(page);
  await expect(page.getByLabel('节点名称', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});
test('AC-FE-F315-09 明确拒绝保留输入，修改后可重提', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL!);
  state.mode = 'rejected';
  await openDetail(page);
  await page.getByLabel('节点名称', { exact: true }).fill('拒绝后保留');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByText('合成服务端校验拒绝', { exact: true })).toBeVisible();
  await expect(page.getByLabel('节点名称', { exact: true })).toHaveValue('拒绝后保留');
  state.mode = 'ok';
  await page.getByLabel('节点名称', { exact: true }).fill('改正后重提');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByText('草稿已保存', { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(2);
  expect(state.writes[0]!.command).not.toBe(state.writes[1]!.command);
});
test('AC-FE-F315-10 冲突重读、核对后重提只覆盖人工改动', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL!);
  state.mode = 'conflict';
  await openDetail(page);
  await page.getByLabel('节点名称', { exact: true }).fill('我的节点名称');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await page.getByRole('button', { name: kernel.reload, exact: true }).click();
  await page.getByRole('button', { name: kernel.confirm, exact: true }).click();
  await expect(page.getByLabel('节点名称', { exact: true })).toHaveValue('我的节点名称');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByText('草稿已保存', { exact: true })).toBeVisible();
  expect(state.writes.map((write) => write.revision)).toEqual(['4', '5']);
  expect(state.flow.latestVersion.description).toBe('其他人改了流程描述');
  expect(state.flow.latestVersion.nodes[0]).toMatchObject({ name: '我的节点名称', hideRecords: true });
});
test('AC-FE-F315-11 结果未知退出重开仍锁定，回查不解锁、不生成新命令', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL!);
  state.mode = 'unknown';
  await openDetail(page);
  await page.getByLabel('节点名称', { exact: true }).fill('未知结果');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByText(kernel.unknown, { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '返回流程列表', exact: true }).click();
  await page.getByRole('link', { name: '合成调动流程', exact: true }).click();
  await expect(page.getByLabel('节点名称', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: kernel.original, exact: true }).click();
  await expect(page.getByText(kernel.originalHint, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeDisabled();
  expect(state.writes).toHaveLength(1);
});
test('AC-FE-F315-12 发布版只读，编辑最新版本生成草稿并保留生效版本', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL!);
  state.flow = {
    ...state.flow,
    latestVersion: { ...state.flow.latestVersion, status: 'published', publishedAt: '2026-10-01T00:00:00Z' },
  };
  state.flow = { ...state.flow, currentVersion: structuredClone(state.flow.latestVersion) };
  await openDetail(page);
  await expect(page.getByLabel('节点名称', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '编辑最新版本', exact: true }).click();
  await expect(page.getByLabel('节点名称', { exact: true })).toBeEnabled();
  expect(state.writes[0]).toMatchObject({ method: 'POST', body: {}, revision: '4' });
  expect(state.flow.currentVersion?.status).toBe('published');
  await page.getByRole('button', { name: '查看生效版本', exact: true }).click();
  await expect(page.getByLabel('节点名称', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toHaveCount(0);
});
test('AC-FE-F315-13 详情节点被裁剪时不展示旧节点，不允许整体覆盖', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL!);
  delete (state.flow.latestVersion as unknown as Record<string, unknown>).nodes;
  await page.goto(`${path}/${flowId}`);
  await expect(page.getByText('节点信息未读取', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});
