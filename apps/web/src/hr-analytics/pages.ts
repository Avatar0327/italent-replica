import {
  CONTRACT_BOARD_OBJECT,
  HR_DASHBOARD_OBJECT,
  HR_MOVEMENT_REPORT_OBJECT,
  HR_STRUCTURE_OBJECT,
} from '@italent/domain';
import { lazyPage, type ModulePages } from '../foundation/page-registry.js';
import { m as reports } from '../hr-reports/messages.js';
import { m } from './messages.js';

export const dashboardPath = '/hr-dashboard';
export const deliveredTabs = [
  { path: 'management', label: m.management, objectCode: HR_DASHBOARD_OBJECT },
  { path: 'structure', label: m.structure, objectCode: HR_STRUCTURE_OBJECT },
] as const;

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
        {
          id: 'hr-structure-reports',
          label: reports.structureReports,
          objectCode: 'TenantBase.HrStructureReport',
          page: lazyPage('HrStructureReportsPage', () => import('../hr-reports/HrStructureReportsPage.js')),
        },
        {
          id: 'hr-movement-reports',
          label: reports.movementReports,
          objectCode: HR_MOVEMENT_REPORT_OBJECT,
          page: lazyPage('HrMovementReportsPage', () => import('../hr-reports/HrMovementReportsPage.js')),
        },
        {
          id: 'hr-contract-board',
          label: m.contract.title,
          objectCode: CONTRACT_BOARD_OBJECT,
          page: lazyPage('HrContractBoardPage', () => import('./HrContractBoardPage.js')),
        },
      ],
    },
  ],
};
