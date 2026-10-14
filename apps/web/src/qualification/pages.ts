import { lazyPage, type ModulePages } from '../foundation/page-registry.js';

export const pages: ModulePages = {
  apps: [
    {
      app: 'qualification',
      label: '任职资格',
      group: 'talent',
      objectCode: 'Qualification.EmploymentCategory',
      page: lazyPage('QualificationPage', () => import('./QualificationPage.js')),
      legacy: true,
    },
  ],
};
