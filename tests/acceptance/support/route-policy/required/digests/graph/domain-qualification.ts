/**
 * 直接依赖图：区域 domain-qualification（节点 → 直接依赖，字典序；同文件的依赖写作 #名字；没有依赖的叶子不登记）。
 * 生成文件（F-072）：改源码后用 `ROUTE_POLICY_UPDATE_DIGESTS=1` 重算，不要手改；冲突时取任一侧后重算。
 */
import type { Graph } from '../../../evidence-graph.js';

export const GRAPH: Graph = {
  'packages/domain/src/qualification/catalog.ts#QUALIFICATION_OBJECTS': ['#OWNER_FIELDS', '#object', '#owned'],
  'packages/domain/src/qualification/catalog.ts#QUALIFICATION_ORG_AUDITED': ['#QUALIFICATION_OWNED_OBJECTS'],
  'packages/domain/src/qualification/catalog.ts#QUALIFICATION_PAGES': ['#QUALIFICATION_APP'],
  'packages/domain/src/qualification/catalog.ts#object': ['#QUALIFICATION_APP', '#SYSTEM_FIELDS', '#crud'],
  'packages/domain/src/qualification/catalog.ts#owned': ['#OWNER_FIELDS', '#object'],
  'packages/domain/src/qualification/indicator-port.ts#registerQualificationIndicatorPort': ['#registered'],
};
