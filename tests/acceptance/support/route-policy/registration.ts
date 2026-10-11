import { softGate } from './evidence-gate.js';
import { it } from 'vitest';
import type { ManifestRoute } from '@italent/api';
import { compareDeclarations } from './compare.js';
import type { ObservedContract } from './contract.js';
import type { BranchBindings } from './domains.js';
import { REQUIRED } from './required/index.js';
import type { RequiredTable } from './required/types.js';

/** 只供真实登记的静态元数据断言；检测器反例与运行时行为不得走此入口（DEC-416③）。 */
export function registration(label: string, verify: () => void): void {
  try {
    verify();
  } catch (error) {
    // 只接收明确的断言差异；缺文件、解析错误、未知异常继续判红。
    if (!(error instanceof Error) || error.name !== 'AssertionError') throw error;
    if (softGate(label, [error.message]).length) throw error;
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
