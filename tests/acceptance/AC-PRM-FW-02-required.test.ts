/**
 * AC-PRM-FW-02（续，F-039 PR-A 第 4 轮，DEC-348②）：必需项显式表与硬比对。
 * 表（support/route-policy/required/）逐端点登记审定过的义务：权限键 + 用途（准入 / 披露 / 守卫内部 / 条件准入）+
 * 每条义务的证据（强制调用点、授权实现、决定实参的常量）。校验器拿声明与表硬比对：
 * - 准入义务缺失 → REQUIRED_MISSING；准入义务出现在 optional → REQUIRED_IN_OPTIONAL；
 * - 披露义务没有同名 optional 分支授予 → DISCLOSURE_MISSING；纯披露出现在准入 → DISCLOSURE_AS_ADMISSION；
 * - 条件准入写成无条件 → CONDITIONAL_AS_ADMISSION；optional / 准入里出现表外的权限 → *_UNCLASSIFIED；
 * - 探测器原始事实没有被任何义务承接 → REQUIRED_TABLE_GAP（探测器只提供漏登线索）。
 * 证据：锚点必须出现在所指函数 / 常量里；函数体或常量一改，摘要不一致 → EVIDENCE_STALE，须复核受影响的义务。
 * 锚点存在不是语义证明：只改权限键、保留真实锚点和摘要，证据校验发现不了，靠人工审定（下文专门一例说明）。
 */
import { type ManifestRoute, routeManifest, type RouteManifest, type RoutePolicy } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { readdirSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { readFrozenContract } from './support/route-policy/baseline.js';
import { compareDeclarations, type Finding } from './support/route-policy/compare.js';
import type { ObservedContract } from './support/route-policy/contract.js';
import { checkEvidence, repoSource, type SourceReader, writeDigests } from './support/route-policy/evidence.js';
import { admissionPrimitives, checkRequired } from './support/route-policy/required.js';
import { expectedMutationKeys, missingCoverage } from './support/route-policy/required-coverage.js';
import { REQUIRED_MUTATION_KINDS, requiredMutants } from './support/route-policy/required-mutate.js';
import { REQUIRED } from './support/route-policy/required/index.js';
import type { Obligation, RequiredTable } from './support/route-policy/required/types.js';
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

const MANAGER = 'GET /api/tenant/employment/transfers/manager';
const REPORTING = 'GET /api/tenant/employment/transfers/manager/reporting';
const ISSUE = 'POST /api/tenant/idp/plans/tasks/issue';
const GOALS = 'POST /api/tenant/idp/plans/:id/goals';
const MODEL_IMAGE = 'GET /api/tenant/talent/criteria/:id/model-image';
const IMPORT_360 = 'POST /api/tenant/survey360/activities/:id/appraisers/import';
const CONTRACT_IMPORT = 'POST /api/tenant/contracts/imports';
const HR_BUTTON = 'btn:TenantBase.EmploymentRecord#Transfer.Hr@detail';
const MANAGER_BUTTON = 'btn:TenantBase.EmploymentRecord#Transfer.Manager@detail';

function route(key: string): ManifestRoute {
  const found = manifest.declared.find((r) => `${r.method} ${r.path}` === key);
  if (!found) throw new Error(`没有声明 ${key}`);
  return found;
}

const withPolicy = (base: ManifestRoute, policy: RoutePolicy): ManifestRoute => ({ ...base, policy });
const codes = (findings: readonly Finding[]) => findings.map((f) => f.code);
const show = (findings: readonly Finding[]) => findings.map((f) => `${f.route} ${f.code}: ${f.detail}`).join('\n');
const check = (routes: readonly ManifestRoute[], table: RequiredTable = REQUIRED) =>
  checkRequired(table, frozen, routes);

function entry(key: string): readonly Obligation[] {
  const found = REQUIRED[key];
  if (!found) throw new Error(`表里没有 ${key}`);
  return found;
}

function withEntry(key: string, obligations: readonly Obligation[]): RequiredTable {
  return { ...REQUIRED, [key]: obligations };
}

/** 只读一个端点的表项，供证据校验的夹具（全表校验太慢且无关）。 */
function only(key: string, obligations: readonly Obligation[] = entry(key)): RequiredTable {
  return { [key]: obligations };
}

type ObjectNode = Extract<RoutePolicy, { kind: 'object' }>;

describe('AC-PRM-FW-02 显式必需项表：形状与完整性', () => {
  it('表键与运行时 533 个端点完全相等（缺一条、多一条都失败）', () => {
    const declared = manifest.declared.map((r) => `${r.method} ${r.path}`).sort();
    expect(Object.keys(REQUIRED).sort()).toEqual(declared);
    expect(declared).toHaveLength(533);
  });

  it('表文件只放字面量：不 import 声明、产品代码或探测器（不得从候选声明重新生成）', () => {
    const dir = new URL('./support/route-policy/required/', import.meta.url);
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(new URL(name, dir), 'utf8');
      const imports = [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      expect(
        imports.filter((spec) => !/^\.\/[\w-]+\.js$/.test(spec!)),
        name,
      ).toEqual([]);
    }
  });

  it('全表证据校验零发现：每条义务都有强制调用点证据，锚点命中，摘要与源码一致', () => {
    if (process.env['ROUTE_POLICY_UPDATE_DIGESTS'] === '1') writeDigests(REQUIRED);
    const findings = checkEvidence(REQUIRED, { unused: true });
    expect(findings, show(findings)).toEqual([]);
  });

  it('真实声明 × 真实表：零发现', () => {
    const findings = check(manifest.declared);
    expect(findings, show(findings)).toEqual([]);
  });

  it('同一权限多种用途（IDP 执行人写入口的计划查看权：执行人判定内部 + responseView 披露）不算冲突', () => {
    const plan = entry(GOALS).filter((o) => o.perm === 'obj:IDP.Idp:view');
    expect(new Set(plan.map((o) => o.purpose ?? 'admission')).size).toBeGreaterThanOrEqual(2);
    expect(plan.map((o) => o.purpose)).toContain('disclosure:responseView');
    expect(codes(checkEvidence(only(GOALS)))).not.toContain('TABLE_CONFLICT');
    // 权限 + 用途 + 承载者完全相同的重复才是冲突
    const duplicated = only(GOALS, [...entry(GOALS), plan[0]!]);
    expect(codes(checkEvidence(duplicated))).toContain('TABLE_CONFLICT');
  });
});

describe('AC-PRM-FW-02 显式表反例：准入 / 披露 / optional', () => {
  it('经理汇报关系页：只把必需的 Transfer.Hr 按钮叶子移进 optional → REQUIRED_IN_OPTIONAL', () => {
    const base = route(REPORTING);
    const policy = base.policy as ObjectNode;
    expect(JSON.stringify(policy.button)).toContain('Transfer.Hr');
    const moved = {
      ...policy,
      button: { none: true as const, reason: '弱化' },
      optional: {
        hr: {
          kind: 'object' as const,
          object: policy.object,
          operation: 'button' as const,
          button: policy.button,
          scope: { mode: 'none' as const, reason: '弱化' },
          fields: { mode: 'none' as const, reason: '弱化' },
        },
      },
    } as RoutePolicy;
    const found = codes(check([withPolicy(base, moved)]));
    expect(found).toContain(`REQUIRED_IN_OPTIONAL`);
    expect(found).toContain(`REQUIRED_MISSING`);
  });

  it('IDP 任务发放：必需的计划查看分支从 all.of 移进 optional → REQUIRED_IN_OPTIONAL', () => {
    const base = route(ISSUE);
    const policy = base.policy as Extract<RoutePolicy, { kind: 'all' }>;
    const index = policy.of.findIndex((branch) => JSON.stringify(branch).includes('"IDP.Idp"'));
    expect(index).toBeGreaterThanOrEqual(0);
    const moved = {
      ...policy,
      of: policy.of.filter((_b, i) => i !== index),
      optional: { planView: policy.of[index]! },
    } as RoutePolicy;
    expect(codes(check([withPolicy(base, moved)]))).toContain('REQUIRED_IN_OPTIONAL');
  });

  it('经理入口：真实声明零发现；canApply / canViewReporting 在表里是披露义务', () => {
    expect(check([route(MANAGER)])).toEqual([]);
    const purposes = Object.fromEntries(entry(MANAGER).map((o) => [o.perm, o.purpose]));
    expect(purposes[HR_BUTTON]).toBe('disclosure:canViewReporting');
    expect(purposes[MANAGER_BUTTON]).toBe('disclosure:canApply');
  });

  it('经理入口：删掉 optional 里的合法披露 canViewReporting → DISCLOSURE_MISSING', () => {
    const base = route(MANAGER);
    const policy = base.policy as ObjectNode;
    const { canViewReporting: _dropped, ...rest } = policy.optional!;
    const findings = check([withPolicy(base, { ...policy, optional: rest })]);
    expect(codes(findings), show(findings)).toContain('DISCLOSURE_MISSING');
  });

  it('经理入口：根节点新增必需 Transfer.Hr 按钮、原 optional 保留 → DISCLOSURE_AS_ADMISSION（纯披露误写成准入）', () => {
    const base = route(MANAGER);
    const policy = base.policy as ObjectNode;
    const hr = { code: 'Transfer.Hr', level: 'detail' as const };
    const findings = check([withPolicy(base, { ...policy, button: hr })]);
    expect(codes(findings), show(findings)).toContain('DISCLOSURE_AS_ADMISSION');
  });

  it('模型图：准入与 optional.canEdit 共用同一个 point 范围，零发现（按 对象 + 操作 + 用途 匹配，不按范围字符串）', () => {
    expect(check([route(MODEL_IMAGE)])).toEqual([]);
    const findings = compareDeclarations(frozen, [route(MODEL_IMAGE)]);
    expect(findings, show(findings)).toEqual([]);
    const canEdit = entry(MODEL_IMAGE).filter((o) => o.purpose === 'disclosure:canEdit');
    expect(canEdit.map((o) => o.perm)).toContain('obj:TalentCenter.TalentCriterion:update');
  });

  it('optional 里出现表外的分支 → OPTIONAL_UNCLASSIFIED；准入里出现表外的权限 → ADMISSION_UNCLASSIFIED', () => {
    const base = route(REPORTING);
    const policy = base.policy as ObjectNode;
    const extra = {
      ...policy,
      optional: {
        extra: { ...policy, button: { code: 'Transfer.Self', level: 'detail' as const }, optional: undefined },
      },
    } as RoutePolicy;
    expect(codes(check([withPolicy(base, extra)]))).toContain('OPTIONAL_UNCLASSIFIED');
    const guarded = { ...policy, guards: [...(policy.guards ?? []), 'fixture.unregistered'] } as RoutePolicy;
    expect(codes(check([withPolicy(base, guarded)]))).toContain('ADMISSION_UNCLASSIFIED');
  });

  it('探测器原始事实没有被任何义务承接 → REQUIRED_TABLE_GAP（探测器只提供漏登线索，不自动分类）', () => {
    const observed = frozen.routes[REPORTING]!;
    const gap: ObservedContract = {
      ...frozen,
      routes: {
        ...frozen.routes,
        [REPORTING]: { ...observed, primitives: { ...observed.primitives, admin: ['fixture.unclaimed'] } },
      },
    };
    expect(codes(checkRequired(REQUIRED, gap, [route(REPORTING)]))).toContain('REQUIRED_TABLE_GAP');
  });
});

describe('AC-PRM-FW-02 显式表：组合公式与共享原语', () => {
  // 夹具：any[ 管理员能力, 对象查看 + 详情按钮 ]；表：同一 group 两个备选，备选内 AND、备选间 OR
  const key = 'GET /fixture/required/or';
  const fixture: ManifestRoute = {
    method: 'GET',
    path: '/fixture/required/or',
    policy: {
      kind: 'any',
      of: [
        { kind: 'admin', capability: 'process_matrix', fields: { mode: 'none', reason: '夹具' } },
        {
          kind: 'object',
          object: 'Fixture.Object',
          operation: 'view',
          button: { code: 'detail', level: 'detail' },
          scope: { mode: 'none', reason: '夹具' },
          fields: { mode: 'none', reason: '夹具' },
        },
      ],
    } as RoutePolicy,
  } as ManifestRoute;
  const call = { role: 'call', unit: 'apps/api/src/app.ts#createApp', anchor: 'createApp' } as const;
  const table: RequiredTable = {
    [key]: [
      { perm: 'admin:process_matrix', or: 'view:admin', at: [call] },
      { perm: 'obj:Fixture.Object:view', or: 'view:object', at: [call] },
      { perm: 'btn:Fixture.Object#detail@detail', or: 'view:object', at: [call] },
    ],
  };

  it('每个声明备选满足同组某一备选的全部义务：零发现', () => {
    expect(checkRequired(table, frozen, [fixture])).toEqual([]);
  });

  it('对象分支只剩查看、去掉按钮 → 该备选不满足组内任一备选 → REQUIRED_MISSING', () => {
    const policy = fixture.policy as Extract<RoutePolicy, { kind: 'any' }>;
    const weakened = {
      ...policy,
      of: [policy.of[0]!, { ...(policy.of[1] as ObjectNode), button: { none: true, reason: '弱化' } }],
    } as RoutePolicy;
    expect(codes(checkRequired(table, frozen, [withPolicy(fixture, weakened)]))).toContain('REQUIRED_MISSING');
  });

  it('同一原始事实被准入和披露同时承接：准入那份留在第二道比较里，披露分流不吞掉它', () => {
    const observed = frozen.routes[MODEL_IMAGE]!;
    const shared = 'object:objectContext';
    expect(observed.primitives['object']).toContain('objectContext');
    const obligations: Obligation[] = [
      { perm: 'obj:TalentCenter.TalentCriterion:view', facts: [shared], at: [call] },
      { perm: 'obj:TalentCenter.TalentCriterion:update', purpose: 'disclosure:canEdit', facts: [shared], at: [call] },
    ];
    expect(admissionPrimitives(observed, obligations)['object']).toContain('objectContext');
    const onlyDisclosure: Obligation[] = [
      { perm: 'obj:TalentCenter.TalentCriterion:update', purpose: 'disclosure:canEdit', facts: [shared], at: [call] },
    ];
    expect(admissionPrimitives(observed, onlyDisclosure)['object']).toBeUndefined();
  });
});

describe('AC-PRM-FW-02 显式表：条件准入由必需的具名条件守卫承载', () => {
  it('360 导入评价者：员工信息查看权登记为 when:survey360.syncEmployees，守卫本身是准入义务', () => {
    const obligations = entry(IMPORT_360);
    expect(obligations.find((o) => o.perm === 'obj:TenantBase.EmployeeInformation:view')?.purpose).toBe(
      'when:survey360.syncEmployees',
    );
    expect(obligations.some((o) => o.perm === 'guard:survey360.syncEmployees' && !o.purpose)).toBe(true);
  });

  it('360 导入评价者：删条件守卫 → REQUIRED_MISSING；员工信息查看写成无条件准入 → CONDITIONAL_AS_ADMISSION', () => {
    const base = route(IMPORT_360);
    const policy = base.policy as ObjectNode;
    const stripped = { ...policy, guards: (policy.guards ?? []).filter((g) => g !== 'survey360.syncEmployees') };
    expect(JSON.stringify(stripped)).not.toContain('survey360.syncEmployees');
    expect(codes(check([withPolicy(base, stripped)]))).toContain('REQUIRED_MISSING');
    const employeeView: RoutePolicy = {
      kind: 'object',
      object: 'TenantBase.EmployeeInformation',
      operation: 'view',
      button: { none: true, reason: '弱化' },
      scope: { mode: 'none', reason: '弱化' },
      fields: { mode: 'none', reason: '弱化' },
    };
    const { write, ...admission } = base.policy;
    const unconditional = {
      kind: 'all',
      of: [admission, employeeView],
      fields: { mode: 'none', reason: '弱化' },
      write,
    } as RoutePolicy;
    expect(codes(check([withPolicy(base, unconditional)]))).toContain('CONDITIONAL_AS_ADMISSION');
  });

  it('合同导入：初始化的删除权登记为 when:contracts.importInitializeDelete；删守卫 → REQUIRED_MISSING', () => {
    const obligations = entry(CONTRACT_IMPORT);
    expect(obligations.find((o) => o.perm === 'obj:TenantBase.EmploymentContract:delete')?.purpose).toBe(
      'when:contracts.importInitializeDelete',
    );
    const base = route(CONTRACT_IMPORT);
    const text = JSON.stringify(base.policy).replaceAll('"contracts.importInitializeDelete"', '"fixture.dropped"');
    const findings = check([withPolicy(base, JSON.parse(text) as RoutePolicy)]);
    expect(codes(findings), show(findings)).toContain('REQUIRED_MISSING');
  });
});

describe('AC-PRM-FW-02 显式表：证据覆盖调用点、授权实现与常量两端', () => {
  const hr = () => entry(REPORTING).find((o) => o.perm === HR_BUTTON)!;
  function patched(unitFile: string, from: string, to: string): SourceReader {
    return (file) => {
      const text = repoSource(file);
      return file === unitFile ? text.replace(from, to) : text;
    };
  }

  it('汇报关系页的 Transfer.Hr 同时绑调用点（处理函数）、实现（managerHasHr）与常量', () => {
    const roles = hr().at.map((e) => e.role);
    expect(roles).toEqual(expect.arrayContaining(['call', 'impl', 'const']));
    expect(hr().at.some((e) => e.role === 'impl' && e.unit.endsWith('#managerHasHr'))).toBe(true);
  });

  it('改实现：managerHasHr 里的按钮从 Transfer.Hr 改成 Transfer.Manager → EVIDENCE_STALE（和锚点失配）', () => {
    const impl = hr().at.find((e) => e.role === 'impl')!;
    const [file] = impl.unit.split('#');
    const reader = patched(
      file!,
      "buttonResource(EMPLOYMENT_OBJECT, 'Transfer.Hr'",
      "buttonResource(EMPLOYMENT_OBJECT, 'Transfer.Manager'",
    );
    const found = codes(checkEvidence(only(REPORTING), { read: reader }));
    expect(found).toContain('EVIDENCE_STALE');
  });

  it('改调用点：处理函数撤掉 managerHasHr 的 403 判定 → EVIDENCE_STALE', () => {
    const call = hr().at.find((e) => e.role === 'call')!;
    const [file] = call.unit.split('#');
    const reader = patched(
      file!,
      "if (!(await managerHasHr(ctx, deps))) throw new AppError('FORBIDDEN', '需要人事身份');",
      '',
    );
    const found = codes(checkEvidence(only(REPORTING), { read: reader }));
    expect(found).toContain('EVIDENCE_STALE');
  });

  it('改常量：决定实参的对象编码常量变化 → EVIDENCE_STALE', () => {
    const constant = hr().at.find((e) => e.role === 'const')!;
    const [file, name] = constant.unit.split('#');
    const reader: SourceReader = (path) => {
      const text = repoSource(path);
      return path === file ? text.replace(new RegExp(`(${name}\\s*=\\s*)'`), "$1'X") : text;
    };
    expect(codes(checkEvidence(only(REPORTING), { read: reader }))).toContain('EVIDENCE_STALE');
  });

  it('改错锚点（实现证据写成 Transfer.Manager）→ EVIDENCE_ANCHOR', () => {
    const wrong = entry(REPORTING).map((o) =>
      o.perm === HR_BUTTON
        ? { ...o, at: o.at.map((e) => (e.role === 'impl' ? { ...e, anchor: "'Transfer.Manager'" } : e)) }
        : o,
    );
    expect(codes(checkEvidence(only(REPORTING, wrong)))).toContain('EVIDENCE_ANCHOR');
  });

  it('只改权限键、保留真实锚点和摘要：证据校验发现不了（锚点存在不是语义证明），声明同错时硬比对也发现不了——靠人工审定', () => {
    const wrong = entry(REPORTING).map((o) => (o.perm === HR_BUTTON ? { ...o, perm: MANAGER_BUTTON } : o));
    expect(checkEvidence(only(REPORTING, wrong))).toEqual([]);
    const base = route(REPORTING);
    const policy = base.policy as ObjectNode;
    const sameWrong = withPolicy(base, { ...policy, button: { code: 'Transfer.Manager', level: 'detail' } });
    expect(codes(checkRequired(withEntry(REPORTING, wrong), frozen, [sameWrong]))).not.toContain('REQUIRED_MISSING');
  });

  it('义务缺证据或缺强制调用点证据 → EVIDENCE_MISSING', () => {
    const none = entry(REPORTING).map((o) => (o.perm === HR_BUTTON ? { ...o, at: [] } : o));
    expect(codes(checkEvidence(only(REPORTING, none)))).toContain('EVIDENCE_MISSING');
    const implOnly = entry(REPORTING).map((o) =>
      o.perm === HR_BUTTON ? { ...o, at: o.at.filter((e) => e.role !== 'call') } : o,
    );
    expect(codes(checkEvidence(only(REPORTING, implOnly)))).toContain('EVIDENCE_MISSING');
  });
});

describe('AC-PRM-FW-02 显式表突变：按审定义务逐项、逐准入备选生成，不经比较器筛选', () => {
  for (const kind of REQUIRED_MUTATION_KINDS) {
    it(`${kind}`, () => {
      const mutants = manifest.declared.flatMap((r) => requiredMutants(r, REQUIRED)).filter((m) => m.kind === kind);
      expect(mutants.length, `没有任何义务能施加 ${kind}`).toBeGreaterThan(0);
      const missed = mutants.filter((m) => !codes(check([m.route])).includes(m.expected));
      expect(
        missed.map((m) => `${m.route.method} ${m.route.path} ${m.perm} @${m.at}`),
        `${kind} 未报 ${mutants[0]?.expected}`,
      ).toEqual([]);
    });
  }

  it('B-05 覆盖断言：期望集合（端点 | 权限 | 备选 | 来源路径，由表义务与声明备选独立推导）= 实际生成的 required→none 集合', () => {
    const expected = manifest.declared.flatMap((r) => expectedMutationKeys(r, REQUIRED));
    const mutants = manifest.declared.flatMap((r) => requiredMutants(r, REQUIRED));
    const gaps = missingCoverage(expected, mutants);
    expect(gaps, gaps.join('\n')).toEqual([]);
    expect(expected.length).toBeGreaterThan(0);
    // 类 × 用途 × 端点计数：每类突变至少覆盖一个端点
    const perKind = new Map<string, Set<string>>();
    for (const m of mutants) perKind.set(m.kind, (perKind.get(m.kind) ?? new Set()).add(m.key));
    for (const kind of REQUIRED_MUTATION_KINDS) expect(perKind.get(kind)?.size ?? 0, kind).toBeGreaterThan(0);
  });

  it('B-05 覆盖断言本身可失败：夹具里少生成一个备选的突变，断言报缺口', () => {
    const key = 'GET /api/tenant/idp/approval-processes';
    const expected = expectedMutationKeys(route(key), REQUIRED);
    const mutants = requiredMutants(route(key), REQUIRED);
    expect(missingCoverage(expected, mutants)).toEqual([]);
    const lacking = mutants.filter((m) => !m.coverageKey.includes('|2|'));
    expect(missingCoverage(expected, lacking).length).toBeGreaterThan(0);
  });

  it('B-05 “或”组：|S|=1 对组内备选每个权限生成 or-member→none；|S|>1 生成 or-group→none，都报 REQUIRED_MISSING', () => {
    const key = 'GET /api/tenant/idp/approval-processes';
    const members = requiredMutants(route(key), REQUIRED).filter((m) => m.kind === 'or-member→none');
    expect(members.map((m) => `${m.perm}@${m.at.split(':')[0]}`).sort()).toEqual([
      'obj:IDP.IDPProcess:create@备选1',
      'obj:IDP.IDPProcess:update@备选2',
    ]);
    // 夹具：任一备选同时含 create 与 update（|S|=2）→ 删单个成员仍满足，必须整组删
    const base = route(key);
    const both = JSON.parse(JSON.stringify(base.policy)) as { of: { kind: string; of?: unknown[] }[] };
    const group = both.of[1]!;
    group.kind = 'all';
    const found = requiredMutants({ ...base, policy: both as unknown as RoutePolicy }, REQUIRED);
    const groups = found.filter((m) => m.kind === 'or-group→none');
    expect(groups.length).toBeGreaterThan(0);
    for (const m of groups) expect(codes(check([m.route])), `${m.perm} @${m.at}`).toContain('REQUIRED_MISSING');
    expect(found.filter((m) => m.kind === 'or-member→none')).toEqual([]);
  });

  it('B-05 人才候选编辑分支（update + 按钮 + 守卫）三项任删其一都被报出', () => {
    const key = 'GET /api/tenant/talent/candidates/owner-orgs';
    const mutants = requiredMutants(route(key), REQUIRED).filter((m) => m.kind === 'or-member→none');
    const perms = new Set(mutants.map((m) => m.perm));
    for (const perm of [
      'obj:TalentCenter.TalentCriterion:update',
      'btn:TalentCenter.TalentCriterion#update@detail',
      'guard:talent.queryObjectIsCriterion',
    ]) {
      expect(perms.has(perm), perm).toBe(true);
    }
    for (const m of mutants) expect(codes(check([m.route])), `${m.perm} @${m.at}`).toContain('REQUIRED_MISSING');
  });
});
