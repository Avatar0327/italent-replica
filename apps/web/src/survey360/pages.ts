import { lazyPage, type ModulePages } from '../foundation/page-registry.js';

export const pages: ModulePages = {
  apps: [
    {
      app: 'survey360',
      label: '360 评估',
      group: 'talent',
      objectCode: 'Survey360.Activity',
      page: lazyPage('SurveyPage', () => import('./SurveyPage.js')),
    },
  ],
};
