/**
 * 直接依赖图：区域 domain-platform（节点 → 直接依赖，字典序；同文件的依赖写作 #名字；没有依赖的叶子不登记）。
 * 生成文件（F-072）：改源码后用 `ROUTE_POLICY_UPDATE_DIGESTS=1` 重算，不要手改；冲突时取任一侧后重算。
 */
import type { Graph } from '../../../evidence-graph.js';

export const GRAPH: Graph = {
  'packages/domain/src/platform/sha256.ts#sha256Hex': ['#K', '#rotr', '#utf8'],
  'packages/domain/src/platform/standard-grants.ts#objectCatalogDigest': [
    'packages/domain/src/platform/sha256.ts#sha256Hex',
  ],
  'packages/domain/src/platform/standard-grants.ts#objectGrantItems': [
    '#buttonGrantCode',
    '#fieldGrantCode',
    '#objectGrantCode',
    '#opGrantCode',
  ],
  'packages/domain/src/platform/standard-presets.ts#ESTABLISHMENT_SCHEME_DATASOURCE': [
    'packages/domain/src/permission/module-actions.ts#MODULE_OBJECTS',
  ],
};
