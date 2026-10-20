/**
 * 直接依赖图：区域 api-modules-hr-analysis（节点 → 直接依赖，字典序；同文件的依赖写作 #名字；没有依赖的叶子不登记）。
 * 生成文件（F-072）：改源码后用 `ROUTE_POLICY_UPDATE_DIGESTS=1` 重算，不要手改；冲突时取任一侧后重算。
 */
import type { Graph } from '../../../evidence-graph.js';

export const GRAPH: Graph = {
  'apps/api/src/modules/hr-analysis/roster-access.ts#CONTRACT_OBJECT': [
    'packages/domain/src/permission/module-actions.ts#MODULE_OBJECTS',
  ],
  'apps/api/src/modules/hr-analysis/roster-access.ts#RECORD_OBJECT': [
    'packages/domain/src/permission/module-actions.ts#MODULE_OBJECTS',
  ],
  'apps/api/src/modules/hr-analysis/roster-access.ts#ROSTER_OBJECT': [
    'packages/domain/src/permission/module-actions.ts#MODULE_OBJECTS',
  ],
  'apps/api/src/modules/hr-analysis/roster-access.ts#SOURCE_OBJECTS': [
    '#CONTRACT_OBJECT',
    '#RECORD_OBJECT',
    'packages/domain/src/personnel/catalog.ts#PERSONNEL_OBJECT',
  ],
  'apps/api/src/modules/hr-analysis/roster-access.ts#requireExportButton': [
    'apps/api/src/authorization.ts#requirePermission',
    '#ROSTER_OBJECT',
    'packages/domain/src/permission/decide.ts#buttonResource',
  ],
  'apps/api/src/modules/hr-analysis/roster-access.ts#rosterAccess': [
    'apps/api/src/authorization.ts#requirePermission',
    '#CONTRACT_OBJECT',
    '#RECORD_OBJECT',
    '#ROSTER_OBJECT',
    '#SOURCE_OBJECTS',
    'apps/api/src/modules/permission/module-access.ts#getModuleViewableFields',
    'apps/api/src/modules/personnel/access.ts#access',
    'packages/domain/src/hr-analysis/roster.ts#ROSTER_COLUMNS',
    'packages/domain/src/hr-analysis/roster.ts#ROSTER_FIXED_COLUMNS',
    'packages/domain/src/personnel/catalog.ts#PERSONNEL_OBJECT',
  ],
  'apps/api/src/modules/hr-analysis/roster-csv.ts#assertExportable': [
    'packages/domain/src/hr-analysis/roster.ts#ROSTER_EXPORT_MAX_ROWS',
  ],
  'apps/api/src/modules/hr-analysis/roster-csv.ts#cell': ['#FORMULA_PREFIX'],
  'apps/api/src/modules/hr-analysis/roster-csv.ts#rosterCsv': [
    '#BOM',
    '#cell',
    'packages/domain/src/hr-analysis/roster.ts#rosterCellText',
  ],
  'apps/api/src/modules/hr-analysis/roster-org.ts#rosterOrganizations': [
    'apps/api/src/modules/org/read-model.ts#resolveOrgPaths',
    'apps/api/src/modules/org/read-model.ts#rowsOf',
    'apps/api/src/modules/org/settings.ts#readOrgSettings',
  ],
  'apps/api/src/modules/hr-analysis/roster-query.ts#countRoster': [
    '#population',
    '#rosterJoins',
    'apps/api/src/modules/personnel/store.ts#rows',
  ],
  'apps/api/src/modules/hr-analysis/roster-query.ts#listRoster': [
    'apps/api/src/modules/hr-analysis/roster-org.ts#rosterOrganizations',
    '#population',
    '#rosterJoins',
    '#rosterRow',
    'apps/api/src/modules/personnel/store.ts#rows',
  ],
  'apps/api/src/modules/hr-analysis/roster-query.ts#population': [
    '#like',
    '#list',
    'apps/api/src/modules/personnel/access.ts#personScope',
    'packages/domain/src/hr-analysis/roster.ts#ROSTER_EMPLOYEE_STATUSES',
    'packages/domain/src/hr-analysis/roster.ts#ROSTER_EMPLOY_TYPES',
  ],
  'apps/api/src/modules/hr-analysis/roster-query.ts#rosterJoins': [
    'apps/api/src/modules/employment/employee-status.ts#ENTRY_LIKE_KINDS',
    'apps/api/src/modules/employment/probation-views.ts#probationInfo',
    'apps/api/src/modules/employment/probation.ts#cycleRegularization',
    '#list',
    'apps/api/src/modules/personnel/employee-read.ts#employeeJoins',
  ],
  'apps/api/src/modules/hr-analysis/roster-query.ts#rosterRow': [
    'apps/api/src/modules/personnel/store.ts#camel',
    'packages/domain/src/hr-analysis/roster.ts#tenureYears',
    'packages/domain/src/personnel/tenure.ts#ageOn',
  ],
  'apps/api/src/modules/hr-analysis/roster-routes.ts#parseQuery': ['#query'],
  'apps/api/src/modules/hr-analysis/roster-routes.ts#query': [
    '#isoDate',
    '#text',
    'packages/domain/src/hr-analysis/roster.ts#ROSTER_EMPLOYEE_STATUSES',
    'packages/domain/src/hr-analysis/roster.ts#ROSTER_EMPLOY_TYPES',
  ],
  'apps/api/src/modules/hr-analysis/roster-routes.ts#requireFilterRights': [
    'apps/api/src/modules/hr-analysis/roster-access.ts#requireFilterField',
  ],
  'apps/api/src/modules/hr-analysis/roster-routes.ts#route:GET /api/tenant/hr-analysis/roster': [
    'apps/api/src/modules/hr-analysis/roster-access.ts#rosterAccess',
    'apps/api/src/modules/hr-analysis/roster-query.ts#countRoster',
    'apps/api/src/modules/hr-analysis/roster-query.ts#listRoster',
    'apps/api/src/modules/hr-analysis/roster-query.ts#trimRosterRow',
    '#BASE',
    '#parseQuery',
    '#requireFilterRights',
    'apps/api/src/modules/job/context.ts#pageQuery',
    'packages/domain/src/tenant-time.ts#tenantLocalDate',
  ],
  'apps/api/src/modules/hr-analysis/roster-routes.ts#route:GET /api/tenant/hr-analysis/roster/export': [
    'apps/api/src/modules/hr-analysis/roster-access.ts#requireExportButton',
    'apps/api/src/modules/hr-analysis/roster-access.ts#rosterAccess',
    'apps/api/src/modules/hr-analysis/roster-csv.ts#assertExportable',
    'apps/api/src/modules/hr-analysis/roster-csv.ts#rosterCsv',
    'apps/api/src/modules/hr-analysis/roster-query.ts#countRoster',
    'apps/api/src/modules/hr-analysis/roster-query.ts#listRoster',
    'apps/api/src/modules/hr-analysis/roster-query.ts#trimRosterRow',
    '#BASE',
    '#parseQuery',
    '#requireFilterRights',
    'packages/domain/src/hr-analysis/roster.ts#ROSTER_EXPORT_MAX_ROWS',
    'packages/domain/src/tenant-time.ts#tenantLocalDate',
  ],
};
