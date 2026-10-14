/**
 * 直接依赖图：区域 api-modules-avatar（节点 → 直接依赖，字典序；同文件的依赖写作 #名字；没有依赖的叶子不登记）。
 * 生成文件（F-072）：改源码后用 `ROUTE_POLICY_UPDATE_DIGESTS=1` 重算，不要手改；冲突时取任一侧后重算。
 */
import type { Graph } from '../../../evidence-graph.js';

export const GRAPH: Graph = {
  'apps/api/src/modules/avatar/references.ts#employeeAvatarSql': ['#avatarSql'],
  'apps/api/src/modules/avatar/references.ts#employeeAvatars': [
    '#avatarSql',
    'apps/api/src/modules/employment/record-store.ts#rowsOf',
  ],
  'apps/api/src/modules/avatar/references.ts#personAvatars': [
    '#avatarSql',
    'apps/api/src/modules/employment/record-store.ts#rowsOf',
  ],
  'apps/api/src/modules/avatar/references.ts#userAvatars': [
    '#avatarSql',
    'apps/api/src/modules/employment/record-store.ts#rowsOf',
  ],
  'apps/api/src/modules/avatar/routes.ts#present': [
    '#headers',
    'apps/api/src/modules/avatar/service.ts#presentAvatar',
    'apps/api/src/tenant-context.ts#tenantOf',
  ],
  'apps/api/src/modules/avatar/routes.ts#route:DELETE /api/tenant/account/avatar': [
    '#BASE',
    '#present',
    '#sameOrigin',
    '#write',
    'apps/api/src/modules/avatar/service.ts#deleteAvatar',
    'apps/api/src/modules/job/context.ts#parseBody',
  ],
  'apps/api/src/modules/avatar/routes.ts#route:GET /api/tenant/account/avatar': ['#BASE', '#present'],
  'apps/api/src/modules/avatar/routes.ts#route:POST /api/tenant/account/avatar/attachments': [
    '#BASE',
    '#headers',
    '#metadata',
    '#sameOrigin',
    '#write',
    'apps/api/src/modules/avatar/service.ts#ownMember',
    'apps/api/src/modules/avatar/service.ts#registerAvatar',
    'apps/api/src/modules/avatar/service.ts#registeredAvatar',
    'apps/api/src/modules/job/context.ts#parseBody',
    'apps/api/src/modules/job/context.ts#revision',
    'apps/api/src/tenant-context.ts#tenantOf',
  ],
  'apps/api/src/modules/avatar/routes.ts#route:POST /api/tenant/account/avatar/attachments/:attachmentId/upload': [
    '#BASE',
    '#present',
    '#sameOrigin',
    '#write',
    'apps/api/src/modules/avatar/service.ts#uploadAvatar',
    'apps/api/src/modules/job/context.ts#parseBody',
    'apps/api/src/modules/job/context.ts#uuidParam',
  ],
  'apps/api/src/modules/avatar/routes.ts#write': [
    'apps/api/src/modules/avatar/service.ts#ownMember',
    'apps/api/src/modules/job/context.ts#revision',
    'apps/api/src/tenant-context.ts#tenantOf',
  ],
  'apps/api/src/modules/avatar/service.ts#avatarContentBytes': [
    '#notFound',
    'apps/api/src/modules/employment/record-store.ts#rowsOf',
  ],
  'apps/api/src/modules/avatar/service.ts#changed': ['apps/api/src/audit/record.ts#recordAudit'],
  'apps/api/src/modules/avatar/service.ts#currentImage': ['#metadata', '#whereOwner'],
  'apps/api/src/modules/avatar/service.ts#deleteAvatar': ['#changed', '#lockOwner', '#metadata', '#whereOwner'],
  'apps/api/src/modules/avatar/service.ts#lockOwner': ['#ownMember'],
  'apps/api/src/modules/avatar/service.ts#ownMember': ['apps/api/src/modules/employment/record-store.ts#rowsOf'],
  'apps/api/src/modules/avatar/service.ts#presentAvatar': [
    'apps/api/src/modules/avatar/references.ts#avatarReference',
    '#currentImage',
    '#ownMember',
  ],
  'apps/api/src/modules/avatar/service.ts#registerAvatar': [
    '#changed',
    '#lockOwner',
    'apps/api/src/modules/talent/model-image-format.ts#validateImageMetadata',
  ],
  'apps/api/src/modules/avatar/service.ts#registeredAvatar': ['#metadata', '#notFound', '#whereOwner'],
  'apps/api/src/modules/avatar/service.ts#uploadAvatar': [
    '#changed',
    '#currentImage',
    '#lockOwner',
    '#notFound',
    '#registeredAvatar',
    '#whereOwner',
    'apps/api/src/modules/talent/model-image-format.ts#decodeImage',
    'apps/api/src/modules/talent/model-image-format.ts#validateImageContent',
  ],
};
