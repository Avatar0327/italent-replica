import type { ManifestRoute } from '@italent/api';
import type { ObservedContract } from '../contract.js';
import type { EndpointDiscovery } from '../discovery.js';
import type { RequiredTable } from '../required/types.js';

export interface LocalCheckContext {
  /** 专项的同一登记副本可复用原始计算；不得缓存断言或模式相关的门禁结果。 */
  readonly evaluate?: <T>(key: string, calculate: () => T) => T;
  readonly table: RequiredTable;
  readonly routes: readonly ManifestRoute[];
  readonly contract: ObservedContract;
  readonly discoveries?: Readonly<Record<string, EndpointDiscovery>>;
}

export interface DiscoveryCheckContext extends Pick<LocalCheckContext, 'table' | 'routes'> {
  readonly discoveries: Readonly<Record<string, EndpointDiscovery>>;
}

export function evaluateLocal<T>(context: LocalCheckContext, key: string, calculate: () => T): T {
  return context.evaluate ? context.evaluate(key, calculate) : calculate();
}
