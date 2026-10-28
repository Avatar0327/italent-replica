/**
 * 直接依赖图：区域 domain-hr-analysis（节点 → 直接依赖，字典序；同文件的依赖写作 #名字；没有依赖的叶子不登记）。
 * 生成文件（F-072）：改源码后用 `ROUTE_POLICY_UPDATE_DIGESTS=1` 重算，不要手改；冲突时取任一侧后重算。
 */
import type { Graph } from '../../../evidence-graph.js';

export const GRAPH: Graph = {
  'packages/domain/src/hr-analysis/roster.ts#ROSTER_COLUMNS': ['#contract', '#person', '#record'],
  'packages/domain/src/hr-analysis/roster.ts#ROSTER_FIXED_COLUMNS': ['#person'],
  'packages/domain/src/hr-analysis/roster.ts#rosterCellText': [
    'packages/domain/src/employment/employee-status.ts#EMPLOYEE_STATUS_LABELS',
    '#TERM_TYPE_LABELS',
  ],
  'packages/domain/src/hr-analysis/roster.ts#tenureYears': [
    '#day',
    'packages/domain/src/personnel/tenure.ts#decimalYears',
  ],
};
