/**
 * 直接依赖图：区域 domain-talent（节点 → 直接依赖，字典序；同文件的依赖写作 #名字；没有依赖的叶子不登记）。
 * 生成文件（F-072）：改源码后用 `ROUTE_POLICY_UPDATE_DIGESTS=1` 重算，不要手改；冲突时取任一侧后重算。
 */
import type { Graph } from '../../../evidence-graph.js';

export const GRAPH: Graph = {
  'packages/domain/src/talent/catalog.ts#TALENT_OBJECTS': ['#crud', '#object'],
  'packages/domain/src/talent/catalog.ts#TALENT_OBJECTS>criterion': ['#crud', '#object'],
  'packages/domain/src/talent/catalog.ts#TALENT_OBJECTS>criterionCategory': ['#object'],
  'packages/domain/src/talent/catalog.ts#TALENT_OBJECTS>descriptionType': ['#object'],
  'packages/domain/src/talent/catalog.ts#TALENT_OBJECTS>dimension': ['#object'],
  'packages/domain/src/talent/catalog.ts#TALENT_OBJECTS>dimensionCategory': ['#object'],
  'packages/domain/src/talent/catalog.ts#TALENT_OBJECTS>library': ['#object'],
  'packages/domain/src/talent/catalog.ts#object': ['#SYSTEM_FIELDS', '#TALENT_APP', '#crud'],
  'packages/domain/src/talent/rules.ts#criterionDimensionValues': [
    'packages/domain/src/talent/catalog.ts#TALENT_DEFAULT_WEIGHT',
  ],
  'packages/domain/src/talent/rules.ts#criterionDimensionViolation': ['#isSet'],
};
