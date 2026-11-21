import { lazyPage, type ModulePages } from '../foundation/page-registry.js';
import { m } from './messages.js';

export const pages: ModulePages = {
  entries: [
    {
      id: 'hr-analytics',
      app: 'staff',
      group: 'people',
      label: m.analytics,
      children: [
        {
          id: 'hr-analytics-roster',
          label: m.roster,
          objectCode: 'TenantBase.HrRoster',
          page: lazyPage('HrAnalyticsRosterPage', () => import('./HrAnalyticsRosterPage.js')),
        },
      ],
    },
  ],
};
