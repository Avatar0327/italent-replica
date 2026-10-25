import type { Page } from '@playwright/test';
import type { ProcessDefinition } from '@italent/domain';
import { tenant, user, snapshotFixture } from './fixtures.js';
import { fallbackFixture } from '../../../tests/acceptance/support/f304-fixture.js';
import { flowFixture, flowId, flowPermission } from '../../../tests/acceptance/support/f315-fixture.js';

export const sourcePath = `/config-center/workflow/processes/${flowId}`;
export const sourcePeople = [1, 2].map((n) => ({
  userId: `a4000000-0000-4000-8000-00000000000${n}`,
  name: `来源合成人员${n}`,
  code: `SOURCE${n}`,
  departmentName: '合成部门',
}));
export async function setupSources(page: Page, baseURL: string, single = false, writable = true) {
  await page.context().addCookies([
    { name: 'italent_demo_tenant', value: tenant, url: baseURL },
    { name: 'italent_demo_user', value: user, url: baseURL },
  ]);
  const state = {
    flow: single ? flowFixture() : fallbackFixture(),
    mode: 'ok',
    writes: [] as { body: ProcessDefinition; command: string; revision: string }[],
  };
  if (!single)
    Object.assign(state.flow.latestVersion.nodes[0]!, { emptyApproverPolicy: 'specified', emptyApproverSources: [] });
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
      json: { ...flowPermission, editableFields: writable ? ['nodes'] : [] },
    }),
  );
  await page.route('**/approval/designer/person-candidates**', (route) => {
    const ids = new URL(route.request().url()).searchParams.get('userIds')?.split(',');
    return route.fulfill({
      json: { items: sourcePeople.filter((p) => !ids || ids.includes(p.userId)), page: 1, hasMore: false },
    });
  });
  await page.route('**/approval/processes**', (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({
        json: new URL(route.request().url()).pathname.endsWith('/processes')
          ? {
              items: [
                {
                  ...state.flow,
                  latestVersion: { name: state.flow.latestVersion.name, versionNo: 1, status: 'draft' },
                },
              ],
              page: 1,
            }
          : state.flow,
      });
    const body = route.request().postDataJSON() as ProcessDefinition;
    state.writes.push({
      body,
      command: route.request().headers()['idempotency-key']!,
      revision: route.request().headers()['if-match']!,
    });
    if (state.mode === 'unknown') return route.abort('failed');
    if (state.mode === '422')
      return route.fulfill({
        status: 422,
        json: { error: { code: 'APPROVAL_SOURCE_INVALID', message: '单人节点解析到多名审批人，请使用会签节点' } },
      });
    if (state.mode === 'conflict') {
      state.mode = 'ok';
      state.flow.revision++;
      Object.assign(state.flow.latestVersion.nodes[0]!, { name: '合成最新节点名称' });
      return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CONFLICT', message: '版本冲突' } } });
    }
    state.flow = {
      ...state.flow,
      revision: state.flow.revision + 1,
      latestVersion: { ...state.flow.latestVersion, ...body },
    };
    return route.fulfill({ json: state.mode === 'bad-receipt' ? { id: state.flow.id } : state.flow });
  });
  return state;
}
