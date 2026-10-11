import type { ManifestRoute } from '@italent/api';
import type { ObservedContract } from '../contract.js';
import type { EndpointDiscovery } from '../discovery.js';
import type { RequiredTable } from '../required/types.js';

export interface LocalCheckContext {
  readonly table: RequiredTable;
  readonly routes: readonly ManifestRoute[];
  readonly contract: ObservedContract;
  readonly discoveries?: Readonly<Record<string, EndpointDiscovery>>;
}

export interface DiscoveryCheckContext extends Pick<LocalCheckContext, 'table' | 'routes'> {
  readonly discoveries: Readonly<Record<string, EndpointDiscovery>>;
}
