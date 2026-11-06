/**
 * 直接依赖图：区域 domain-attachments（节点 → 直接依赖，字典序；同文件的依赖写作 #名字；没有依赖的叶子不登记）。
 * 生成文件（F-072）：改源码后用 `ROUTE_POLICY_UPDATE_DIGESTS=1` 重算，不要手改；冲突时取任一侧后重算。
 */
import type { Graph } from '../../../evidence-graph.js';

export const GRAPH: Graph = {
  'packages/domain/src/attachments/filename.ts#sanitizeAttachmentFilename': ['#ATTACHMENT_FILENAME_MAX', '#CONTROL'],
  'packages/domain/src/attachments/purposes.ts#ATTACHMENT_PURPOSES': ['#ATTACHMENT_IMAGE_TYPES'],
  'packages/domain/src/attachments/purposes.ts#attachmentPurpose': ['#ATTACHMENT_PURPOSES'],
};
