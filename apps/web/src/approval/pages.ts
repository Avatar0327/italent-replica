import { lazyPage, type ModulePages } from '../foundation/page-registry.js';
import { configurationUi } from '../config-center/messages.js';
import { approvalEntryObjects, visibleSections } from './page-model.js';
// 相对路径引入（同 configuration-registry.ts）：smoke 的页面登记在 Playwright 的 Node 加载器里读本文件，不认源码导出条件。
import { APPROVAL_VARIABLE_APPS } from '../../../../packages/domain/src/approval/type-apps.js';
import { m as variableUi } from './variables/messages.js';

const ApprovalPage = lazyPage('ApprovalPage', () => import('./ApprovalPage.js'));
// F-326 F1：六个应用的应用变量共用一个懒加载页面，应用取自路由（variables/model.ts appFromPath）。
const AppVariablesPage = lazyPage('AppVariablesPage', () => import('./variables/VariablesPage.js'));
// 原站审批中心下一层：我的待办 / 我的申请 / 我的委托，管理员另有流程管理 / 管理员委托（DEC-489）。
export const pages: ModulePages = {
  configurations: [
    {
      id: 'processes',
      label: configurationUi.flow,
      section: 'workflow',
      access: { app: 'approval', objectCode: 'TenantBase.ApprovalProcess' },
      page: lazyPage('ProcessDesigner', () => import('./designer/ProcessDesigner.js')),
    },
    {
      id: 'public-variables',
      label: variableUi.kind.public,
      placement: { kind: 'global' },
      access: { adminMenu: 'matrix.manage' },
      page: lazyPage('PublicVariablesPage', () => import('./variables/VariablesPage.js')),
    },
    ...APPROVAL_VARIABLE_APPS.map((app) => ({
      id: `app-variables-${app}`,
      label: variableUi.kind.application,
      placement: { kind: 'app' as const, app },
      section: 'workflow' as const,
      access: { adminMenu: 'matrix.manage' },
      page: AppVariablesPage,
    })),
  ],
  apps: [
    {
      app: 'approval',
      label: '审批中心',
      group: 'work',
      page: ApprovalPage,
      children: (snapshot, route) => {
        return visibleSections(approvalEntryObjects(snapshot)).map((section) => ({
          key: `approval-${section.key}`,
          label: section.label,
          path: section.path,
          group: route.group,
        }));
      },
    },
  ],
  routes: [{ path: '/approval/*', page: ApprovalPage }],
};
