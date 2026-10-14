/** DEC-416③：冻结新鲜度与静态登记差异默认警告；运行时与业务行为断言始终判红。 */
import {
  defineTable,
  Hono,
  policed,
  rawRouter,
  verifyRouteDeclarations,
  type ManifestRoute,
  type RoutePolicy,
} from '@italent/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from './support/route-policy/baseline.js';
import { compareDeclarations, type Finding } from './support/route-policy/compare.js';
import type { ObservedContract } from './support/route-policy/contract.js';
import { checkDiscovery, checkIdApplicabilityDrift, type EndpointDiscovery } from './support/route-policy/discovery.js';
import { gateEvidence, softGate } from './support/route-policy/evidence-gate.js';
import { checkRecorded, createRecorder, observe } from './support/route-policy/recorded.js';
import { checkRequired } from './support/route-policy/required.js';
import type { RequiredTable } from './support/route-policy/required/types.js';

const KEY = 'GET /fixture/:id';
const MEMBER: RoutePolicy = { kind: 'member', reason: '合成夹具', fields: { mode: 'none', reason: '合成夹具' } };
const appOf = () => {
  const app = new Hono();
  policed(app, defineTable('fixture', { [KEY]: MEMBER })).get('/fixture/:id', (c) => c.json({ ok: true }));
  return app;
};
const ROUTE: ManifestRoute = verifyRouteDeclarations(appOf()).declared[0]!;
const CONTRACT: ObservedContract = {
  routes: {
    [KEY]: {
      module: 'fixture',
      edge: { anonymous: { status: 401 }, nonMember: { status: 403 }, member: { status: 200 } },
      primitives: {},
    },
  },
  domains: {},
};
const FOUND: EndpointDiscovery = {
  all: { status: 404, code: 'NOT_FOUND' },
  invalidId: { status: 400, code: 'VALIDATION_FAILED' },
  trace: [],
  scopeQueries: [],
  fieldQueries: [],
};
const CALL = { role: 'call', unit: 'apps/api/src/app.ts#createApp', anchor: 'createApp' } as const;
const TABLE: RequiredTable = { [KEY]: [] };
const warning = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function expectBoundary(findings: readonly Finding[], code: string): void {
  expect(findings.map((f) => f.code)).toContain(code);
  const spy = warning();
  expect(gateEvidence(findings, code, { strict: false })).toEqual([]);
  expect(spy.mock.calls.flat().join('\n')).toContain(code);
  vi.stubEnv('ROUTE_POLICY_EVIDENCE_STRICT', '1');
  const strict = gateEvidence(findings, code);
  expect(strict).toEqual(findings);
  expect(() => expect(strict).toEqual([])).toThrow();
}

describe('AC-PRM-FW-F090b / DEC-416③ 冻结新鲜度：默认警告、严格判红', () => {
  it.each(['observed-contract.json', 'probe/fixture.json'])('%s：生成内容与冻结文件不一致', (file) => {
    const fresh = canonicalJson({ value: '当前观测' });
    const frozen = canonicalJson({ value: '冻结观测' });
    const drift = fresh === frozen ? [] : [file];
    const spy = warning();
    expect(softGate('冻结新鲜度', drift, String, { strict: false })).toEqual([]);
    expect(spy.mock.calls.flat().join('\n')).toContain(file);
    vi.stubEnv('ROUTE_POLICY_EVIDENCE_STRICT', '1');
    expect(() => expect(softGate('冻结新鲜度', drift)).toEqual([])).toThrow();
  });

  it('recorded：收集值变化，双向发现均保留，默认只警告', async () => {
    const current = createRecorder();
    current.recordFact(KEY, 'outcome', await observe(new Response('{}', { status: 200 })));
    const stored = createRecorder();
    stored.recordFact(KEY, 'outcome', await observe(new Response('{}', { status: 403 })));
    const findings = checkRecorded({
      collected: current.facts,
      frozen: stored.facts,
      scope: new Set([KEY]),
      routes: [ROUTE],
      contract: CONTRACT,
    });
    expect(findings.map((f) => f.code)).toEqual(['RECORDED_UNREGISTERED', 'RECORDED_STALE']);
    expectBoundary(findings, 'RECORDED_UNREGISTERED');
  });
});

describe('AC-PRM-FW-F090b / DEC-416③ 适用性与静态登记差异：默认警告、严格判红', () => {
  it('PROBE_ID_APPLICABILITY_CHANGED：非法标识与占位请求变成同一结果', () => {
    const now = { ...FOUND, invalidId: FOUND.all };
    expectBoundary(checkIdApplicabilityDrift({ [KEY]: now }, { [KEY]: FOUND }), 'PROBE_ID_APPLICABILITY_CHANGED');
  });

  it('REQUIRED_TABLE_GAP / REQUIRED_STALE_FACT：原语改名，义务事实登记不动', () => {
    const old: RequiredTable = { [KEY]: [{ perm: 'own:fixture', facts: ['own:oldName'], at: [CALL] }] };
    const changed: ObservedContract = {
      ...CONTRACT,
      routes: { [KEY]: { ...CONTRACT.routes[KEY]!, primitives: { own: ['newName'] } } },
    };
    expectBoundary(checkRequired(old, changed, [ROUTE]), 'REQUIRED_TABLE_GAP');
  });

  it('BRANCH_INPUT_UNBOUND / BRANCH_VALUE_UNBOUND：选择器缺输入来源或分支值登记', () => {
    const selector: ManifestRoute = {
      ...ROUTE,
      policy: {
        kind: 'object',
        object: { from: 'param', path: 'kind', map: { a: 'Fixture.A', b: 'Fixture.B' } },
        operation: 'view',
        button: { none: true, reason: '合成夹具' },
        scope: { mode: 'none', reason: '合成夹具' },
        fields: { mode: 'none', reason: '合成夹具' },
      },
    };
    const contract: ObservedContract = {
      ...CONTRACT,
      domains: { 'fixture.kind': ['a', 'b'] },
      routes: { [KEY]: { ...CONTRACT.routes[KEY]!, primitives: { domain: ['fixture.kind'] } } },
    };
    const table: RequiredTable = { [KEY]: [{ perm: 'obj:{Fixture.A,Fixture.B}:view', at: [CALL] }] };
    expectBoundary(
      compareDeclarations(contract, [selector], table, { inputs: {}, values: {} }),
      'BRANCH_INPUT_UNBOUND',
    );
    expectBoundary(
      compareDeclarations(contract, [selector], table, {
        inputs: { [KEY]: [{ position: 'object', from: 'param', path: 'kind', domain: 'fixture.kind', at: [CALL] }] },
        values: {},
      }),
      'BRANCH_VALUE_UNBOUND',
    );
  });

  it('REQUIRED_MISSING：路由有声明，声明未覆盖义务表的准入权限', () => {
    expectBoundary(
      checkRequired({ [KEY]: [{ perm: 'obj:Fixture:view', at: [CALL] }] }, CONTRACT, [ROUTE]),
      'REQUIRED_MISSING',
    );
  });

  it('REQUIRED_ENTRY_MISSING：路由有声明，静态义务表漏登记端点', () => {
    expectBoundary(checkRequired({}, CONTRACT, [ROUTE]), 'REQUIRED_ENTRY_MISSING');
  });
});

describe.each(['0', '1'])('AC-PRM-FW-F090b / DEC-416③ 保持硬断言（严格开关 %s）', (strict) => {
  it('运行时缺路由声明：原生路由注册绕过代理仍抛 ROUTE_UNDECLARED', () => {
    vi.stubEnv('ROUTE_POLICY_EVIDENCE_STRICT', strict);
    const app = appOf();
    rawRouter(app).get('/undeclared', (c) => c.json({ ok: true }));
    expect(() => verifyRouteDeclarations(app)).toThrow(/ROUTE_UNDECLARED/);
  });

  it('端点完整性：登记了却没注册的端点仍抛 ROUTE_DECLARATION_UNUSED', () => {
    vi.stubEnv('ROUTE_POLICY_EVIDENCE_STRICT', strict);
    const app = new Hono();
    policed(app, defineTable('fixture', { [KEY]: MEMBER }));
    expect(() => verifyRouteDeclarations(app)).toThrow(/ROUTE_DECLARATION_UNUSED/);
  });

  it('非法标识 5xx：发现码 PROBE_ID_SERVER_ERROR 不能被警告门禁放行', async () => {
    vi.stubEnv('ROUTE_POLICY_EVIDENCE_STRICT', strict);
    const app = new Hono();
    app.get('/fixture/:id', (c) => c.json({ error: { code: 'INTERNAL_ERROR' } }, 500));
    const response = await app.request('/fixture/not-a-uuid');
    const found = { ...FOUND, invalidId: { status: response.status, code: 'INTERNAL_ERROR' } };
    const fatal = gateEvidence(checkDiscovery({ [KEY]: found }, TABLE, [ROUTE]), '非法标识');
    expect(fatal.map((f) => f.code)).toContain('PROBE_ID_SERVER_ERROR');
    expect(() => expect(fatal).toEqual([])).toThrow();
  });

  it.each(['status', 'ledgerAdded', 'auditAdded'] as const)('%s：运行时观测错误时独立行为断言仍判红', async (field) => {
    vi.stubEnv('ROUTE_POLICY_EVIDENCE_STRICT', strict);
    const app = new Hono();
    app.get('/fixture/:id', (c) => c.json({ ok: true }, 200));
    const observed = await observe(await app.request('/fixture/synthetic'), {
      ledger: { before: [], after: [] },
      audit: { before: [], after: [] },
    });
    const expected = { status: 403, ledgerAdded: [403], auditAdded: ['fixture.denied'] };
    expect(() => expect(observed[field]).toEqual(expected[field])).toThrow();
    expect(gateEvidence([], '冻结登记')).toEqual([]);
  });
});
