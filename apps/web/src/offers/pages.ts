import { lazyPage, type ModulePages } from '../foundation/page-registry.js';
import { m } from './messages.js';
// DEC-538：BE-14 未接线，按派发挂在任职应用；可见性仍取服务端 entryObjects。
export const pages: ModulePages = {
  entries: [
    {
      id: 'offers',
      app: 'transfer',
      label: m.title,
      group: 'people',
      objectCode: 'TenantBase.EmploymentRecord',
      page: lazyPage('OffersPage', () => import('./OffersPage.js')),
    },
  ],
};
