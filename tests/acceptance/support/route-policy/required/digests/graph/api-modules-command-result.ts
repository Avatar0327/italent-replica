/**
 * 直接依赖图：区域 api-modules-command-result（节点 → 直接依赖，字典序；同文件的依赖写作 #名字；没有依赖的叶子不登记）。
 * 生成文件（F-072）：改源码后用 `ROUTE_POLICY_UPDATE_DIGESTS=1` 重算，不要手改；冲突时取任一侧后重算。
 */
import type { Graph } from '../../../evidence-graph.js';

export const GRAPH: Graph = {
  'apps/api/src/modules/command-result/routes.ts#route:GET /api/tenant/commands/:commandId/result': [
    '#COMMAND_ID',
    'apps/api/src/modules/command-result/service.ts#readOwnCommandResult',
    'apps/api/src/tenant-context.ts#tenantOf',
  ],
  'apps/api/src/modules/command-result/service.ts#readOwnCommandResult': [
    'apps/api/src/command-type.ts#commandTypeOf',
    '#latestFailureGroup',
    '#summaryOf',
  ],
  'apps/api/src/modules/command-result/service.ts#summaryOf': ['#UUID'],
};
