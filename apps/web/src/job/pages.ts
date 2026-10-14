import { lazyPage, type ModulePages } from '../foundation/page-registry.js';

export const pages: ModulePages = {
  apps: [
    {
      app: 'job',
      label: '职务体系',
      group: 'people',
      objectCode: 'TenantBase.JobPost',
      page: lazyPage('JobWorkspace', () => import('./JobWorkspace.js')),
    },
  ],
};
