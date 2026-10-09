export {
  declare,
  type DeclareOptions,
  declareEach,
  mount,
  policed,
  policedSub,
  rawRouter,
  unwrapComposed,
  useMiddleware,
} from './declare.js';
export {
  type Declaration,
  type MiddlewareEntry,
  registryOf,
  RoutePolicyError,
  type RoutePolicyErrorCode,
  RouteRegistry,
} from './registry.js';
export { defineTable, mergeTables, METHODS, type PolicyHit, type PolicyTable, policyKey } from './table.js';
export type * from './types.js';
export { type ManifestRoute, type RouteManifest, routeManifest, verifyRouteDeclarations } from './verify.js';
