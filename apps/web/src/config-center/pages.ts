import { lazyPage, type ModulePages } from '../foundation/page-registry.js';

export const pages: ModulePages = {
  routes: [
    {
      path: '/config-center/*',
      page: lazyPage('ConfigurationCenter', () => import('./ConfigurationCenter.js')),
    },
  ],
};
