import { gateEvidence, softGate } from './evidence-gate.js';
import { it } from 'vitest';
import type { ManifestRoute } from '@italent/api';
import { compareDeclarations, type Finding } from './compare.js';
import type { ObservedContract } from './contract.js';
import type { BranchBindings } from './domains.js';
import { REQUIRED } from './required/index.js';
import type { RequiredTable } from './required/types.js';

import { checkDiscovery, type EndpointDiscovery, type UnclaimedAccounting } from './discovery.js';
import { KNOWN_GAPS } from './probe-known-gaps.js';
import { REDUNDANT_OBSERVATIONS } from './probe-redundant.js';

interface DiscoveryRecords {
  readonly discoveries: Readonly<Record<string, EndpointDiscovery>>;
  readonly table: RequiredTable;
  readonly routes: readonly ManifestRoute[];
  readonly accounting?: UnclaimedAccounting;
}
type Options = { readonly strict?: boolean };
type Records = readonly Finding[] | DiscoveryRecords | { readonly drift: readonly string[] };

/** DEC-431①：唯一真实登记出口；先算实际记录与两本账的逐对差异，再分流，预期非空记录不会直接判红。 */
export function registrationGate(
  records: { readonly drift: readonly string[] },
  label: string,
  options?: Options,
): string[];
export function registrationGate(
  records: readonly Finding[] | DiscoveryRecords,
  label: string,
  options?: Options,
): Finding[];
export function registrationGate(records: Records, label: string, options: Options = {}): Finding[] | string[] {
  if ('drift' in records) return softGate(label, records.drift, String, options);
  if (Array.isArray(records)) return gateEvidence(records, label, options);
  const actual = records as DiscoveryRecords;
  const accounting = actual.accounting ?? { knownGaps: KNOWN_GAPS, redundant: REDUNDANT_OBSERVATIONS };
  const differences = checkDiscovery(actual.discoveries, actual.table, actual.routes, accounting);
  const pairs = [...accounting.knownGaps, ...accounting.redundant].flatMap((g) => g.pairs.map((p) => p.join('\t')));
  if (new Set(pairs).size !== pairs.length) {
    differences.push({ route: 'account', code: 'PROBE_ACCOUNT_DUPLICATE', detail: '两本台账内存在重复登记对' });
  }
  return gateEvidence(differences, label, options);
}

/** 文本与局部元数据也只把实际断言差异送到统一入口；读取 / 解析异常不被转换。 */
export const registrationDrift = (label: string, drift: readonly string[]) => registrationGate({ drift }, label);

/** 只供真实登记的静态元数据断言；检测器反例与运行时行为不得走此入口（DEC-416③）。 */
export function registration(label: string, verify: () => void): void {
  try {
    verify();
  } catch (error) {
    // 只接收明确的断言差异；缺文件、解析错误、未知异常继续判红。
    if (!(error instanceof Error) || error.name !== 'AssertionError') throw error;
    if (registrationDrift(label, [error.message]).length) throw error;
  }
}

/** 仅登记元数据的用例；带检测器发现码、运行时或结构断言的用例须保持普通 it。 */
export const registrationIt = (label: string, verify: () => void) => it(label, () => registration(label, verify));

/** 缺表项时不能用空义务推算准入 / 披露，否则会制造假的 WEAKER；完整表项保留原比较器全部硬发现码。 */
export function compareRegisteredDeclarations(
  contract: ObservedContract,
  routes: readonly ManifestRoute[],
  bindings?: BranchBindings,
  table: RequiredTable = REQUIRED,
) {
  return compareDeclarations(contract, routes, table, bindings, { allowIncompleteRegistration: true });
}
