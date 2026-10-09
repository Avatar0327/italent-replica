/**
 * AC-PRM-FW-02（续，F-039 PR-B2，docs/08_设计/F-039_PR-B_设计.md B-02 / B-04 / B-07；DEC-356 / 359 / 362）：
 * - B-02 证据依赖闭包：每个证据单元的依赖算到不动点（上限 12 层），依赖摘要与依赖集合变化报 EVIDENCE_STALE，
 *   解析不了且位于 modules/** 的报 EVIDENCE_CLOSURE_UNRESOLVED，边界清单只放授权引擎与通用基础设施；
 * - B-04 R9 去重键加调用点；
 * - B-07 动态选择器绑定“端点 + 位置 + 输入来源 + 域 + 映射值”（compareSelectors 五元组）与 3 类新结构弱化。
 * 零行为变化：本文件只读源码与冻结基准，不发请求。
 */
import { routeManifest, type ManifestRoute, type RouteManifest, type RoutePolicy } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { readFrozenContract } from './support/route-policy/baseline.js';
import { BRANCH_INPUTS, type BranchInput } from './support/route-policy/branch-inputs.js';
import { compareDeclarations, type Finding } from './support/route-policy/compare.js';
import type { ObservedContract } from './support/route-policy/contract.js';
import { BRANCH_VALUES, type BranchBindings } from './support/route-policy/domains.js';
import { assertBoundaryShape, EVIDENCE_BOUNDARY } from './support/route-policy/evidence-boundary.js';
import { MAX_DEPTH } from './support/route-policy/evidence-closure.js';
import {
  checkEvidence,
  closureReports,
  currentDependencies,
  currentDigestTable,
  repoSource,
  type SourceReader,
  unitText,
  usesOf,
} from './support/route-policy/evidence.js';
import { REQUIRED } from './support/route-policy/required/index.js';
import type { Evidence, Obligation, RequiredTable } from './support/route-policy/required/types.js';
import { mapSelectors } from './support/route-policy/selectors.js';
import { WEAKENING_KINDS, weakeningsOf } from './support/route-policy/weakenings.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

let manifest: RouteManifest;
let frozen: ObservedContract;

beforeAll(() => {
  manifest = routeManifest(tenantApi(testDb().db, { authorize: undefined }).app);
  const stored = readFrozenContract();
  if (!stored) throw new Error('冻结基准不存在：先跑 AC-PRM-FW-02.test.ts 生成');
  frozen = stored;
});

const codes = (findings: readonly Finding[]) => findings.map((f) => f.code);
const show = (findings: readonly Finding[]) => findings.map((f) => `${f.route} ${f.code}: ${f.detail}`).join('\n');

function route(key: string): ManifestRoute {
  const found = manifest.declared.find((r) => `${r.method} ${r.path}` === key);
  if (!found) throw new Error(`没有声明 ${key}`);
  return found;
}

// ---------------------------------------------------------------------------------------------------------------
// B-02 证据依赖闭包
// ---------------------------------------------------------------------------------------------------------------

const FIX = 'apps/api/src/modules/fixture';
const FIXTURE_FILES: Record<string, string> = {
  [`${FIX}/gate.ts`]: [
    "import { AppError } from '../../errors.js';",
    "import { levelOf } from './level.js';",
    "import { allowed } from './helper.js';",
    'export function gate(kind: string) {',
    "  if (!allowed(kind)) throw new AppError('FORBIDDEN', '需要权限');",
    '  return levelOf(kind);',
    '}',
    '',
  ].join('\n'),
  [`${FIX}/level.ts`]: "export function levelOf(kind: string) {\n  return kind === 'a' ? 'list' : 'detail';\n}\n",
  [`${FIX}/helper.ts`]: 'export function allowed(kind: string) {\n  return kind.length > 0;\n}\n',
};
const GATE_CALL: Evidence = { role: 'call', unit: `${FIX}/gate.ts#gate`, anchor: "throw new AppError('FORBIDDEN'" };
const FIXTURE_TABLE: RequiredTable = {
  'GET /api/tenant/fixture': [{ perm: 'btn:Fixture#open@list', at: [GATE_CALL] }],
};

const readerOf =
  (files: Record<string, string>): SourceReader =>
  (file) =>
    files[file] ?? repoSource(file);

/** 夹具基线：用原始源码生成摘要与依赖登记，之后只换读取器模拟“源码变了、登记没动”。 */
function baseline(files: Record<string, string> = FIXTURE_FILES, table: RequiredTable = FIXTURE_TABLE) {
  const read = readerOf(files);
  return {
    table,
    base: {
      read,
      branch: false as const,
      digests: currentDigestTable(table, read, false),
      dependencies: currentDependencies(table, read, false),
    },
  };
}

function afterChange(files: Record<string, string>, table: RequiredTable = FIXTURE_TABLE) {
  const { base } = baseline(FIXTURE_FILES, table);
  return checkEvidence(table, { ...base, read: readerOf(files) });
}

describe('AC-PRM-FW-02 证据闭包（B-02）：夹具', () => {
  it('原始源码：零发现；闭包 = 同文件与相对 import 的函数（levelOf、allowed），AppError 在边界内不展开', () => {
    const { table, base } = baseline();
    expect(checkEvidence(table, base)).toEqual([]);
    const [report] = closureReports(table, base.read, false);
    expect(Object.keys(report!.deps).sort()).toEqual([`${FIX}/helper.ts#allowed`, `${FIX}/level.ts#levelOf`]);
    expect(report!.unresolved).toEqual([]);
  });

  it('决定实参的函数改动：levelOf 恒返 detail → EVIDENCE_STALE，明细写出依赖链', () => {
    const level = "export function levelOf(kind: string) {\n  return 'detail';\n}\n";
    const found = afterChange({ ...FIXTURE_FILES, [`${FIX}/level.ts`]: level });
    expect(codes(found)).toContain('EVIDENCE_STALE');
    const detail = found.find((f) => f.code === 'EVIDENCE_STALE')!.detail;
    expect(detail).toContain('levelOf');
    expect(detail).toContain('gate');
  });

  it('依赖集合增加：levelOf 新调用同文件函数 extra → EVIDENCE_STALE，明细点名新增依赖', () => {
    const level = [
      'function extra(kind: string) {',
      "  return kind === 'a';",
      '}',
      'export function levelOf(kind: string) {',
      "  return extra(kind) ? 'list' : 'detail';",
      '}',
      '',
    ].join('\n');
    const found = afterChange({ ...FIXTURE_FILES, [`${FIX}/level.ts`]: level });
    expect(found.filter((f) => f.code === 'EVIDENCE_STALE').some((f) => f.detail.includes('extra'))).toBe(true);
  });

  it('依赖集合减少 / 登记里有多余依赖，同样 EVIDENCE_STALE', () => {
    const { table, base } = baseline();
    const unit = `${FIX}/gate.ts#gate`;
    const missing = { [unit]: { [`${FIX}/level.ts#levelOf`]: base.dependencies[unit]![`${FIX}/level.ts#levelOf`]! } };
    expect(codes(checkEvidence(table, { ...base, dependencies: missing }))).toContain('EVIDENCE_STALE');
    const extra = { [unit]: { ...base.dependencies[unit]!, [`${FIX}/gone.ts#removed`]: 'abcdef123456' } };
    expect(codes(checkEvidence(table, { ...base, dependencies: extra }))).toContain('EVIDENCE_STALE');
    expect(codes(checkEvidence(table, { ...base, dependencies: {} }))).toContain('EVIDENCE_STALE');
  });

  it('modules/ 下的计算属性访问（命名空间 import 按变量取成员）→ EVIDENCE_CLOSURE_UNRESOLVED', () => {
    const gate = FIXTURE_FILES[`${FIX}/gate.ts`]!.replace(
      "import { allowed } from './helper.js';",
      "import * as helpers from './helper.js';",
    ).replace('!allowed(kind)', '!helpers[kind](kind)');
    const found = afterChange({ ...FIXTURE_FILES, [`${FIX}/gate.ts`]: gate });
    expect(codes(found)).toContain('EVIDENCE_CLOSURE_UNRESOLVED');
  });

  it('modules/ 下的动态 import 与找不到的相对 import 同样 → EVIDENCE_CLOSURE_UNRESOLVED', () => {
    const dynamic = FIXTURE_FILES[`${FIX}/gate.ts`]!.replace('return levelOf(kind);', "return import('./helper.js');");
    expect(codes(afterChange({ ...FIXTURE_FILES, [`${FIX}/gate.ts`]: dynamic }))).toContain(
      'EVIDENCE_CLOSURE_UNRESOLVED',
    );
    const missing = FIXTURE_FILES[`${FIX}/gate.ts`]!.replace("'./helper.js'", "'./nowhere.js'");
    expect(codes(afterChange({ ...FIXTURE_FILES, [`${FIX}/gate.ts`]: missing }))).toContain(
      'EVIDENCE_CLOSURE_UNRESOLVED',
    );
  });

  it('不设固定深度：互相递归不死循环；超过安全上限（40 层）的链报 depth-limit → EVIDENCE_CLOSURE_UNRESOLVED', () => {
    const chain = (length: number) =>
      Array.from({ length }, (_, i) =>
        i === length - 1 ? `function f${i}() {\n  return 1;\n}` : `function f${i}() {\n  return f${i + 1}();\n}`,
      ).join('\n');
    const gateFile = FIXTURE_FILES[`${FIX}/gate.ts`]!;
    const files = (n: number) => ({
      ...FIXTURE_FILES,
      [`${FIX}/gate.ts`]: `${gateFile.replace('return levelOf(kind);', 'return f0();')}\n${chain(n)}\n`,
    });
    const shallow = baseline(files(8));
    expect(checkEvidence(shallow.table, shallow.base)).toEqual([]);
    const deep = baseline(files(45));
    const found = checkEvidence(deep.table, deep.base);
    expect(codes(found)).toContain('EVIDENCE_CLOSURE_UNRESOLVED');
    expect(show(found)).toContain('depth-limit');
    const cycle =
      FIXTURE_FILES[`${FIX}/helper.ts`] +
      'export function ping() {\n  return pong();\n}\nfunction pong() {\n  return ping();\n}\n';
    const gate = FIXTURE_FILES[`${FIX}/gate.ts`]!.replace('return levelOf(kind);', 'return ping();').replace(
      "import { allowed } from './helper.js';",
      "import { allowed, ping } from './helper.js';",
    );
    const cyclic = baseline({ ...FIXTURE_FILES, [`${FIX}/helper.ts`]: cycle, [`${FIX}/gate.ts`]: gate });
    expect(checkEvidence(cyclic.table, cyclic.base)).toEqual([]);
  });

  it('边界内改动不触发：errors.ts 的 AppError 变化 → 零发现；边界内的计算属性访问也不报', () => {
    const errors = repoSource('apps/api/src/errors.ts');
    const computed = 'export const HELPER = (name: string, ns: Record<string, () => void>) => ns[name]?.();';
    const changed = `${errors}\n${computed}\n`;
    expect(afterChange({ ...FIXTURE_FILES, 'apps/api/src/errors.ts': changed })).toEqual([]);
  });

  it('回归：锚点写错仍报 EVIDENCE_ANCHOR；调用点本身改动仍报 EVIDENCE_STALE', () => {
    const wrong: RequiredTable = {
      'GET /api/tenant/fixture': [{ perm: 'btn:Fixture#open@list', at: [{ ...GATE_CALL, anchor: 'throw nothing' }] }],
    };
    const { base } = baseline();
    expect(codes(checkEvidence(wrong, base))).toContain('EVIDENCE_ANCHOR');
    const gate = FIXTURE_FILES[`${FIX}/gate.ts`]!.replace("'需要权限'", "'别的文案'");
    expect(codes(afterChange({ ...FIXTURE_FILES, [`${FIX}/gate.ts`]: gate }))).toContain('EVIDENCE_STALE');
  });
});

describe('AC-PRM-FW-02 证据闭包（B-02）：真实表', () => {
  const surveyKey = () =>
    Object.entries(REQUIRED).find(([, obligations]) =>
      obligations.some((o) => o.at.some((e) => e.unit.endsWith('survey360/context.ts#routeNeed'))),
    )?.[0];

  it('360 routeNeed → levelOf：levelOf 恒返 detail → EVIDENCE_STALE（原先只登记 routeNeed 本身，漏报）', () => {
    const key = surveyKey();
    expect(key, '表里没有引用 routeNeed 的 360 端点').toBeDefined();
    const file = 'apps/api/src/modules/survey360/context.ts';
    const reader: SourceReader = (path) =>
      path === file
        ? repoSource(path).replace("return found.level as 'list' | 'detail';", "return 'detail';")
        : repoSource(path);
    expect(repoSource(file)).toContain("return found.level as 'list' | 'detail';");
    const found = checkEvidence({ [key!]: REQUIRED[key!]! }, { read: reader });
    expect(
      found.some((f) => f.code === 'EVIDENCE_STALE' && f.detail.includes('levelOf')),
      show(found),
    ).toBe(true);
  });

  it('全表零发现，且没有任何位于 modules/** 的未解析项；输出闭包大小 / 最大深度 / unresolved / 依赖牵连的义务数分布', () => {
    const reports = closureReports(REQUIRED);
    expect(reports.length).toBeGreaterThan(100);
    const quantiles = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
      return { p50: pick(0.5), p90: pick(0.9), max: sorted.at(-1) };
    };
    const uses = usesOf(REQUIRED);
    // 一个依赖被改，要复核的义务数 = 把它放进闭包的各单元所引用的义务数之和（同一义务只算一次）
    const affected = new Map<string, Set<string>>();
    for (const report of reports) {
      for (const dep of Object.keys(report.deps)) {
        const set = affected.get(dep) ?? new Set<string>();
        for (const use of uses.get(report.unit) ?? []) set.add(use.label);
        affected.set(dep, set);
      }
    }
    const counts = [...affected.values()].map((set) => set.size);
    const over100 = [...affected].filter(([, set]) => set.size > 100).map(([dep, set]) => `${dep} ${set.size}`);
    const depth = Math.max(...reports.map((r) => r.depth));
    console.info(
      JSON.stringify({
        units: reports.length,
        closureSize: quantiles(reports.map((r) => r.size)),
        depth,
        unresolved: reports.reduce((n, r) => n + r.unresolved.length, 0),
        dependencies: affected.size,
        affectedObligations: quantiles(counts),
        over100: over100.length,
      }),
    );
    console.info(`OVER100\n${over100.sort().join('\n')}`);
    expect(depth).toBeLessThanOrEqual(MAX_DEPTH);
    const unresolved = checkEvidence(REQUIRED, { unused: true }).filter(
      (f) => f.code === 'EVIDENCE_CLOSURE_UNRESOLVED',
    );
    expect(unresolved, show(unresolved)).toEqual([]);
  });

  it('边界清单只放授权引擎与通用基础设施：每条有理由；modules/<模块>/ 下除 permission 外一个都不允许', () => {
    expect(EVIDENCE_BOUNDARY.length).toBeGreaterThan(0);
    for (const entry of EVIDENCE_BOUNDARY) expect(entry.reason.trim().length, entry.path).toBeGreaterThan(0);
    expect(() => assertBoundaryShape(EVIDENCE_BOUNDARY)).not.toThrow();
    const polluted = [...EVIDENCE_BOUNDARY, { path: 'apps/api/src/modules/job/routes.ts', reason: '夹具' }];
    expect(() => assertBoundaryShape(polluted)).toThrow(/modules/);
    const empty = [{ path: 'apps/api/src/errors.ts', reason: ' ' }];
    expect(() => assertBoundaryShape(empty)).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// B-04 R9 去重键加调用点
// ---------------------------------------------------------------------------------------------------------------

describe('AC-PRM-FW-02 R9 去重键加调用点（B-04）', () => {
  const GOALS = 'POST /api/tenant/idp/plans/:id/goals';
  const entry = (key: string) => REQUIRED[key]!;
  const base: Obligation = {
    perm: 'btn:Fixture#open@list',
    at: [GATE_CALL],
  };
  const table = (...obligations: Obligation[]): RequiredTable => ({ 'GET /api/tenant/fixture': obligations });
  const run = (obligations: Obligation[]) =>
    codes(checkEvidence(table(...obligations), { ...baseline().base, digests: undefined }));

  it('同权同用途、不同 call 单元 → 不报 TABLE_CONFLICT', () => {
    const other: Obligation = { ...base, at: [{ role: 'call', unit: `${FIX}/level.ts#levelOf`, anchor: "'detail'" }] };
    expect(run([base, other])).not.toContain('TABLE_CONFLICT');
  });

  it('同权同用途、同单元不同锚点 → 不报；锚点与单元全同 → TABLE_CONFLICT（同函数同锚点视为同一判定）', () => {
    const anchored: Obligation = { ...base, at: [{ ...GATE_CALL, anchor: 'return levelOf(kind)' }] };
    expect(run([base, anchored])).not.toContain('TABLE_CONFLICT');
    expect(run([base, { ...base }])).toContain('TABLE_CONFLICT');
    // impl / const 证据不进去重键：只换实现证据仍算同一判定
    const implOnly: Obligation = {
      ...base,
      at: [GATE_CALL, { role: 'impl', unit: `${FIX}/helper.ts#allowed`, anchor: 'kind.length' }],
    };
    expect(run([base, implOnly])).toContain('TABLE_CONFLICT');
  });

  it('IDP 执行人入口“守卫内部 + 披露”复用同一权限仍通过；完全相同的重复才冲突', () => {
    expect(codes(checkEvidence({ [GOALS]: entry(GOALS) }))).not.toContain('TABLE_CONFLICT');
    const view = entry(GOALS).find((o) => o.perm === 'obj:IDP.Idp:view')!;
    expect(codes(checkEvidence({ [GOALS]: [...entry(GOALS), view] }))).toContain('TABLE_CONFLICT');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// B-07 动态选择器绑定
// ---------------------------------------------------------------------------------------------------------------

const TALENT_FORM = 'GET /api/tenant/talent/forms/:object';
const JOB_LIST = 'GET /api/tenant/job/:kind';
const TODOS = 'POST /api/tenant/contracts/todos/batch';
const EMPLOYMENT_PREVIEW = 'POST /api/tenant/employment/employees/:id/import/forward-update-preview';

type Node = Record<string, unknown>;
const withPolicy = (base: ManifestRoute, policy: unknown): ManifestRoute => ({
  ...base,
  policy: policy as RoutePolicy,
});

function editAt(key: string, position: string, change: (selector: Node) => void): ManifestRoute {
  const base = route(key);
  const policy = structuredClone(base.policy) as unknown as Node;
  const site = mapSelectors(base.policy).find((s) => s.position === position);
  if (!site) throw new Error(`${key} 没有位置 ${position}`);
  let node = policy;
  for (const segment of site.position.split('.').slice(0, -1)) {
    const match = /^(\w+)\[(\d+)\]$/.exec(segment);
    node = (match ? (node[match[1]!] as Node[])[Number(match[2])] : node[segment]) as Node;
  }
  change(node[site.field] as Node);
  return withPolicy(base, policy);
}

const compare = (routes: readonly ManifestRoute[], bindings?: BranchBindings) =>
  compareDeclarations(frozen, routes, REQUIRED, bindings);
const REAL: BranchBindings = { inputs: BRANCH_INPUTS, values: BRANCH_VALUES };

describe('AC-PRM-FW-02 选择器绑定（B-07）：登记完整性', () => {
  it('声明里的 map 选择器位置 = 输入来源表登记的位置（双向，端点 × 位置）', () => {
    const declaredSites = manifest.declared.flatMap((r) =>
      mapSelectors(r.policy).map((s) => `${r.method} ${r.path} @${s.position}`),
    );
    const registered = Object.entries(BRANCH_INPUTS).flatMap(([key, entries]) =>
      entries.map((e) => `${key} @${e.position}`),
    );
    expect(declaredSites.length).toBeGreaterThanOrEqual(29);
    expect(new Set(Object.keys(BRANCH_INPUTS)).size).toBe(23);
    expect(declaredSites).toHaveLength(31);
    expect([...registered].sort()).toEqual([...declaredSites].sort());
    expect(new Set(registered).size).toBe(registered.length);
  });

  it('每条输入来源登记都有证据（调用点 + 取值处），每个分支值条目都有证据', () => {
    for (const [key, entries] of Object.entries(BRANCH_INPUTS)) {
      for (const input of entries as readonly BranchInput[]) {
        expect(
          input.at.some((e) => e.role === 'call'),
          `${key} @${input.position} 缺调用点证据`,
        ).toBe(true);
        expect(input.at.length, `${key} @${input.position}`).toBeGreaterThanOrEqual(2);
      }
    }
    for (const [domain, entries] of Object.entries(BRANCH_VALUES)) {
      for (const entry of entries) expect(entry.at.length, `${domain}/${entry.field}`).toBeGreaterThan(0);
    }
  });

  it('真实声明 × 真实登记：31 个 map 选择器位置（23 条端点；设计估算 29 个，另含 failureAudit.objectType 与任职资格 owner-orgs）零发现', () => {
    const findings = compare(manifest.declared);
    expect(findings, show(findings)).toEqual([]);
  });

  it('分支值与输入来源的证据锚点命中、摘要与依赖登记一致（EVIDENCE_STALE / ANCHOR 为零）', () => {
    const found = checkEvidence({}, { unused: false });
    expect(
      found.filter((f) => /^EVIDENCE_(STALE|ANCHOR|UNIT|MISSING)$/.test(f.code)),
      show(found),
    ).toEqual([]);
  });
});

describe('AC-PRM-FW-02 选择器绑定（B-07）：审查原文反例', () => {
  it('人才表单六个键全改指标库 → MISMATCH:branchValue', () => {
    const mutated = editAt(TALENT_FORM, 'of[0].object', (selector) => {
      selector['map'] = Object.fromEntries(
        Object.keys(selector['map'] as Node).map((k) => [k, 'TalentCenter.Dimension']),
      );
    });
    expect(codes(compare([mutated]))).toContain('MISMATCH:branchValue');
  });

  it("人才表单 path 'object' → 'kind'；from 'param' → 'body' → MISMATCH:branchInput", () => {
    const path = editAt(TALENT_FORM, 'of[0].object', (selector) => (selector['path'] = 'kind'));
    expect(codes(compare([path]))).toContain('MISMATCH:branchInput');
    const from = editAt(TALENT_FORM, 'of[0].object', (selector) => (selector['from'] = 'body'));
    expect(codes(compare([from]))).toContain('MISMATCH:branchInput');
  });

  it('职务两个键的值对调（layers ⇄ grades）→ MISMATCH:branchValue', () => {
    const mutated = editAt(JOB_LIST, 'object', (selector) => {
      const map = selector['map'] as Record<string, string>;
      selector['map'] = { ...map, layers: map['grades']!, grades: map['layers']! };
    });
    expect(codes(compare([mutated]))).toContain('MISMATCH:branchValue');
  });

  it('合同待办批量：resubmit 的关系换成 currentAssignee → MISMATCH:branchValue', () => {
    const mutated = editAt(TODOS, 'relation', (selector) => {
      selector['map'] = { ...(selector['map'] as Node), resubmit: 'approval.currentAssignee' };
    });
    expect(codes(compare([mutated]))).toContain('MISMATCH:branchValue');
  });

  it('任职导入预览：预览行的操作换成导入行的 create / update → MISMATCH:branchValue（预览与导入值表不能互换）', () => {
    const mutated = editAt(EMPLOYMENT_PREVIEW, 'rows.operation', (selector) => {
      selector['map'] = { create: 'create', edit: 'update' };
    });
    expect(codes(compare([mutated]))).toContain('MISMATCH:branchValue');
  });
});

describe('AC-PRM-FW-02 选择器绑定（B-07）：登记缺失与登记错位', () => {
  it('删一条输入来源登记 → BRANCH_INPUT_UNBOUND', () => {
    const { [TALENT_FORM]: _dropped, ...rest } = BRANCH_INPUTS;
    const found = compare([route(TALENT_FORM)], { inputs: rest, values: BRANCH_VALUES });
    expect(codes(found)).toContain('BRANCH_INPUT_UNBOUND');
    const partial = { ...BRANCH_INPUTS, [TALENT_FORM]: BRANCH_INPUTS[TALENT_FORM]!.slice(1) };
    expect(codes(compare([route(TALENT_FORM)], { inputs: partial, values: BRANCH_VALUES }))).toContain(
      'BRANCH_INPUT_UNBOUND',
    );
  });

  it('删一条分支值登记 → BRANCH_VALUE_UNBOUND', () => {
    const values = { ...BRANCH_VALUES, 'talent.object': [] };
    expect(codes(compare([route(TALENT_FORM)], { inputs: BRANCH_INPUTS, values }))).toContain('BRANCH_VALUE_UNBOUND');
  });

  it('登记了位置但声明里没有选择器（声明被改成静态值）→ MISMATCH:branchInput', () => {
    const base = route(TALENT_FORM);
    const policy = structuredClone(base.policy) as unknown as { of: Node[] };
    policy.of[0]!['operation'] = 'create';
    expect(codes(compare([withPolicy(base, policy)]))).toContain('MISMATCH:branchInput');
  });

  it('登记的域与声明选择器的键集合不一致 → MISMATCH:branchInput（域是五元组之一）', () => {
    const tampered = {
      ...BRANCH_INPUTS,
      [JOB_LIST]: BRANCH_INPUTS[JOB_LIST]!.map((e) => ({ ...e, domain: 'personnel.subset' })),
    };
    expect(codes(compare([route(JOB_LIST)], { inputs: tampered, values: BRANCH_VALUES }))).toContain(
      'MISMATCH:branchInput',
    );
  });

  it('改内联映射所在函数 / 取值处所在函数 → EVIDENCE_STALE', () => {
    const inline = BRANCH_VALUES['employment.importRowOperation']!.flatMap((e) => e.at);
    const input = BRANCH_INPUTS[JOB_LIST]!.flatMap((e) => e.at);
    for (const evidence of [inline[0]!, input[0]!]) {
      const [file] = evidence.unit.split('#');
      const original = unitText(repoSource, evidence.unit);
      const end = original.lastIndexOf('}');
      const touched = end < 0 ? `${original} void 0;` : `${original.slice(0, end)}void 0; ${original.slice(end)}`;
      const reader: SourceReader = (path) =>
        path === file ? repoSource(path).replace(original, touched) : repoSource(path);
      expect(reader(file!), `${evidence.unit} 补丁没有生效`).not.toBe(repoSource(file!));
      expect(codes(checkEvidence({}, { read: reader }))).toContain('EVIDENCE_STALE');
    }
  });
});

describe('AC-PRM-FW-02 选择器绑定（B-07）：新结构弱化（按声明结构生成，不经比较器筛选）', () => {
  const sites = () => manifest.declared.flatMap((r) => mapSelectors(r.policy).map((s) => ({ route: r, site: s })));
  const generated = (kind: string) =>
    manifest.declared.flatMap((r) => weakeningsOf(r, frozen)).filter((w) => w.kind === kind);

  it('WEAKENING_KINDS 登记三类新弱化', () => {
    expect(WEAKENING_KINDS).toEqual(expect.arrayContaining(['selector→value', 'selector→path', 'selector→from']));
  });

  const cases = [
    ['selector→path', 'MISMATCH:branchInput'],
    ['selector→from', 'MISMATCH:branchInput'],
    ['selector→value', 'MISMATCH:branchValue'],
  ] as const;
  for (const [kind, code] of cases) {
    it(`${kind} → ${code}：生成数 = 期望数 = 报出数`, () => {
      const all = sites();
      const expected =
        kind === 'selector→value'
          ? // 值全换成同域另一个合法值：映射里至少有两种不同的值才有“另一个”可换
            all.filter(({ site }) => new Set(Object.values(site.map).map((v) => JSON.stringify(v))).size >= 2).length
          : all.length;
      const weakenings = generated(kind);
      expect(weakenings.length).toBe(expected);
      expect(weakenings.length).toBeGreaterThanOrEqual(29);
      const missed = weakenings.filter((w) => !codes(compare([w.route])).includes(code));
      expect(missed.map((w) => `${w.route.method} ${w.route.path} @${w.at}`)).toEqual([]);
    });
  }

  it('REAL 登记 = 默认登记（compareDeclarations 不传第四参数时用真实登记）', () => {
    expect(codes(compare([route(TALENT_FORM)], REAL))).toEqual(codes(compare([route(TALENT_FORM)])));
  });
});
