/**
 * 直接依赖图：区域 domain-job（节点 → 直接依赖，字典序；同文件的依赖写作 #名字；没有依赖的叶子不登记）。
 * 生成文件（F-072）：改源码后用 `ROUTE_POLICY_UPDATE_DIGESTS=1` 重算，不要手改；冲突时取任一侧后重算。
 */
import type { Graph } from '../../../evidence-graph.js';

export const GRAPH: Graph = {
  'packages/domain/src/job/graph-text.ts#JOB_GRAPH_TEXT': ['#bound', '#marked'],
  'packages/domain/src/job/graph-text.ts#jobGraphGrid': ['#JOB_GRAPH_TEXT', '#leaves', '#walk'],
  'packages/domain/src/job/graph-text.ts#jobGraphReasonText': ['#JOB_GRAPH_TEXT'],
  'packages/domain/src/job/graph-text.ts#leaves': ['#leaves'],
  'packages/domain/src/job/graph-text.ts#walk': ['#walk'],
  'packages/domain/src/job/graph.ts#analyseLevels': ['#byNameId', '#gradeRange', '#index'],
  'packages/domain/src/job/graph.ts#analysePosts': ['#boundReasons', '#byNameId', '#index'],
  'packages/domain/src/job/graph.ts#assertTextAndSize': ['#JOB_GRAPH_LIMITS', '#JobGraphLimitError', '#utf8Length'],
  'packages/domain/src/job/graph.ts#buildJobGraph': [
    '#JOB_GRAPH_LIMITS',
    '#JobGraphLimitError',
    '#analyseLevels',
    '#analysePosts',
    '#assertTextAndSize',
    '#buildNode',
    '#byNameId',
    '#collectIssues',
    '#compare',
    '#depthOf',
    '#index',
    '#layoutMerges',
    '#leaves',
    '#postOrder',
    '#sequenceForest',
    '#withRowspan',
  ],
  'packages/domain/src/job/graph.ts#buildNode': ['#buildNode'],
  'packages/domain/src/job/graph.ts#byNameId': ['#compare'],
  'packages/domain/src/job/graph.ts#depthOf': ['#depthOf'],
  'packages/domain/src/job/graph.ts#leaves': ['#leaves'],
  'packages/domain/src/job/graph.ts#postOrder': ['#byNameId', '#compare'],
  'packages/domain/src/job/graph.ts#sequenceForest': ['#byNameId'],
  'packages/domain/src/job/graph.ts#withRowspan': ['#withRowspan'],
};
