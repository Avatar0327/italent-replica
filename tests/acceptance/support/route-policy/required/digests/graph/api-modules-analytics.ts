/**
 * 直接依赖图：区域 api-modules-analytics（节点 → 直接依赖，字典序；同文件的依赖写作 #名字；没有依赖的叶子不登记）。
 * 生成文件（F-072）：改源码后用 `ROUTE_POLICY_UPDATE_DIGESTS=1` 重算，不要手改；冲突时取任一侧后重算。
 */
import type { Graph } from '../../../evidence-graph.js';

export const GRAPH: Graph = {
  'apps/api/src/modules/analytics/hr-dashboard-routes.ts#dashboardContext': [
    '#asOfSchema',
    'apps/api/src/modules/permission/module-route-access.ts#objectContext',
    'apps/api/src/modules/permission/module-route-access.ts#requestScope',
    'packages/domain/src/analytics/hr-dashboard.ts#HR_DASHBOARD_OBJECT',
    'packages/domain/src/tenant-time.ts#tenantLocalDate',
  ],
  'apps/api/src/modules/analytics/hr-dashboard-routes.ts#route:GET /api/tenant/analytics/hr-dashboard': [
    '#HR_DASHBOARD_BASE',
    '#dashboardContext',
    'apps/api/src/modules/analytics/hr-dashboard.ts#dashboardRenewalTypes',
    'apps/api/src/modules/analytics/hr-dashboard.ts#hrDashboardCounts',
    'packages/domain/src/analytics/hr-dashboard.ts#HR_DASHBOARD_INDICATORS',
  ],
  'apps/api/src/modules/analytics/hr-dashboard-routes.ts#route:GET /api/tenant/analytics/hr-dashboard/indicators/:code':
    [
      '#HR_DASHBOARD_BASE',
      '#dashboardContext',
      'apps/api/src/modules/analytics/hr-dashboard.ts#dashboardRenewalTypes',
      'apps/api/src/modules/analytics/hr-dashboard.ts#hrDashboardPage',
      'apps/api/src/modules/job/context.ts#pageQuery',
      'packages/domain/src/analytics/hr-dashboard.ts#HR_DASHBOARD_INDICATORS',
    ],
  'apps/api/src/modules/analytics/hr-dashboard.ts#METRICS': [
    '#NULL_UUID',
    '#WORKING_TYPES',
    '#business',
    '#config',
    '#contracts',
    '#current',
    '#departments',
    '#employType',
    '#entries',
    '#exits',
    '#finished',
    '#inService',
    '#monthStart',
    '#noWorkStartDate',
    '#offerRows',
    '#pick',
    '#probation',
    '#processing',
    '#soonEnd',
    '#viewIs',
    '#yearStart',
    'apps/api/src/modules/contracts/queries.ts#expiredUnrenewedContract',
    'apps/api/src/modules/contracts/queries.ts#expiringContract',
    'packages/domain/src/analytics/hr-dashboard.ts#HR_DASHBOARD_SOON_DAYS',
    'packages/domain/src/contracts/rules.ts#addDays',
  ],
  'apps/api/src/modules/analytics/hr-dashboard.ts#business': ['#SUBMITTED_OR_DIRECT_JOIN', '#pick'],
  'apps/api/src/modules/analytics/hr-dashboard.ts#contracts': ['#NULL_UUID', '#pick'],
  'apps/api/src/modules/analytics/hr-dashboard.ts#dashboardRenewalTypes': [
    'apps/api/src/modules/contracts/configuration.ts#settings',
  ],
  'apps/api/src/modules/analytics/hr-dashboard.ts#departments': ['#NULL_UUID', '#pick'],
  'apps/api/src/modules/analytics/hr-dashboard.ts#employType': ['#current', '#list'],
  'apps/api/src/modules/analytics/hr-dashboard.ts#entries': [
    '#SNAPSHOT',
    '#WORKING_TYPES',
    '#current',
    '#employType',
    '#list',
    '#pick',
    'apps/api/src/modules/employment/employee-status.ts#ENTRY_KINDS',
    'apps/api/src/modules/employment/entry-views.ts#entryViewPredicate',
  ],
  'apps/api/src/modules/analytics/hr-dashboard.ts#exitSource': [
    '#CYCLE_JOIN',
    'apps/api/src/modules/employment/exit-queries.ts#LEAVE_SOURCE',
    'apps/api/src/modules/employment/retirement-views.ts#RETIREMENT_SOURCE',
    'apps/api/src/modules/employment/retirement-views.ts#SUBMITTED_AT_JOIN',
  ],
  'apps/api/src/modules/analytics/hr-dashboard.ts#exits': [
    '#exitSource',
    '#pick',
    'apps/api/src/modules/employment/exit-queries.ts#candidates',
  ],
  'apps/api/src/modules/analytics/hr-dashboard.ts#finished': ['#WORKING_TYPES', '#list'],
  'apps/api/src/modules/analytics/hr-dashboard.ts#hrDashboardCounts': [
    '#indicatorRows',
    'apps/api/src/modules/employment/read-model.ts#rowsOf',
    'packages/domain/src/analytics/hr-dashboard.ts#HR_DASHBOARD_INDICATORS',
  ],
  'apps/api/src/modules/analytics/hr-dashboard.ts#hrDashboardPage': [
    '#indicatorRows',
    'apps/api/src/modules/employment/read-model.ts#rowsOf',
  ],
  'apps/api/src/modules/analytics/hr-dashboard.ts#inService': [
    '#SNAPSHOT',
    '#current',
    '#pick',
    'packages/domain/src/employment/employee-status.ts#EMPLOYEE_STATUS',
  ],
  'apps/api/src/modules/analytics/hr-dashboard.ts#indicatorRows': ['#METRICS', '#visible'],
  'apps/api/src/modules/analytics/hr-dashboard.ts#noWorkStartDate': ['#dayEnd'],
  'apps/api/src/modules/analytics/hr-dashboard.ts#offerRows': ['#NULL_UUID', '#pick'],
  'apps/api/src/modules/analytics/hr-dashboard.ts#pick': ['#NULL_UUID'],
  'apps/api/src/modules/analytics/hr-dashboard.ts#probation': [
    '#pick',
    'apps/api/src/modules/employment/probation-views.ts#probationViewRows',
  ],
  'apps/api/src/modules/analytics/hr-dashboard.ts#processing': [
    'apps/api/src/modules/employment/retirement-views.ts#billPredicate',
  ],
  'apps/api/src/modules/analytics/hr-dashboard.ts#soonEnd': [
    'packages/domain/src/analytics/hr-dashboard.ts#HR_DASHBOARD_SOON_DAYS',
    'packages/domain/src/contracts/rules.ts#addDays',
  ],
  'apps/api/src/modules/analytics/hr-dashboard.ts#viewIs': [
    'apps/api/src/modules/offer/service.ts#offerViewConditions',
    'packages/domain/src/offer/views.ts#offerView',
  ],
  'apps/api/src/modules/analytics/hr-dashboard.ts#visible': [
    'apps/api/src/modules/employment/context.ts#employmentCreator',
    'apps/api/src/modules/employment/visibility.ts#employmentVisibilitySql',
    'apps/api/src/modules/permission/module-access.ts#scopeSql',
  ],
};
