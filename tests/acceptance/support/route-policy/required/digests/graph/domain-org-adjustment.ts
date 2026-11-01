/**
 * 直接依赖图：区域 domain-org-adjustment（节点 → 直接依赖，字典序；同文件的依赖写作 #名字；没有依赖的叶子不登记）。
 * 生成文件（F-072）：改源码后用 `ROUTE_POLICY_UPDATE_DIGESTS=1` 重算，不要手改；冲突时取任一侧后重算。
 */
import type { Graph } from '../../../evidence-graph.js';

export const GRAPH: Graph = {
  'packages/domain/src/org-adjustment/entry-buttons.ts#ORG_ITEM_ENTRY_BUTTONS': [
    'packages/domain/src/org-adjustment/fields.ts#ORG_ADJUSTMENT_DETAIL_OBJECT_CODE',
    'packages/domain/src/org-adjustment/fields.ts#ORG_ADJUSTMENT_OBJECT_CODE',
  ],
  'packages/domain/src/org-adjustment/fields.ts#ORG_ADJUSTMENT_FORM_FIELDS': [
    '#ORG_ADJUSTMENT_CONTRACT_CONTAINER',
    '#ORG_ADJUSTMENT_HEADER_FIELDS',
    '#ORG_ADJUSTMENT_SECTION_FIELDS',
  ],
  'packages/domain/src/org-adjustment/plan.ts#planOrgTree': ['#nodeOf', '#reportLevels'],
  'packages/domain/src/org-adjustment/plan.ts#reportLevels': ['#ORG_MAX_LEVEL'],
  'packages/domain/src/org-adjustment/range.ts#isInAdjustmentRange': ['#keyOf'],
  'packages/domain/src/org-adjustment/status.ts#statusFilterApprovalStatus': ['#ORG_ADJUSTMENT_STATUS_FILTERS'],
};
