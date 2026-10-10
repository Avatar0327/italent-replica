/**
 * 直接依赖图：区域 api-modules-tenant-settings（节点 → 直接依赖，字典序；同文件的依赖写作 #名字；没有依赖的叶子不登记）。
 * 生成文件（F-072）：改源码后用 `ROUTE_POLICY_UPDATE_DIGESTS=1` 重算，不要手改；冲突时取任一侧后重算。
 */
import type { Graph } from '../../../evidence-graph.js';

export const GRAPH: Graph = {
  'apps/api/src/modules/tenant-settings/routes.ts#ifMatch': ['#IF_MATCH'],
  'apps/api/src/modules/tenant-settings/routes.ts#parseBody': ['#overrideBody'],
  'apps/api/src/modules/tenant-settings/routes.ts#route:DELETE /api/tenant/settings/:key/override': [
    'apps/api/src/authorization.ts#requirePermission',
    '#ifMatch',
    '#respond',
    '#settingKey',
    'apps/api/src/modules/tenant-settings/service.ts#restoreSetting',
    'apps/api/src/tenant-context.ts#tenantOf',
  ],
  'apps/api/src/modules/tenant-settings/routes.ts#route:GET /api/tenant/settings/:key': [
    'apps/api/src/authorization.ts#requirePermission',
    '#respond',
    '#settingKey',
    'apps/api/src/modules/tenant-settings/service.ts#readEffectiveSetting',
    'apps/api/src/tenant-context.ts#tenantOf',
  ],
  'apps/api/src/modules/tenant-settings/routes.ts#route:PUT /api/tenant/settings/:key': [
    'apps/api/src/authorization.ts#requirePermission',
    '#ifMatch',
    '#parseBody',
    '#respond',
    '#settingKey',
    'apps/api/src/modules/tenant-settings/service.ts#overrideSetting',
    'apps/api/src/tenant-context.ts#tenantOf',
  ],
  'apps/api/src/modules/tenant-settings/routes.ts#settingKey': ['#SETTING_KEY'],
  'apps/api/src/modules/tenant-settings/service.ts#assertRevision': ['#revisionConflict'],
  'apps/api/src/modules/tenant-settings/service.ts#audit': ['apps/api/src/audit/record.ts#recordAudit'],
  'apps/api/src/modules/tenant-settings/service.ts#insertOverride': ['#revisionConflict'],
  'apps/api/src/modules/tenant-settings/service.ts#loadOverrideForUpdate': ['#overrideKey'],
  'apps/api/src/modules/tenant-settings/service.ts#overrideSetting': [
    '#assertRevision',
    '#audit',
    '#effective',
    '#insertOverride',
    '#loadOverrideForUpdate',
    '#loadSystemSetting',
    '#overrideKey',
    '#revisionConflict',
    '#snapshot',
    '#validators',
  ],
  'apps/api/src/modules/tenant-settings/service.ts#readEffectiveSetting': [
    '#effective',
    '#loadSystemSetting',
    '#overrideKey',
  ],
  'apps/api/src/modules/tenant-settings/service.ts#restoreSetting': [
    '#assertRevision',
    '#audit',
    '#effective',
    '#loadOverrideForUpdate',
    '#loadSystemSetting',
    '#overrideKey',
    '#revisionConflict',
    '#snapshot',
  ],
};
