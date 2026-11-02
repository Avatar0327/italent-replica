/**
 * 直接依赖图：区域 domain-analytics（节点 → 直接依赖，字典序；同文件的依赖写作 #名字；没有依赖的叶子不登记）。
 * 生成文件（F-072）：改源码后用 `ROUTE_POLICY_UPDATE_DIGESTS=1` 重算，不要手改；冲突时取任一侧后重算。
 */
import type { Graph } from '../../../evidence-graph.js';

export const GRAPH: Graph = {
  'packages/domain/src/analytics/hr-movement.ts#growthRate': ['#round4'],
  'packages/domain/src/analytics/hr-movement.ts#leaveRate': ['#round4'],
  'packages/domain/src/analytics/hr-movement.ts#monthOf': ['#DAYS', '#leap', '#pad'],
  'packages/domain/src/analytics/hr-movement.ts#movementMonths': ['#monthIndex', '#monthOf'],
  'packages/domain/src/analytics/hr-movement.ts#withinOneMonth': ['#ONE_MONTH_YEARS'],
  'packages/domain/src/analytics/hr-movement.ts#yearMonths': ['#monthOf'],
};
