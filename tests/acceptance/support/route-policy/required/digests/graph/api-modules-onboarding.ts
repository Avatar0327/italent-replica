/**
 * 直接依赖图：区域 api-modules-onboarding（节点 → 直接依赖，字典序；同文件的依赖写作 #名字；没有依赖的叶子不登记）。
 * 生成文件（F-072）：改源码后用 `ROUTE_POLICY_UPDATE_DIGESTS=1` 重算，不要手改；冲突时取任一侧后重算。
 */
import type { Graph } from '../../../evidence-graph.js';

export const GRAPH: Graph = {
  'apps/api/src/modules/onboarding/approval-contract.ts#entryInfoCollectionAdapter': ['#unavailable'],
  'apps/api/src/modules/onboarding/collection-config-input.ts#mappedSubsets': [
    '#subsets',
    'packages/domain/src/personnel/fields.ts#SUBSETS',
  ],
  'apps/api/src/modules/onboarding/collection-config-input.ts#ruleBody': [
    '#name',
    '#subsets',
    '#uuid',
    'packages/domain/src/approval/types.ts#CONDITION_OPERATORS',
  ],
  'apps/api/src/modules/onboarding/collection-config-input.ts#rulePatch': ['#ruleBody'],
  'apps/api/src/modules/onboarding/collection-config-input.ts#templateBody': ['#field', '#name'],
  'apps/api/src/modules/onboarding/collection-config-input.ts#templateFieldAllowed': [
    '#mappedSubsets',
    '#profileFields',
    'packages/domain/src/personnel/catalog.ts#PERSONNEL_OBJECT',
    'packages/domain/src/personnel/fields.ts#SUBSETS',
    'packages/domain/src/personnel/fields.ts#subsetAttachmentFields',
  ],
  'apps/api/src/modules/onboarding/collection-config-input.ts#templatePatch': ['#templateBody'],
  'apps/api/src/modules/onboarding/collection-config-input.ts#validateRequiredSubsets': [
    'packages/domain/src/personnel/fields.ts#SUBSETS',
  ],
  'apps/api/src/modules/onboarding/collection-config-input.ts#validateRule': [
    '#CONDITION_FIELDS',
    '#uuid',
    'packages/domain/src/approval/conditions.ts#conditionViolations',
  ],
  'apps/api/src/modules/onboarding/collection-config-input.ts#validateTemplate': ['#templateFieldAllowed'],
  'apps/api/src/modules/onboarding/collection-config-routes.ts#bindCollectionWriteScope': [
    'apps/api/src/modules/onboarding/collection-config-scope.ts#collectionScope',
    'apps/api/src/modules/onboarding/collection-config-scope.ts#requireCollectionOrgScope',
    'apps/api/src/modules/onboarding/collection-config.ts#requireCollectionTarget',
  ],
  'apps/api/src/modules/onboarding/collection-config-routes.ts#configContext': [
    'apps/api/src/tenant-context.ts#tenantOf',
  ],
  'apps/api/src/modules/onboarding/collection-config-routes.ts#readConfig': [
    'apps/api/src/modules/job/context.ts#pageQuery',
    '#configContext',
    '#requireConfigView',
    'apps/api/src/modules/onboarding/collection-config.ts#lockCollectionConfig',
    'apps/api/src/modules/onboarding/collection-config.ts#readCollectionConfig',
  ],
  'apps/api/src/modules/onboarding/collection-config-routes.ts#readRule': [
    '#readConfig',
    'apps/api/src/modules/onboarding/collection-config-scope.ts#collectionScope',
    'apps/api/src/modules/onboarding/collection-config-scope.ts#ruleScopeSql',
  ],
  'apps/api/src/modules/onboarding/collection-config-routes.ts#requireConfigView': [
    'apps/api/src/authorization.ts#requirePermission',
    'apps/api/src/modules/onboarding/collection-config-scope.ts#SETTINGS',
    'apps/api/src/modules/permission/module-access.ts#authorizeInTransaction',
    'apps/api/src/modules/permission/module-access.ts#getModuleViewableFieldsInTransaction',
  ],
  'apps/api/src/modules/onboarding/collection-config-routes.ts#requireConfigWrite': [
    'apps/api/src/authorization.ts#requirePermission',
    'apps/api/src/modules/onboarding/collection-config-scope.ts#SETTINGS',
    'apps/api/src/modules/permission/module-access.ts#authorizeInTransaction',
    'apps/api/src/modules/permission/object-write.ts#requireObjectWrite',
  ],
  'apps/api/src/modules/onboarding/collection-config-routes.ts#route:DELETE /collection-rules/:id': [
    'apps/api/src/modules/job/context.ts#uuidParam',
    '#writeConfig',
  ],
  'apps/api/src/modules/onboarding/collection-config-routes.ts#route:DELETE /collection-templates/:id': [
    'apps/api/src/modules/job/context.ts#uuidParam',
    '#writeConfig',
  ],
  'apps/api/src/modules/onboarding/collection-config-routes.ts#route:GET /collection-rules': ['#readRule'],
  'apps/api/src/modules/onboarding/collection-config-routes.ts#route:GET /collection-rules/:id': [
    'apps/api/src/modules/job/context.ts#uuidParam',
    '#readRule',
  ],
  'apps/api/src/modules/onboarding/collection-config-routes.ts#route:GET /collection-settings': ['#readConfig'],
  'apps/api/src/modules/onboarding/collection-config-routes.ts#route:GET /collection-templates': ['#readConfig'],
  'apps/api/src/modules/onboarding/collection-config-routes.ts#route:GET /collection-templates/:id': [
    'apps/api/src/modules/job/context.ts#uuidParam',
    '#readConfig',
  ],
  'apps/api/src/modules/onboarding/collection-config-routes.ts#route:PATCH /collection-rules/:id': [
    'apps/api/src/modules/job/context.ts#parseBody',
    'apps/api/src/modules/job/context.ts#uuidParam',
    'apps/api/src/modules/onboarding/collection-config-input.ts#rulePatch',
    '#writeConfig',
  ],
  'apps/api/src/modules/onboarding/collection-config-routes.ts#route:PATCH /collection-templates/:id': [
    'apps/api/src/modules/job/context.ts#parseBody',
    'apps/api/src/modules/job/context.ts#uuidParam',
    'apps/api/src/modules/onboarding/collection-config-input.ts#templatePatch',
    '#writeConfig',
  ],
  'apps/api/src/modules/onboarding/collection-config-routes.ts#route:POST /collection-rules': [
    'apps/api/src/modules/job/context.ts#parseBody',
    'apps/api/src/modules/onboarding/collection-config-input.ts#ruleBody',
    '#writeConfig',
  ],
  'apps/api/src/modules/onboarding/collection-config-routes.ts#route:POST /collection-templates': [
    'apps/api/src/modules/job/context.ts#parseBody',
    'apps/api/src/modules/onboarding/collection-config-input.ts#templateBody',
    '#writeConfig',
  ],
  'apps/api/src/modules/onboarding/collection-config-routes.ts#route:PUT /collection-settings': [
    'apps/api/src/modules/job/context.ts#parseBody',
    'apps/api/src/modules/onboarding/collection-config-input.ts#settingsBody',
    '#writeConfig',
  ],
  'apps/api/src/modules/onboarding/collection-config-routes.ts#writeConfig': [
    'apps/api/src/modules/job/context.ts#revision',
    '#configContext',
    '#requireConfigWrite',
    'apps/api/src/modules/onboarding/collection-config.ts#lockCollectionConfig',
    'apps/api/src/modules/onboarding/collection-config.ts#saveCollectionSettings',
    'apps/api/src/modules/onboarding/collection-config.ts#writeCollectionResource',
  ],
  'apps/api/src/modules/onboarding/collection-config-scope.ts#SETTINGS': [
    'packages/domain/src/permission/module-actions.ts#MODULE_OBJECTS',
  ],
  'apps/api/src/modules/onboarding/collection-config-scope.ts#collectionScope': [
    '#SETTINGS',
    'apps/api/src/modules/permission/module-access.ts#resolveModuleScopeInTransaction',
  ],
  'apps/api/src/modules/onboarding/collection-config-scope.ts#requireCollectionOrgScope': [
    '#configMissing',
    '#visibleRoots',
  ],
  'apps/api/src/modules/onboarding/collection-config-scope.ts#ruleScopeSql': ['#scopeOrgs', '#visibleRoots'],
  'apps/api/src/modules/onboarding/collection-config-scope.ts#visibleRoots': [
    'apps/api/src/modules/permission/module-access.ts#scopeSql',
    'packages/domain/src/tenant-time.ts#tenantLocalDate',
  ],
  'apps/api/src/modules/onboarding/collection-config.ts#auditConfig': ['apps/api/src/audit/record.ts#recordAudit'],
  'apps/api/src/modules/onboarding/collection-config.ts#detail': ['#ruleSubsets', '#templateFields'],
  'apps/api/src/modules/onboarding/collection-config.ts#readCollectionConfig': [
    'apps/api/src/modules/onboarding/collection-config-scope.ts#configMissing',
    '#detail',
    '#headOf',
    '#loadCollectionSettings',
  ],
  'apps/api/src/modules/onboarding/collection-config.ts#requireCollectionTarget': [
    'apps/api/src/modules/onboarding/collection-config-scope.ts#configMissing',
    'apps/api/src/modules/onboarding/collection-config-scope.ts#ruleScopeSql',
    '#headOf',
    '#identity',
  ],
  'apps/api/src/modules/onboarding/collection-config.ts#saveCollectionSettings': [
    'apps/api/src/modules/employment/context.ts#assertRevision',
    '#auditConfig',
    '#loadCollectionSettings',
  ],
  'apps/api/src/modules/onboarding/collection-config.ts#saveRule': [
    'apps/api/src/modules/onboarding/collection-config-input.ts#validateRequiredSubsets',
    'apps/api/src/modules/onboarding/collection-config-scope.ts#configMissing',
    '#identity',
    '#templateFields',
  ],
  'apps/api/src/modules/onboarding/collection-config.ts#saveTemplate': [
    'apps/api/src/modules/onboarding/collection-config-input.ts#validateRequiredSubsets',
    '#identity',
    '#ruleSubsets',
  ],
  'apps/api/src/modules/onboarding/collection-config.ts#validateCompanyRefs': [
    'apps/api/src/modules/onboarding/collection-config-scope.ts#configMissing',
  ],
  'apps/api/src/modules/onboarding/collection-config.ts#writeCollectionResource': [
    'apps/api/src/modules/employment/context.ts#assertRevision',
    'apps/api/src/modules/onboarding/collection-config-input.ts#ruleBody',
    'apps/api/src/modules/onboarding/collection-config-input.ts#templateBody',
    'apps/api/src/modules/onboarding/collection-config-input.ts#validateRule',
    'apps/api/src/modules/onboarding/collection-config-input.ts#validateTemplate',
    'apps/api/src/modules/onboarding/collection-config-scope.ts#configMissing',
    '#auditConfig',
    '#businessFields',
    '#detail',
    '#headOf',
    '#identity',
    '#saveRule',
    '#saveTemplate',
    '#validateCompanyRefs',
  ],
};
