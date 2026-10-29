import { lazyPage, type ModulePages } from '../foundation/page-registry.js';
import { configurationUi } from '../config-center/messages.js';
import { approvalEntryObjects, visibleSections } from './page-model.js';

const ApprovalPage = lazyPage('ApprovalPage', () => import('./ApprovalPage.js'));
// 原站审批中心下一层：我的待办 / 我的申请 / 我的委托，管理员另有流程管理 / 管理员委托（DEC-489）。
export const pages: ModulePages = {
  configurations: [
    {
      id: 'processes',
      label: configurationUi.flow,
      section: 'workflow',
      access: { app: 'approval', objectCode: 'TenantBase.ApprovalProcess' },
    },
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
