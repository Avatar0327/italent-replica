/**
 * 直接依赖图：区域 api-modules-insurance（节点 → 直接依赖，字典序；同文件的依赖写作 #名字；没有依赖的叶子不登记）。
 * 生成文件（F-072）：改源码后用 `ROUTE_POLICY_UPDATE_DIGESTS=1` 重算，不要手改；冲突时取任一侧后重算。
 */
import type { Graph } from '../../../evidence-graph.js';

export const GRAPH: Graph = {
  'apps/api/src/modules/insurance/archive-fold.ts#foldInsuranceEvents': ['#NO_INSURANCE_ORIGIN'],
  'apps/api/src/modules/insurance/archive-fold.ts#foldInsuranceOrigin': [
    'apps/api/src/modules/employment/record-store.ts#rowsOf',
    '#foldInsuranceEvents',
  ],
  'apps/api/src/modules/insurance/archive-fold.ts#insurancePosition': [
    'apps/api/src/modules/employment/record-store.ts#rowsOf',
    'apps/api/src/modules/employment/timeline.ts#loadPlannedEffectiveDate',
    'apps/api/src/modules/employment/timeline.ts#operationKey',
    '#LATEST_DATE',
    '#LATEST_SEQ',
    '#NOT_FOUND_MESSAGE',
  ],
  'apps/api/src/modules/insurance/routes.ts#COMPANY': [
    'packages/domain/src/permission/module-actions.ts#MODULE_OBJECTS',
  ],
  'apps/api/src/modules/insurance/routes.ts#PLAN': ['packages/domain/src/permission/module-actions.ts#MODULE_OBJECTS'],
  'apps/api/src/modules/insurance/routes.ts#PROFILE': [
    'packages/domain/src/permission/module-actions.ts#MODULE_OBJECTS',
  ],
  'apps/api/src/modules/insurance/routes.ts#originQuery': ['apps/api/src/modules/job/fields.ts#businessDate'],
  'apps/api/src/modules/insurance/routes.ts#planQuery': [
    '#regionCode',
    'apps/api/src/modules/job/fields.ts#businessDate',
  ],
  'apps/api/src/modules/insurance/routes.ts#requireView': ['apps/api/src/authorization.ts#requirePermission'],
  'apps/api/src/modules/insurance/routes.ts#route:GET /api/tenant/insurance/companies': [
    'apps/api/src/modules/employment/record-store.ts#rowsOf',
    '#COMPANY',
    '#INSURANCE_BASE',
    '#LIST_LIMIT',
    '#requireView',
    'apps/api/src/modules/permission/module-access.ts#getModuleViewableFields',
    'apps/api/src/modules/permission/module-access.ts#resolveModuleScope',
    'apps/api/src/tenant-context.ts#tenantOf',
  ],
  'apps/api/src/modules/insurance/routes.ts#route:GET /api/tenant/insurance/plans': [
    'apps/api/src/modules/employment/record-store.ts#rowsOf',
    '#INSURANCE_BASE',
    '#LIST_LIMIT',
    '#PLAN',
    '#planQuery',
    '#query',
    '#requireView',
    'apps/api/src/modules/permission/module-access.ts#getModuleViewableFields',
    'apps/api/src/tenant-context.ts#tenantOf',
    'packages/domain/src/tenant-time.ts#tenantLocalDate',
  ],
  'apps/api/src/modules/insurance/routes.ts#route:GET /api/tenant/transfer/insurance-origin': [
    'apps/api/src/modules/employment/context.ts#readPageContext',
    'apps/api/src/modules/employment/record-store.ts#rowsOf',
    'apps/api/src/modules/insurance/archive-fold.ts#NOT_FOUND_MESSAGE',
    'apps/api/src/modules/insurance/archive-fold.ts#foldInsuranceOrigin',
    'apps/api/src/modules/insurance/archive-fold.ts#insurancePosition',
    '#INSURANCE_ORIGIN_PATH',
    '#ORIGIN_FIELDS',
    '#PROFILE',
    '#originQuery',
    '#query',
    '#requireView',
    'apps/api/src/modules/permission/module-access.ts#getModuleViewableFields',
    'apps/api/src/tenant-context.ts#tenantOf',
  ],
};
