/**
 * 直接依赖图：区域 domain-idp（节点 → 直接依赖，字典序；同文件的依赖写作 #名字；没有依赖的叶子不登记）。
 * 生成文件（F-072）：改源码后用 `ROUTE_POLICY_UPDATE_DIGESTS=1` 重算，不要手改；冲突时取任一侧后重算。
 */
import type { Graph } from '../../../evidence-graph.js';

export const GRAPH: Graph = {
  'packages/domain/src/idp/catalog.ts#IDP_OBJECTS': [
    '#CAREER_FIELDS',
    '#GOAL_FIELDS',
    '#PLAN_FIELDS',
    '#SUB_PROCESS_FIELDS',
    '#TASK_FIELDS',
    '#TEMPLATE_MODULE_FIELDS',
    '#crud',
    '#object',
  ],
  'packages/domain/src/idp/catalog.ts#IDP_OBJECTS>analysis': ['#object'],
  'packages/domain/src/idp/catalog.ts#IDP_OBJECTS>career': ['#CAREER_FIELDS', '#object'],
  'packages/domain/src/idp/catalog.ts#IDP_OBJECTS>commonGoal': ['#object'],
  'packages/domain/src/idp/catalog.ts#IDP_OBJECTS>goal': ['#GOAL_FIELDS', '#object'],
  'packages/domain/src/idp/catalog.ts#IDP_OBJECTS>goalReview': ['#object'],
  'packages/domain/src/idp/catalog.ts#IDP_OBJECTS>plan': ['#PLAN_FIELDS', '#crud', '#object'],
  'packages/domain/src/idp/catalog.ts#IDP_OBJECTS>process': ['#object'],
  'packages/domain/src/idp/catalog.ts#IDP_OBJECTS>review': ['#object'],
  'packages/domain/src/idp/catalog.ts#IDP_OBJECTS>subProcess': ['#SUB_PROCESS_FIELDS', '#object'],
  'packages/domain/src/idp/catalog.ts#IDP_OBJECTS>task': ['#TASK_FIELDS', '#object'],
  'packages/domain/src/idp/catalog.ts#IDP_OBJECTS>template': ['#crud', '#object'],
  'packages/domain/src/idp/catalog.ts#IDP_OBJECTS>templateModule': ['#TEMPLATE_MODULE_FIELDS', '#object'],
  'packages/domain/src/idp/catalog.ts#IDP_OBJECTS>tutorship': ['#object'],
  'packages/domain/src/idp/catalog.ts#IDP_OBJECTS>workShift': ['#object'],
  'packages/domain/src/idp/catalog.ts#LINKED_FIELDS': ['#IDP_OBJECTS'],
  'packages/domain/src/idp/catalog.ts#keyInfoBlocksOf': ['#KEY_INFO_BLOCK_FIELDS'],
  'packages/domain/src/idp/catalog.ts#linkedViewable': ['#LINKED_FIELDS'],
  'packages/domain/src/idp/catalog.ts#object': ['#IDP_APP', '#SYSTEM_FIELDS', '#crud'],
  'packages/domain/src/idp/catalog.ts#withLinkedFields': ['#LINKED_FIELDS'],
  'packages/domain/src/idp/plan-rules.ts#currentStageName': ['packages/domain/src/idp/catalog.ts#IMPROVING_STAGE_NAME'],
  'packages/domain/src/idp/plan-rules.ts#stageDueDate': ['packages/domain/src/contracts/rules.ts#addDays'],
  'packages/domain/src/idp/rules.ts#nodeButtonsOf': [
    'packages/domain/src/idp/catalog.ts#CONTENT_NODE_BUTTONS',
    'packages/domain/src/idp/catalog.ts#GOAL_NODE_BUTTONS',
  ],
  'packages/domain/src/idp/rules.ts#startRuleText': [
    'packages/domain/src/idp/catalog.ts#AUTO_START_HOUR',
    '#REFERENCE_LABELS',
  ],
  'packages/domain/src/idp/rules.ts#startRuleViolation': ['#MAX_START_DAYS'],
};
