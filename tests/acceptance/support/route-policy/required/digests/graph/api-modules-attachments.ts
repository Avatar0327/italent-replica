/**
 * 直接依赖图：区域 api-modules-attachments（节点 → 直接依赖，字典序；同文件的依赖写作 #名字；没有依赖的叶子不登记）。
 * 生成文件（F-072）：改源码后用 `ROUTE_POLICY_UPDATE_DIGESTS=1` 重算，不要手改；冲突时取任一侧后重算。
 */
import type { Graph } from '../../../evidence-graph.js';

export const GRAPH: Graph = {
  'apps/api/src/modules/attachments/access.ts#requireAttachmentRead': [
    '#ATTACHMENT_FIELD',
    '#attachmentNotFound',
    'apps/api/src/modules/employee-self-service/application-access.ts#requireApplicationAccess',
    'apps/api/src/modules/employment/context.ts#EMPLOYMENT_OBJECT',
    'apps/api/src/modules/permission/module-access.ts#getModuleViewableFieldsInTransaction',
  ],
  'apps/api/src/modules/attachments/access.ts#requireAttachmentWrite': [
    '#ATTACHMENT_FIELD',
    'apps/api/src/modules/employee-self-service/application-access.ts#requireApplicationAccess',
  ],
  'apps/api/src/modules/attachments/blob-store.ts#PgBlobStore': ['#where'],
  'apps/api/src/modules/attachments/routes.ts#route:DELETE /api/tenant/attachments/:id': [
    '#ATTACHMENTS_BASE',
    '#sameOrigin',
    '#write',
    'apps/api/src/modules/attachments/service.ts#deleteFile',
    'apps/api/src/modules/job/context.ts#parseBody',
    'apps/api/src/modules/job/context.ts#revision',
    'apps/api/src/modules/job/context.ts#uuidParam',
  ],
  'apps/api/src/modules/attachments/routes.ts#route:GET /api/tenant/attachments/:id': [
    'apps/api/src/modules/attachments/access.ts#requireAttachmentRead',
    '#ATTACHMENTS_BASE',
    'apps/api/src/modules/attachments/service.ts#readTemporaryMeta',
    'apps/api/src/modules/employee-self-service/access.ts#selfAccess',
    'apps/api/src/modules/job/context.ts#uuidParam',
  ],
  'apps/api/src/modules/attachments/routes.ts#route:GET /api/tenant/attachments/:id/content': [
    'apps/api/src/modules/attachments/access.ts#requireAttachmentRead',
    '#ATTACHMENTS_BASE',
    'apps/api/src/modules/attachments/service.ts#readTemporaryContent',
    'apps/api/src/modules/employee-self-service/access.ts#selfAccess',
    'apps/api/src/modules/job/context.ts#uuidParam',
    'packages/domain/src/attachments/filename.ts#attachmentDisposition',
  ],
  'apps/api/src/modules/attachments/routes.ts#route:POST /api/tenant/attachments': [
    '#ATTACHMENTS_BASE',
    '#registration',
    '#sameOrigin',
    '#write',
    'apps/api/src/modules/attachments/service.ts#registerFile',
    'apps/api/src/modules/job/context.ts#parseBody',
  ],
  'apps/api/src/modules/attachments/routes.ts#route:POST /api/tenant/attachments/:id/upload': [
    '#ATTACHMENTS_BASE',
    '#sameOrigin',
    '#write',
    'apps/api/src/modules/attachments/service.ts#uploadFile',
    'apps/api/src/modules/job/context.ts#parseBody',
    'apps/api/src/modules/job/context.ts#revision',
    'apps/api/src/modules/job/context.ts#uuidParam',
  ],
  'apps/api/src/modules/attachments/routes.ts#write': [
    'apps/api/src/modules/attachments/access.ts#requireAttachmentWrite',
    'apps/api/src/modules/employee-self-service/access.ts#selfAccess',
  ],
  'apps/api/src/modules/attachments/service.ts#checkRegistration': [
    '#limitsOf',
    '#unsupportedType',
    'apps/api/src/modules/talent/model-image-format.ts#validateImageMetadata',
    'packages/domain/src/attachments/filename.ts#attachmentExtension',
    'packages/domain/src/attachments/filename.ts#sanitizeAttachmentFilename',
    'packages/domain/src/attachments/purposes.ts#attachmentPurpose',
  ],
  'apps/api/src/modules/attachments/service.ts#deleteFile': ['#ownFile', '#receipt', '#record'],
  'apps/api/src/modules/attachments/service.ts#ownFile': [
    'apps/api/src/modules/attachments/access.ts#attachmentNotFound',
  ],
  'apps/api/src/modules/attachments/service.ts#readTemporaryContent': [
    'apps/api/src/modules/attachments/access.ts#attachmentNotFound',
    'apps/api/src/modules/attachments/blob-store.ts#PgBlobStore',
    '#ownFile',
  ],
  'apps/api/src/modules/attachments/service.ts#readTemporaryMeta': ['#ownFile', '#receipt'],
  'apps/api/src/modules/attachments/service.ts#record': ['apps/api/src/audit/record.ts#recordAudit', '#snapshot'],
  'apps/api/src/modules/attachments/service.ts#registerFile': ['#checkRegistration', '#receipt', '#record'],
  'apps/api/src/modules/attachments/service.ts#snapshot': ['#receipt'],
  'apps/api/src/modules/attachments/service.ts#uploadFile': [
    'apps/api/src/modules/attachments/blob-store.ts#PgBlobStore',
    '#HOUR',
    '#limitsOf',
    '#ownFile',
    '#receipt',
    '#record',
    '#unsupportedType',
    'apps/api/src/modules/talent/model-image-format.ts#decodeImage',
    'apps/api/src/modules/talent/model-image-format.ts#sniffImageType',
    'packages/domain/src/attachments/purposes.ts#ATTACHMENT_PURPOSES',
  ],
};
