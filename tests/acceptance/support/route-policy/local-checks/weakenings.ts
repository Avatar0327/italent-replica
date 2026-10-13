import type { ManifestRoute } from '@italent/api';
import { expect } from 'vitest';
import type { ObservedContract } from '../contract.js';
import { compareMutants } from '../detector-fixtures.js';
import { WEAKENING_KINDS, weakeningsOf } from '../weakenings.js';
import { evaluateLocal, type LocalCheckContext } from './types.js';

/** F-095：变异体仍用独立夹具作检测依据，漏登记不得削弱这些硬断言。 */
export function structuralWeakeningCheck(
  routes: readonly ManifestRoute[],
  contract: ObservedContract,
  kind: (typeof WEAKENING_KINDS)[number],
  context?: LocalCheckContext,
) {
  const calculate = () => {
    const weakenings = routes.flatMap((r) => weakeningsOf(r, contract)).filter((w) => w.kind === kind);
    const missed = weakenings.filter(
      (w) =>
        !compareMutants(contract, [w.route]).some((f) =>
          /^(WEAKER|MISMATCH):|^REQUIRED_(MISSING|IN_OPTIONAL)$/.test(f.code),
        ),
    );
    return { weakenings, missed };
  };
  const { weakenings, missed } = context ? evaluateLocal(context, `weakenings:${kind}`, calculate) : calculate();
  expect(weakenings.length, `没有任何真实声明能施加 ${kind}`).toBeGreaterThan(0);
  expect(
    missed.map((w) => `${w.route.method} ${w.route.path} @${w.at}`),
    `${kind} 未被报出`,
  ).toEqual([]);
}

export const weakeningsChecks = (context: LocalCheckContext) =>
  WEAKENING_KINDS.map((kind) => ({
    id: `weakenings:${kind}`,
    label: kind,
    wrapped: false,
    verify: () => structuralWeakeningCheck(context.routes, context.contract, kind, context),
  }));
