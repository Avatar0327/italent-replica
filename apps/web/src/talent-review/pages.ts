import { lazyPage, type ModulePages } from '../foundation/page-registry.js';

export const pages: ModulePages = {
  apps: [
    {
      app: 'talent-review',
      label: '人才盘点',
      group: 'talent',
      objectCode: 'TalentReview.Project',
      page: lazyPage('TalentReviewPage', () => import('./TalentReviewPage.js')),
      legacy: true,
    },
  ],
};
