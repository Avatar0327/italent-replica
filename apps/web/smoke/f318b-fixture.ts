import type { Page } from '@playwright/test';
import { exitRulesOf, type ProcessDefinition } from '@italent/domain';
import { tenant, user, snapshotFixture } from './fixtures.js';
import { fallbackFixture } from '../../../tests/acceptance/support/f304-fixture.js';
import { flowFixture, flowId, flowPermission } from '../../../tests/acceptance/support/f315-fixture.js';

export const sourcePath = `/config-center/workflow/processes/${flowId}`;
export const sourcePeople = [1, 2].map((n) => ({
  userId: `a4000000-0000-4000-8000-00000000000${n}`,
  name: `来源合成人员${n}`,
  code: `SOURCE${n}`,
  departmentName: '合成部门',
  departmentId: 'a5000000-0000-4000-8000-000000000001',
}));
export async function setupSources(page: Page, baseURL: string, single = false, writable = true) {
  await page.context().addCookies([
    { name: 'italent_demo_tenant', value: tenant, url: baseURL },
    { name: 'italent_demo_user', value: user, url: baseURL },
  ]);
  const state = {
    flow: (single ? flowFixture() : fallbackFixture()) as ReturnType<typeof flowFixture>,
    mode: 'ok',
    rejection: '单人节点解析到多名审批人，请使用会签节点',
    writes: [] as { body: ProcessDefinition; command: string; revision: string }[],
  };
  for (const node of state.flow.latestVersion.nodes)
    if (node.kind === 'countersign')
      Object.assign(node, {
        transitionRule: { ...node.transitionRule, rules: exitRulesOf(node.transitionRule, node.exits ?? ['approve']) },
      });
  if (!single)
    Object.assign(state.flow.latestVersion.nodes[0]!, { emptyApproverPolicy: 'specified', emptyApproverSources: [] });
  await installSourcePermissions(page, writable);
  await installSourceCandidates(page);
  await page.route('**/approval/processes**', (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({
        json: new URL(route.request().url()).pathname.endsWith('/processes')
          ? {
              items: [
                {
                  id: state.flow.id,
                  code: state.flow.code,
                  approvalType: state.flow.approvalType,
                  status: state.flow.status,
                  revision: state.flow.revision,
                  presetKey: state.flow.presetKey,
                  currentVersion: null,
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
        json: { error: { code: 'APPROVAL_SOURCE_INVALID', message: state.rejection } },
      });
    if (state.mode === 'conflict') {
      state.mode = 'ok';
      state.flow = { ...state.flow, revision: state.flow.revision + 1 };
      Object.assign(state.flow.latestVersion.nodes[0]!, {
        name: '合成最新节点名称',
        ...(single ? { approver: { type: 'specified', value: sourcePeople[1]!.userId } } : {}),
      });
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

async function installSourcePermissions(page: Page, writable: boolean) {
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
}

async function installSourceCandidates(page: Page) {
  await page.route('**/approval/designer/person-candidates**', (route) => {
    const ids = new URL(route.request().url()).searchParams.get('userIds')?.split(',');
    return route.fulfill({
      json: {
        items: sourcePeople.filter((p) => !ids || ids.includes(p.userId)),
        page: 1,
        pageSize: ids?.length ?? 200,
        hasMore: false,
      },
    });
  });
}
