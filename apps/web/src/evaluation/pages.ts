import { lazyPage, type ModulePages } from '../foundation/page-registry.js';

export const pages: ModulePages = {
  apps: [
    {
      app: 'evaluation',
      label: '人才评定',
      group: 'talent',
      objectCode: 'TEvaluation.EvaluationActivity',
      page: lazyPage('EvaluationPage', () => import('./EvaluationPage.js')),
    },
  ],
};
