import { lazyPage, type ModulePages } from '../foundation/page-registry.js';

export const pages: ModulePages = {
  apps: [
    {
      app: 'staff',
      label: '员工',
      group: 'people',
      objectCode: 'TenantBase.Employee',
      page: lazyPage('StaffPage', () => import('./StaffPage.js')),
    },
  ],
};
