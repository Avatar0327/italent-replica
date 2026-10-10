/**
 * 直接依赖图：区域 api-route-policy（节点 → 直接依赖，字典序；同文件的依赖写作 #名字；没有依赖的叶子不登记）。
 * 生成文件（F-072）：改源码后用 `ROUTE_POLICY_UPDATE_DIGESTS=1` 重算，不要手改；冲突时取任一侧后重算。
 */
import type { Graph } from '../../../evidence-graph.js';

export const GRAPH: Graph = {
  'apps/api/src/route-policy/access.ts#bindAccess': ['#accessByContext'],
  'apps/api/src/route-policy/declare.ts#LOWER_METHODS': ['apps/api/src/route-policy/table.ts#METHODS'],
  'apps/api/src/route-policy/declare.ts#declare': [
    '#lastRoute',
    '#raw',
    '#wrap',
    'apps/api/src/route-policy/registry.ts#registryOf',
    'apps/api/src/route-policy/table.ts#policyKey',
  ],
  'apps/api/src/route-policy/declare.ts#declareFromTable': [
    '#declare',
    'apps/api/src/route-policy/registry.ts#RoutePolicyError',
    'apps/api/src/route-policy/table.ts#policyKey',
  ],
  'apps/api/src/route-policy/declare.ts#lastRoute': ['apps/api/src/route-policy/registry.ts#RoutePolicyError'],
  'apps/api/src/route-policy/declare.ts#mount': [
    '#raw',
    '#unwrapComposed',
    'apps/api/src/route-policy/registry.ts#RoutePolicyError',
    'apps/api/src/route-policy/registry.ts#attachRegistry',
    'apps/api/src/route-policy/registry.ts#moveMiddlewarePath',
    'apps/api/src/route-policy/registry.ts#registryOf',
  ],
  'apps/api/src/route-policy/declare.ts#policed': [
    '#FORBIDDEN',
    '#LOWER_METHODS',
    '#RAW',
    '#declareFromTable',
    '#mount',
    '#raw',
    '#useMiddleware',
    'apps/api/src/route-policy/registry.ts#RoutePolicyError',
    'apps/api/src/route-policy/registry.ts#registryOf',
  ],
  'apps/api/src/route-policy/declare.ts#policedSub': [
    '#policed',
    '#raw',
    'apps/api/src/route-policy/registry.ts#attachRegistry',
    'apps/api/src/route-policy/registry.ts#registryOf',
  ],
  'apps/api/src/route-policy/declare.ts#raw': ['#rawRouter'],
  'apps/api/src/route-policy/declare.ts#rawRouter': ['#RAW'],
  'apps/api/src/route-policy/declare.ts#unwrapComposed': ['#COMPOSED_HANDLER'],
  'apps/api/src/route-policy/declare.ts#useMiddleware': [
    '#lastRoute',
    '#raw',
    'apps/api/src/route-policy/registry.ts#registryOf',
  ],
  'apps/api/src/route-policy/declare.ts#wrap': ['apps/api/src/route-policy/enforce.ts#runPlan'],
  'apps/api/src/route-policy/enforce.ts#runPlan': [
    'apps/api/src/route-policy/access.ts#RouteAccess',
    'apps/api/src/route-policy/access.ts#bindAccess',
    '#admit',
    '#runShared',
    '#runtimeFor',
  ],
  'apps/api/src/route-policy/enforce.ts#runShared': ['#resetResponse', '#uncheckedResponse'],
  'apps/api/src/route-policy/registry.ts#RouteRegistry': ['#RoutePolicyError', '#addMiddlewarePath'],
  'apps/api/src/route-policy/registry.ts#attachRegistry': ['#registryByRouter'],
  'apps/api/src/route-policy/registry.ts#moveMiddlewarePath': ['#addMiddlewarePath'],
  'apps/api/src/route-policy/registry.ts#registryOf': ['#RouteRegistry', '#registryByRouter'],
  'apps/api/src/route-policy/table.ts#assertKey': ['#METHODS'],
  'apps/api/src/route-policy/table.ts#assertLedgerReason': ['#assertLedgerReason'],
  'apps/api/src/route-policy/table.ts#defineTable': ['#assertKey', '#assertLedgerReason'],
};
