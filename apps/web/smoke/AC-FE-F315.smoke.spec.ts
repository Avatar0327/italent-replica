import type { Page } from '@playwright/test';
import { test, expect, tenant, user, snapshotFixture } from './fixtures.js';
import { flowFixture, flowId, flowPermission } from '../../../tests/acceptance/support/f315-fixture.js';
import { messages as kernel } from '../src/foundation/forms/messages.js';

const path = '/config-center/workflow/processes';
function summary(flow: ReturnType<typeof flowFixture>) {
  return {
    id: flow.id,
    code: flow.code,
    approvalType: flow.approvalType,
    status: flow.status,
    revision: flow.revision,
    presetKey: flow.presetKey,
    latestVersion: {
      versionNo: flow.latestVersion.versionNo,
      name: flow.latestVersion.name,
      status: flow.latestVersion.status,
    },
    currentVersion: flow.currentVersion && {
      versionNo: flow.currentVersion.versionNo,
      name: flow.currentVersion.name,
      priority: flow.currentVersion.priority,
      isFallback: flow.currentVersion.isFallback,
    },
  };
}
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
  await installProcessApi(page, state);
  return state;
}
type FlowState = {
  flow: ReturnType<typeof flowFixture>;
  mode: string;
  reads: number;
  writes: { method: string; body: Record<string, unknown>; revision: string; command: string }[];
};
async function installProcessApi(page: Page, state: FlowState) {
  await page.route('**/api/tenant/approval/processes**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET') {
      if (url.pathname.endsWith('/processes'))
        return route.fulfill({
          json: {
            items: [summary(state.flow)],
            page: 1,
          },
        });
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
    if (state.mode === 'invalid-receipt') return route.fulfill({ json: { id: flowId, revision: 5 } });
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
}
async function openDetail(page: Page) {
  await page.goto(path);
  await page.getByRole('link', { name: '合成调动流程', exact: true }).click();
  await expect(page.getByRole('heading', { name: '设计器', exact: true })).toBeVisible();
}

for (const change of ['新增', '重排'] as const) {
  test(`AC-FE-F315-21 冲突重读发现节点${change}时保留输入且不发第二次 PUT`, async ({ page, baseURL }) => {
    const state = await setup(page, baseURL!);
    state.mode = 'conflict';
    await openDetail(page);
    await page.getByRole('textbox', { name: '节点名称', exact: true }).fill('保留旧结构输入');
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await expect(page.getByRole('button', { name: kernel.reload, exact: true })).toBeVisible();
    const nodes = state.flow.latestVersion.nodes;
    state.flow = {
      ...state.flow,
      latestVersion: {
        ...state.flow.latestVersion,
        nodes: change === '新增' ? [...nodes, { ...nodes[0]!, key: 'extra', name: '新增审批' }] : [...nodes].reverse(),
      },
    };
    await page.getByRole('button', { name: kernel.reload, exact: true }).click();
    await expect(page.getByText('流程版本或节点结构已变更，请返回列表重新打开后核对。', { exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: '节点名称', exact: true })).toHaveValue('保留旧结构输入');
    await expect(page.getByRole('button', { name: kernel.confirm, exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeDisabled();
    expect(state.writes.map((write) => write.revision)).toEqual(['4']);
    // 409 已确认失败；重新打开以新结构和新 revision 开始编辑，旧输入不会自动带入。
    await page.getByRole('link', { name: '返回流程列表', exact: true }).click();
    await page.getByRole('link', { name: '合成调动流程', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '节点名称', exact: true })).not.toHaveValue('保留旧结构输入');
    await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeEnabled();
    expect(state.writes).toHaveLength(1);
  });
}

test('AC-FE-F315-22 未知结果退出重开后回查仍按原命令节点结构判断', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL!);
  state.mode = 'unknown';
  await openDetail(page);
  await page.getByRole('textbox', { name: '节点名称', exact: true }).fill('原未知命令输入');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByText(kernel.unknown, { exact: true })).toBeVisible();
  state.flow = {
    ...state.flow,
    revision: 5,
    latestVersion: { ...state.flow.latestVersion, nodes: [...state.flow.latestVersion.nodes].reverse() },
  };
  await page.getByRole('link', { name: '返回流程列表', exact: true }).click();
  await page.getByRole('link', { name: '合成调动流程', exact: true }).click();
  await page.getByRole('button', { name: kernel.original, exact: true }).click();
  await expect(page.getByText('流程版本或节点结构已变更，请返回列表重新打开后核对。', { exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: '流程节点' }).getByRole('button', { name: /上级审批/ }).click();
  await expect(page.getByRole('textbox', { name: '节点名称', exact: true })).toHaveValue('原未知命令输入');
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeDisabled();
  expect(state.writes).toHaveLength(1);
});

test('AC-FE-F315-07 列表 → 详情 → 修改节点 → 保存 → 重读，使用完整定义及命令头', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL!);
  await openDetail(page);
  await page.getByRole('textbox', { name: '节点名称', exact: true }).fill('修改后的上级审批');
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
  await expect(page.getByRole('textbox', { name: '节点名称', exact: true })).toHaveValue('修改后的上级审批');
  await page.screenshot({ path: test.info().outputPath('flow-designer.png'), fullPage: true });
  await page.getByRole('button', { name: '保存草稿', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('flow-node-properties.png'), fullPage: true });
});
test('AC-FE-F315-08 无流程管理员能力时只读，即使对象按钮有权也不能保存', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL!, false);
  await openDetail(page);
  await expect(page.getByRole('textbox', { name: '节点名称', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});
test('AC-FE-F315-09 明确拒绝保留输入，修改后可重提', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL!);
  state.mode = 'rejected';
  await openDetail(page);
  await page.getByRole('textbox', { name: '节点名称', exact: true }).fill('拒绝后保留');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByText('合成服务端校验拒绝', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '节点名称', exact: true })).toHaveValue('拒绝后保留');
  state.mode = 'ok';
  await page.getByRole('textbox', { name: '节点名称', exact: true }).fill('改正后重提');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByText('草稿已保存', { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(2);
  expect(state.writes[0]!.command).not.toBe(state.writes[1]!.command);
});
test('AC-FE-F315-10 冲突重读、核对后重提只覆盖人工改动', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL!);
  state.mode = 'conflict';
  await openDetail(page);
  await page.getByRole('textbox', { name: '节点名称', exact: true }).fill('我的节点名称');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await page.getByRole('button', { name: kernel.reload, exact: true }).click();
  await page.getByRole('button', { name: kernel.confirm, exact: true }).click();
  await expect(page.getByRole('textbox', { name: '节点名称', exact: true })).toHaveValue('我的节点名称');
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
  await page.getByRole('textbox', { name: '节点名称', exact: true }).fill('未知结果');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByText(kernel.unknown, { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '返回流程列表', exact: true }).click();
  // 离开整个模块再回来，未知命令不依赖详情或页面组件的挂载寿命。
  await page
    .getByRole('navigation', { name: '配置中心目录' })
    .getByRole('link', { name: '数据源', exact: true })
    .click();
  state.flow = { ...state.flow, revision: 5 };
  await page
    .getByRole('navigation', { name: '配置中心目录' })
    .getByRole('button', { name: '流程任务管理', exact: true })
    .click();
  await page.getByRole('navigation', { name: '配置中心目录' }).getByRole('link', { name: '流程', exact: true }).click();
  await page.getByRole('link', { name: '合成调动流程', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '节点名称', exact: true })).toBeDisabled();
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
  await expect(page.getByRole('textbox', { name: '节点名称', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '编辑最新版本', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '节点名称', exact: true })).toBeEnabled();
  expect(state.writes[0]).toMatchObject({ method: 'POST', body: {}, revision: '4' });
  expect(state.flow.currentVersion?.status).toBe('published');
  await page.getByRole('button', { name: '查看生效版本', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '节点名称', exact: true })).toBeDisabled();
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
test('AC-FE-F315-15 对象字段不可见时遮蔽嵌套回执，记录仍可打开', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL!);
  await page.route('**/permission/me/objects/TenantBase.ApprovalProcess', (route) =>
    route.fulfill({
      json: {
        ...flowPermission,
        viewableFields: [],
        editableFields: [],
      },
    }),
  );
  await page.goto(path);
  await expect(page.getByText('合成调动流程', { exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: '未读取', exact: true }).click();
  await expect(page.getByText('合成调动流程', { exact: true })).toHaveCount(0);
  await expect(page.getByText('合成验收数据', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '流程节点' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});
test('AC-FE-F315-16 成功状态码但回执不完整仍为未知，不伪造保存成功', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL!);
  state.mode = 'invalid-receipt';
  await openDetail(page);
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByText(kernel.unknown, { exact: true })).toBeVisible();
  await expect(page.getByText('草稿已保存', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeDisabled();
});
test('AC-FE-F315-17 冲突重读发现旧节点已删除时保留输入并阻止重提', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL!);
  state.mode = 'conflict';
  await openDetail(page);
  await page.getByRole('textbox', { name: '节点名称', exact: true }).fill('保留我的节点名称');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByRole('button', { name: kernel.reload, exact: true })).toBeVisible();
  state.flow = {
    ...state.flow,
    latestVersion: { ...state.flow.latestVersion, nodes: state.flow.latestVersion.nodes.slice(1) },
  };
  await page.getByRole('button', { name: kernel.reload, exact: true }).click();
  await expect(page.getByText('流程版本或节点结构已变更，请返回列表重新打开后核对。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: kernel.confirm, exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '节点名称', exact: true })).toHaveValue('保留我的节点名称');
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeDisabled();
  expect(state.writes).toHaveLength(1);
});
test('AC-FE-F315-18 废弃流程只读；详情 403/404 有明确状态', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL!);
  state.flow = { ...state.flow, status: 'discarded' };
  await openDetail(page);
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toHaveCount(0);
  for (const [status, code, message] of [
    [403, 'FORBIDDEN', '暂无访问权限'],
    [404, 'NOT_FOUND', '页面或记录不存在'],
  ] as const) {
    await page.route(`**/approval/processes/${flowId}`, (route) =>
      route.fulfill({ status, json: { error: { code } } }),
    );
    await page.reload();
    await expect(page.getByText(message, { exact: true })).toBeVisible();
  }
  expect(state.writes).toHaveLength(0);
});
test('AC-FE-F315-19 配置字面值不按枚举翻译，枚举仍显示中文', async ({ page, baseURL }) => {
  const state = await setup(page, baseURL!);
  const version = state.flow.latestVersion;
  state.flow = {
    ...state.flow,
    latestVersion: {
      ...version,
      conditions: {
        ...version.conditions,
        items: version.conditions.items.map((item) => ({ ...item, value: 'approve' })),
      },
      nodes: version.nodes.map((node) => ({
        ...node,
        formFields: ['transfer'],
        messageRules: node.messageRules.map((rule) => ({ ...rule, template: 'owner' })),
      })),
    },
  };
  await openDetail(page);
  await page.getByText('发起条件', { exact: true }).click();
  await expect(page.getByRole('cell', { name: 'approve', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '等于', exact: true })).toBeVisible();
  await page.getByText('其他节点配置（只读）', { exact: true }).first().click();
  await expect(page.getByText('transfer', { exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'owner', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '到达节点', exact: true })).toBeVisible();
});
