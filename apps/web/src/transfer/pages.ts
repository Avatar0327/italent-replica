import { lazyPage, type ModulePages } from '../foundation/page-registry.js';

export const pages: ModulePages = {
  apps: [
    {
      app: 'transfer',
      label: '调动管理',
      group: 'people',
      objectCode: 'TenantBase.EmploymentRecord',
      page: lazyPage('TransferPage', () => import('./TransferPage.js')),
    },
  ],
};
