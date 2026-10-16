import { lazyPage, type ModulePages } from '../foundation/page-registry.js';
import { m } from './messages.js';
export const pages: ModulePages = {
  entries: [
    {
      id: 'entries',
      app: 'transfer',
      label: m.title,
      group: 'people',
      objectCode: 'TenantBase.EmploymentRecord',
      page: lazyPage('EntriesPage', () => import('./EntriesPage.js')),
    },
  ],
};
