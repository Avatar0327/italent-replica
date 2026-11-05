import { lazyPage, type ModulePages } from '../foundation/page-registry.js';
import { m } from './messages.js';
export const pages: ModulePages = {
  entries: [
    {
      id: 'hr-reports',
      app: 'staff',
      group: 'people',
      label: m.title,
      objectCodes: ['TenantBase.HrRoster', 'TenantBase.HrMovementReport', 'TenantBase.HrStructureReport'],
      page: lazyPage('HrReportsPage', () => import('./HrReportsPage.js')),
    },
  ],
};
