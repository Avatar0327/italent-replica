import { lazyPage, type ModulePages } from '../foundation/page-registry.js';

export const pages: ModulePages = {
  apps: [
    {
      app: 'approval',
      label: '审批中心',
      group: 'work',
      page: lazyPage('ApprovalPage', () => import('./ApprovalPage.js')),
    },
  ],
};
