/**
 * 直接依赖图：区域 api-modules-esign（节点 → 直接依赖，字典序；同文件的依赖写作 #名字；没有依赖的叶子不登记）。
 * 生成文件（F-072）：改源码后用 `ROUTE_POLICY_UPDATE_DIGESTS=1` 重算，不要手改；冲突时取任一侧后重算。
 */
import type { Graph } from '../../../evidence-graph.js';

export const GRAPH: Graph = {
  'apps/api/src/modules/esign/input.ts#createTemplateSchema': ['#body', '#name', '#sortOrder'],
  'apps/api/src/modules/esign/input.ts#patchTemplateSchema': ['#body', '#name', '#sortOrder'],
  'apps/api/src/modules/esign/input.ts#sceneSettingsSchema': [
    'packages/domain/src/esign/settings.ts#ESIGN_VALIDITY_DAYS_MAX',
    'packages/domain/src/esign/settings.ts#ESIGN_VALIDITY_DAYS_MIN',
  ],
  'apps/api/src/modules/esign/routes.ts#OBJECT': ['packages/domain/src/permission/module-actions.ts#MODULE_OBJECTS'],
  'apps/api/src/modules/esign/routes.ts#route:GET /api/tenant/esign/scenes/transfer': [
    '#ESIGN_BASE',
    '#OBJECT',
    '#trim',
    'apps/api/src/modules/esign/service.ts#getSceneSettings',
    'apps/api/src/modules/permission/module-route-access.ts#objectContext',
  ],
  'apps/api/src/modules/esign/routes.ts#route:GET /api/tenant/esign/template-options/transfer-form': [
    'apps/api/src/modules/employment/context.ts#EMPLOYMENT_OBJECT',
    '#ESIGN_BASE',
    '#TRANSFER_HR_BUTTON',
    'apps/api/src/modules/esign/service.ts#templateOptions',
    'apps/api/src/modules/permission/module-route-access.ts#button',
    'apps/api/src/modules/permission/module-route-access.ts#objectContext',
  ],
  'apps/api/src/modules/esign/routes.ts#route:GET /api/tenant/esign/templates': [
    '#ESIGN_BASE',
    '#OBJECT',
    '#trim',
    'apps/api/src/modules/esign/service.ts#listTemplates',
    'apps/api/src/modules/permission/module-route-access.ts#objectContext',
  ],
  'apps/api/src/modules/esign/routes.ts#route:PATCH /api/tenant/esign/templates/:id': [
    'apps/api/src/modules/esign/input.ts#patchTemplateSchema',
    '#ESIGN_BASE',
    '#OBJECT',
    '#write',
    'apps/api/src/modules/esign/service.ts#assertKnownVariables',
    'apps/api/src/modules/esign/service.ts#patchTemplate',
    'apps/api/src/modules/job/context.ts#parseBody',
    'apps/api/src/modules/job/context.ts#revision',
    'apps/api/src/modules/job/context.ts#uuidParam',
    'apps/api/src/modules/permission/module-route-access.ts#objectContext',
    'apps/api/src/modules/permission/module-route-access.ts#writeFields',
  ],
  'apps/api/src/modules/esign/routes.ts#route:POST /api/tenant/esign/templates': [
    'apps/api/src/modules/esign/input.ts#createTemplateSchema',
    '#ESIGN_BASE',
    '#OBJECT',
    '#write',
    'apps/api/src/modules/esign/service.ts#assertKnownVariables',
    'apps/api/src/modules/esign/service.ts#createTemplate',
    'apps/api/src/modules/job/context.ts#parseBody',
    'apps/api/src/modules/permission/module-route-access.ts#objectContext',
    'apps/api/src/modules/permission/module-route-access.ts#writeFields',
  ],
  'apps/api/src/modules/esign/routes.ts#route:PUT /api/tenant/esign/scenes/transfer': [
    'apps/api/src/modules/esign/input.ts#sceneSettingsSchema',
    '#ESIGN_BASE',
    '#OBJECT',
    '#write',
    'apps/api/src/modules/esign/service.ts#saveSceneSettings',
    'apps/api/src/modules/job/context.ts#parseBody',
    'apps/api/src/modules/job/context.ts#revision',
    'apps/api/src/modules/permission/module-route-access.ts#objectContext',
    'apps/api/src/modules/permission/module-route-access.ts#writeFields',
  ],
  'apps/api/src/modules/esign/routes.ts#trim': [
    '#OBJECT',
    'apps/api/src/modules/permission/module-access.ts#getModuleViewableFields',
    'apps/api/src/tenant-context.ts#tenantOf',
  ],
  'apps/api/src/modules/esign/routes.ts#write': [
    'apps/api/src/authorization.ts#requirePermission',
    '#OBJECT',
    '#trim',
    'apps/api/src/modules/permission/module-access.ts#authorizeInTransaction',
  ],
  'apps/api/src/modules/esign/service.ts#assertKnownVariables': [
    'packages/domain/src/esign/variables.ts#unknownTemplateVariables',
  ],
  'apps/api/src/modules/esign/service.ts#auditTemplate': [
    'apps/api/src/audit/record.ts#recordAudit',
    '#ESIGN_TEMPLATE_AUDIT_TYPE',
    'apps/api/src/system-actor.ts#auditActor',
  ],
  'apps/api/src/modules/esign/service.ts#createTemplate': ['#assertUnique', '#auditTemplate', '#lockConfig', '#view'],
  'apps/api/src/modules/esign/service.ts#getSceneSettings': [
    'packages/domain/src/esign/settings.ts#ESIGN_DEFAULT_REMIND_BEFORE_EXPIRY',
    'packages/domain/src/esign/settings.ts#ESIGN_DEFAULT_VALIDITY_DAYS',
  ],
  'apps/api/src/modules/esign/service.ts#listTemplates': ['#ordered', '#view'],
  'apps/api/src/modules/esign/service.ts#lockConfig': [
    'apps/api/src/advisory-lock.ts#advisoryLock',
    'apps/api/src/advisory-lock.ts#asUuid',
  ],
  'apps/api/src/modules/esign/service.ts#patchTemplate': ['#assertUnique', '#auditTemplate', '#lockConfig', '#view'],
  'apps/api/src/modules/esign/service.ts#saveSceneSettings': [
    'apps/api/src/audit/record.ts#recordAudit',
    '#ESIGN_SCENE_AUDIT_TYPE',
    '#getSceneSettings',
    '#lockConfig',
    'apps/api/src/system-actor.ts#auditActor',
  ],
  'apps/api/src/modules/esign/service.ts#templateOptions': ['#ordered'],
};
