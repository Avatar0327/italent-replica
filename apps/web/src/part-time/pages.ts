import { lazyPage, type ModulePages } from '../foundation/page-registry.js';
import { m } from './messages.js';
import { object } from './model.js';
export const pages: ModulePages = {
  entries: [
    {
      id: 'part-time',
      app: 'transfer',
      group: 'people',
      label: m.title,
      objectCode: object,
      page: lazyPage('PartTimePage', () => import('./PartTimePage.js')),
    },
  ],
};
