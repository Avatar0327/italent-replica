import { HR_DASHBOARD_OBJECT } from '@italent/domain';
import { lazyPage, type ModulePages } from '../foundation/page-registry.js';
import { m } from './messages.js';

export const dashboardPath = '/hr-dashboard';
export const deliveredTabs = [{ path: 'management', label: m.management, objectCode: HR_DASHBOARD_OBJECT }] as const;

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
        {
          id: 'hr-dashboard',
          label: m.dashboard,
          objectCodes: deliveredTabs.map((tab) => tab.objectCode),
          page: lazyPage('HrDashboardPage', () => import('./HrDashboardPage.js')),
        },
      ],
    },
  ],
};
