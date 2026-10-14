import { lazyPage, type ModulePages } from '../foundation/page-registry.js';

export const pages: ModulePages = {
  apps: [
    {
      app: 'talent',
      label: '人才标准',
      group: 'talent',
      objectCode: 'TalentCenter.DimensionLibrary',
      page: lazyPage('TalentPage', () => import('./TalentPage.js')),
      legacy: true,
    },
  ],
};
