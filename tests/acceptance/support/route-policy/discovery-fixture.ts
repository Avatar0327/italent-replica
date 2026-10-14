import type { ManifestRoute } from '@italent/api';
import type { EndpointDiscovery } from './discovery.js';
import type { KnownGapGroup } from './probe-known-gaps.js';
import type { RequiredTable } from './required/types.js';

// 固定输入验证认领 / 台账机制，不把真实登记的另一个漏项混进反例的期望结果（#248 P2-1）。
const MANAGER = 'GET /api/tenant/employment/transfers/manager';
const PLAN = 'DELETE /api/tenant/idp/plans/:id';
const GOAL = 'DELETE /api/tenant/idp/plans/:id/goals/:goalId';
const ORG = 'GET /api/tenant/org/person-candidates';
const EMPTY = 'POST /api/tenant/idp/plans/:id/goals';
const HR = 'btn:TenantBase.EmploymentRecord#Transfer.Hr@detail';
const VIEW = 'obj:IDP.Idp:view';
const traces = {
  [MANAGER]: ['obj:TenantBase.EmploymentRecord:view', HR],
  [PLAN]: ['obj:IDP.Idp:delete', 'obj:IDP.Analysis:view'],
  [GOAL]: [VIEW],
  [ORG]: ['obj:TenantBase.Organization:create'],
  [EMPTY]: [],
};
export const DISCOVERY_TABLE: RequiredTable = {
  [MANAGER]: [
    { perm: traces[MANAGER][0]!, at: [] },
    { perm: HR, purpose: 'disclosure:canViewReporting', at: [] },
  ],
  [PLAN]: [{ perm: 'obj:IDP.Idp:delete', at: [] }],
  [GOAL]: [{ perm: VIEW, purpose: 'guard:idp.executor', inner: { role: 'or', group: 'executor', alt: 'hr' }, at: [] }],
  [ORG]: [],
  [EMPTY]: [],
};
export const DISCOVERY_FACTS: Record<string, EndpointDiscovery> = Object.fromEntries(
  Object.entries(traces).map(([key, trace]) => [
    key,
    { all: { status: 200 }, trace, scopeQueries: [], fieldQueries: [] },
  ]),
);
export const DISCOVERY_ROUTES: readonly ManifestRoute[] = Object.keys(traces).map((key) => ({
  key,
  module: 'fixture',
  method: key.slice(0, key.indexOf(' ')),
  path: key.slice(key.indexOf(' ') + 1),
  policy: { kind: 'member', reason: '独立发现夹具', fields: { mode: 'none', reason: '独立发现夹具' } },
}));
export const DISCOVERY_GAPS: readonly KnownGapGroup[] = [
  {
    id: 'fixture-known-gaps',
    owner: '独立夹具修补归属',
    purpose: '验证精确认领',
    evidence: [],
    pairs: [
      [PLAN, 'obj:IDP.Analysis:view'],
      [ORG, traces[ORG][0]!],
    ],
  },
];
