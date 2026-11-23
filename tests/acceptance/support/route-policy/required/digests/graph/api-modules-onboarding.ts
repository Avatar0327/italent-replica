/**
 * 直接依赖图：区域 api-modules-onboarding（节点 → 直接依赖，字典序；同文件的依赖写作 #名字；没有依赖的叶子不登记）。
 * 生成文件（F-072）：改源码后用 `ROUTE_POLICY_UPDATE_DIGESTS=1` 重算，不要手改；冲突时取任一侧后重算。
 */
import type { Graph } from '../../../evidence-graph.js';

export const GRAPH: Graph = {
  'apps/api/src/modules/onboarding/approval-contract.ts#entryInfoCollectionAdapter': ['#unavailable'],
  'apps/api/src/modules/onboarding/integration-pool-access.ts#POOL_SETTINGS': [
    'packages/domain/src/permission/module-actions.ts#MODULE_OBJECTS',
  ],
  'apps/api/src/modules/onboarding/integration-pool-access.ts#poolAvailableActions': ['#POOL_FIELDS', '#POOL_SETTINGS'],
  'apps/api/src/modules/onboarding/integration-pool-access.ts#requirePoolView': [
    'apps/api/src/authorization.ts#requirePermission',
    '#POOL_FIELDS',
    '#POOL_SETTINGS',
  ],
  'apps/api/src/modules/onboarding/integration-pool-access.ts#requirePoolWrite': [
    'apps/api/src/authorization.ts#requirePermission',
    '#POOL_SETTINGS',
    '#POOL_WRITE_ALIAS',
    'apps/api/src/modules/permission/object-write.ts#requireObjectWrite',
  ],
  'apps/api/src/modules/onboarding/integration-pool-input.ts#actionSchema': [
    '#formField',
    'packages/domain/src/employment/assessment.ts#ASSESSMENT_NAME_MAX',
  ],
  'apps/api/src/modules/onboarding/integration-pool-input.ts#checkIntegrationPoolAction': [
    '#actionSchema',
    '#categoryEnabled',
  ],
  'apps/api/src/modules/onboarding/integration-pool-input.ts#formField': ['#fieldCode'],
  'apps/api/src/modules/onboarding/integration-pool-input.ts#integrationPoolOptions': [
    '#categoryEnabled',
    '#names',
    'packages/domain/src/employment/assessment.ts#ASSESSMENT_TYPES',
  ],
  'apps/api/src/modules/onboarding/integration-pool-input.ts#poolCreateBody': ['#poolCategory'],
  'apps/api/src/modules/onboarding/integration-pool-input.ts#poolPatchBody': ['#poolCreateBody'],
  'apps/api/src/modules/onboarding/integration-pool-result.ts#INTEGRATION_POOL_COMMAND_RESULTS': [
    'apps/api/src/modules/onboarding/integration-pool-access.ts#requirePoolWrite',
    '#POOL_RESULT_TYPES',
    '#receipt',
    'apps/api/src/modules/onboarding/integration-pool.ts#readIntegrationPoolTask',
    'apps/api/src/modules/permission/module-access.ts#authorizeInTransaction',
  ],
  'apps/api/src/modules/onboarding/integration-pool-result.ts#POOL_RESULT_TYPES': [
    'apps/api/src/modules/onboarding/integration-pool-access.ts#INTEGRATION_POOL_PATH',
  ],
  'apps/api/src/modules/onboarding/integration-pool-routes.ts#poolContext': ['apps/api/src/tenant-context.ts#tenantOf'],
  'apps/api/src/modules/onboarding/integration-pool-routes.ts#poolQuery': [
    'apps/api/src/modules/job/context.ts#pageQuery',
    'apps/api/src/modules/onboarding/integration-pool-input.ts#poolCategory',
  ],
  'apps/api/src/modules/onboarding/integration-pool-routes.ts#poolWrite': [
    'apps/api/src/modules/job/context.ts#revision',
    'apps/api/src/modules/onboarding/integration-pool-access.ts#requirePoolWrite',
    'apps/api/src/modules/permission/module-access.ts#authorizeInTransaction',
    'apps/api/src/tenant-context.ts#tenantOf',
  ],
  'apps/api/src/modules/onboarding/integration-pool-routes.ts#route:DELETE /:id': [
    'apps/api/src/modules/job/context.ts#parseBody',
    'apps/api/src/modules/job/context.ts#uuidParam',
    '#emptyDeleteBody',
    '#poolContext',
    '#poolWrite',
    'apps/api/src/modules/onboarding/integration-pool.ts#deleteIntegrationPoolTask',
  ],
  'apps/api/src/modules/onboarding/integration-pool-routes.ts#route:GET /': [
    'apps/api/src/modules/onboarding/integration-pool-access.ts#poolAvailableActions',
    'apps/api/src/modules/onboarding/integration-pool-access.ts#requirePoolView',
    '#poolQuery',
    'apps/api/src/modules/onboarding/integration-pool.ts#listIntegrationPoolTasks',
    'apps/api/src/modules/onboarding/integration-pool.ts#poolTaskView',
    'apps/api/src/modules/permission/module-access.ts#authorizeInTransaction',
    'apps/api/src/tenant-context.ts#tenantOf',
  ],
  'apps/api/src/modules/onboarding/integration-pool-routes.ts#route:GET /:id': [
    'apps/api/src/modules/job/context.ts#uuidParam',
    'apps/api/src/modules/onboarding/integration-pool-access.ts#poolAvailableActions',
    'apps/api/src/modules/onboarding/integration-pool-access.ts#requirePoolView',
    'apps/api/src/modules/onboarding/integration-pool.ts#poolTaskView',
    'apps/api/src/modules/onboarding/integration-pool.ts#readIntegrationPoolTask',
    'apps/api/src/modules/permission/module-access.ts#authorizeInTransaction',
    'apps/api/src/tenant-context.ts#tenantOf',
  ],
  'apps/api/src/modules/onboarding/integration-pool-routes.ts#route:GET /categories': [
    'apps/api/src/modules/onboarding/integration-pool-access.ts#requirePoolView',
    'apps/api/src/modules/onboarding/integration-pool-input.ts#integrationPoolOptions',
    'apps/api/src/modules/permission/module-access.ts#authorizeInTransaction',
    'apps/api/src/tenant-context.ts#tenantOf',
  ],
  'apps/api/src/modules/onboarding/integration-pool-routes.ts#route:PATCH /:id': [
    'apps/api/src/modules/job/context.ts#parseBody',
    'apps/api/src/modules/job/context.ts#uuidParam',
    'apps/api/src/modules/onboarding/integration-pool-input.ts#poolPatchBody',
    '#poolContext',
    '#poolWrite',
    '#poolWriteResponse',
    'apps/api/src/modules/onboarding/integration-pool.ts#updateIntegrationPoolTask',
  ],
  'apps/api/src/modules/onboarding/integration-pool-routes.ts#route:POST /': [
    'apps/api/src/modules/job/context.ts#parseBody',
    'apps/api/src/modules/onboarding/integration-pool-input.ts#poolCreateBody',
    '#poolContext',
    '#poolWrite',
    '#poolWriteResponse',
    'apps/api/src/modules/onboarding/integration-pool.ts#createIntegrationPoolTask',
  ],
  'apps/api/src/modules/onboarding/integration-pool.ts#auditPoolTask': [
    'apps/api/src/audit/record.ts#recordAudit',
    '#poolTaskView',
  ],
  'apps/api/src/modules/onboarding/integration-pool.ts#createIntegrationPoolTask': [
    'apps/api/src/modules/job/context.ts#requireNew',
    'apps/api/src/modules/onboarding/integration-pool-input.ts#checkIntegrationPoolAction',
    '#actionColumns',
    '#auditPoolTask',
    '#receipt',
  ],
  'apps/api/src/modules/onboarding/integration-pool.ts#deleteIntegrationPoolTask': [
    '#auditPoolTask',
    '#lockAtRevision',
    '#receipt',
  ],
  'apps/api/src/modules/onboarding/integration-pool.ts#lockAtRevision': ['#getPoolTask'],
  'apps/api/src/modules/onboarding/integration-pool.ts#poolTaskView': ['#storedAction'],
  'apps/api/src/modules/onboarding/integration-pool.ts#readIntegrationPoolTask': ['#getPoolTask'],
  'apps/api/src/modules/onboarding/integration-pool.ts#updateIntegrationPoolTask': [
    'apps/api/src/modules/onboarding/integration-pool-input.ts#checkIntegrationPoolAction',
    '#actionColumns',
    '#auditPoolTask',
    '#lockAtRevision',
    '#receipt',
    '#storedAction',
  ],
};
