import { registrationGate, registrationDrift, registration } from '../registration.js';
import { checkRequired } from '../required.js';
import { expect } from 'vitest';
import { type Finding } from '../compare.js';
import { declaredPerms, OPTIONAL_NAME_PATTERN } from '../perms.js';
import { type Obligation, type RequiredTable } from '../required/types.js';
import { type ManifestRoute } from '@italent/api';
import { DETECTOR_REQUIRED, DETECTOR_CONTRACT, DETECTOR_SEMANTICS } from '../detector-fixtures.js';
import { GUARD_INNER_ALTS } from '../required/guard-inner.js';
import { checkStored } from '../evidence.js';
import { expectDeclared, multiCarrierRoutes } from '../module-declared.js';
import type { LocalCheckContext } from './types.js';

// F-095：原局部用例与入口专项共用实际断言；登记副本从 context.table 注入。
export function disclosureChecks(context: LocalCheckContext) {
  const REQUIRED = context.table;
  const manifest = { declared: context.routes };
  const frozen = context.contract;

  const MANAGER = 'GET /api/tenant/employment/transfers/manager';
  const GOALS = 'POST /api/tenant/idp/plans/:id/goals';
  const APPROVAL_PROCESSES = 'GET /api/tenant/idp/approval-processes';
  function route(key: string): ManifestRoute {
    const found = manifest.declared.find((r) => `${r.method} ${r.path}` === key);
    if (!found) throw new Error(`没有声明 ${key}`);
    return found;
  }
  const codes = (findings: readonly Finding[]) => findings.map((f) => f.code);
  const show = (findings: readonly Finding[]) => findings.map((f) => `${f.route} ${f.code}: ${f.detail}`).join('\n');
  const check = (routes: readonly ManifestRoute[], table: RequiredTable = DETECTOR_REQUIRED) =>
    checkRequired(table, DETECTOR_CONTRACT, routes, DETECTOR_SEMANTICS);
  const entry = (key: string): readonly Obligation[] => {
    const found = DETECTOR_REQUIRED[key];
    if (!found) throw new Error(`表里没有 ${key}`);
    return found;
  };
  const withEntry = (key: string, obligations: readonly Obligation[]): RequiredTable => ({
    ...DETECTOR_REQUIRED,
    [key]: obligations,
  });
  const isDisclosure = (o: Obligation) => o.purpose?.startsWith('disclosure:') ?? false;
  const disclosureBranches = () =>
    Object.entries(REQUIRED).flatMap(([key, os]) => [
      ...new Set(os.filter(isDisclosure).map((o) => `${key}|${o.purpose}`)),
    ]);
  return [
    {
      id: 'layout',
      label: '真实声明 × 真实表零发现；披露位置全部挂在根节点，名字合 D3，数量等于表里的披露分支数',
      wrapped: false,
      verify: () => {
        const findings = registrationGate(
          checkRequired(REQUIRED, frozen, manifest.declared),
          '真实声明 × 披露义务登记（DEC-416③）',
        );
        expect(findings, show(findings)).toEqual([]);
        const branches = manifest.declared.flatMap((r) => [...declaredPerms(r.policy).optional]);
        const drift = [];
        if (branches.length !== disclosureBranches().length) drift.push('声明披露分支数与义务登记不同');
        if (branches.length < 33) drift.push('披露分支数少于冻结下限 33');
        expect(registrationDrift('披露分支静态登记', drift)).toEqual([]);
        for (const [name, branch] of branches) {
          expect(OPTIONAL_NAME_PATTERN.test(name), name).toBe(true);
          expect(branch.path, name).toBe(`optional.${name}.`);
        }
        expect(manifest.declared.flatMap((r) => declaredPerms(r.policy).layout)).toEqual([]);
      },
    },
    {
      id: 'approvalProcesses',
      label: 'GET /idp/approval-processes（view AND (create OR update)）：need 随所属组内备选参与“或”，零发现',
      wrapped: false,
      verify: () => {
        expect(
          registrationGate(checkRequired(REQUIRED, frozen, [route(APPROVAL_PROCESSES)]), 'IDP 审批流程静态登记'),
        ).toEqual([]);
        expect(check([route(APPROVAL_PROCESSES)])).toEqual([]);
        const needs = (REQUIRED[APPROVAL_PROCESSES] ?? []).map((o) => o.need);
        registration('IDP 审批流程 need 登记', () => expect(needs.every((n) => n !== undefined)).toBe(true));
      },
    },
    {
      id: 'admissionNeed',
      label:
        'R1c：含 ≥2 个承载节点的准入备选，其 obj: / admin: 准入义务缺 need → NEED_UNBOUND（端点集合按模块声明，DEC-475④）',
      wrapped: false,
      verify: () => {
        const stripped: RequiredTable = Object.fromEntries(
          Object.entries(REQUIRED).map(([key, os]) => [key, os.map(({ need: _need, ...rest }) => rest as Obligation)]),
        );
        const unbound = check(manifest.declared, stripped).filter((f) => f.code === 'NEED_UNBOUND');
        const multi = multiCarrierRoutes(manifest.declared);
        registration('多个准入承载节点的按模块声明', () =>
          expectDeclared(
            '含 ≥2 个准入承载节点的端点',
            'multiCarrierAdmission',
            multi.map((r) => `${r.method} ${r.path}`),
          ),
        );
        // 对每个实际进入反例的完整表项验证检测器；未登记的端点由真实总入口报告，不能混入这个反例的 oracle。
        const registered = multi.filter((r) => REQUIRED[`${r.method} ${r.path}`]);
        expect(new Set(unbound.map((f) => f.route))).toEqual(new Set(registered.map((r) => `${r.method} ${r.path}`)));
      },
    },
    {
      id: 'disclosureNeed',
      label: 'R3c：披露义务缺 need → DISCLOSURE_NEED_UNBOUND（每条披露义务一条）',
      wrapped: false,
      verify: () => {
        const base = route(MANAGER);
        const table = withEntry(
          MANAGER,
          entry(MANAGER).map(({ need: _need, ...rest }) => rest as Obligation),
        );
        const found = check([base], table).filter((f) => f.code === 'DISCLOSURE_NEED_UNBOUND');
        expect(found).toHaveLength(entry(MANAGER).filter(isDisclosure).length);
        const all = Object.values(REQUIRED).flat().filter(isDisclosure);
        registration('全表披露 need 完整性', () => expect(all.every((o) => o.need !== undefined)).toBe(true));
      },
    },
    {
      id: 'scopeEvidence',
      label: 'NEED_EVIDENCE_MISSING：need.scope 不是 none 的义务必须有 role: scope 的证据',
      wrapped: false,
      verify: () => {
        const scoped = Object.entries(REQUIRED).filter(([, os]) => os.some((o) => o.need && o.need.scope !== 'none'));
        expect(scoped.length).toBeGreaterThan(0);
        for (const [key, os] of scoped) {
          const noEvidence = os.map((o) => ({ ...o, at: o.at.filter((e) => e.role !== 'scope') }));
          const found = check([route(key)], withEntry(key, noEvidence)).filter(
            (f) => f.code === 'NEED_EVIDENCE_MISSING',
          );
          expect(found.length, key).toBeGreaterThan(0);
        }
        const findings = checkRequired(REQUIRED, frozen, manifest.declared).filter(
          (f) => f.code === 'NEED_EVIDENCE_MISSING',
        );
        expect(registrationGate(findings, '范围义务静态证据登记（DEC-416③）')).toEqual([]);
      },
    },
    {
      id: 'guardRoles',
      label: '现表全部守卫内部义务（PR-A 台账 45 条 + 任职资格 18 条）都登记 inner；角色只取 required / or / when',
      wrapped: false,
      verify: () => {
        const guards = Object.entries(REQUIRED).flatMap(([key, os]) =>
          os.filter((o) => o.purpose?.startsWith('guard:')).map((o) => [key, o] as const),
        );

        registration('守卫内部义务静态数量', () => expect(guards.length).toBeGreaterThanOrEqual(45));
        for (const [key, o] of guards) {
          registration(`${key} ${o.perm} 内部角色`, () =>
            expect(['required', 'or', 'when'], `${key} ${o.perm}`).toContain(o.inner?.role),
          );
        }
      },
    },
    {
      id: 'executorAlternatives',
      label: 'idp.executor 的内部“或”：HR（权限）或参与人（数据态，不经授权器），带证据',
      wrapped: false,
      verify: () => {
        const executor = GUARD_INNER_ALTS['idp.executor'];
        registration('idp.executor 内部备选登记', () => expect(executor).toBeDefined());
        registration('idp.executor 内部备选集合', () =>
          expect(Object.keys(executor?.alts ?? {}).sort()).toEqual(['hr', 'participant']),
        );
        registration('idp.executor HR 备选', () => expect(executor?.alts['hr']).toEqual(['obj:IDP.Idp:view']));
        registration('idp.executor 参与人备选', () =>
          expect(executor?.alts['participant']).toBe('data:idp.planParticipant'),
        );
        const synthetic: RequiredTable = Object.fromEntries(
          Object.entries(GUARD_INNER_ALTS).map(([carrier, registered]) => [
            `inner ${carrier}`,
            [{ perm: `guard:${carrier}`, at: registered.at }],
          ]),
        );
        const found = registrationGate(checkStored(synthetic), '守卫内部备选证据');
        expect(found, show(found)).toEqual([]);
      },
    },
    {
      id: 'executorRole',
      label: 'idp.executor 的 9 个执行入口内部角色为 or（hr 备选）；登记错了备选名 → GUARD_INNER_ALT_UNREGISTERED',
      wrapped: false,
      verify: () => {
        const inner = (REQUIRED[GOALS] ?? []).find((o) => o.purpose === 'guard:idp.executor')?.inner;
        registration('IDP 执行入口内部角色', () => expect(inner).toEqual({ role: 'or', group: 'executor', alt: 'hr' }));
        const wrong = entry(GOALS).map((o) =>
          o.purpose === 'guard:idp.executor'
            ? { ...o, inner: { role: 'or' as const, group: 'executor', alt: 'x' } }
            : o,
        );
        expect(codes(check([route(GOALS)], withEntry(GOALS, wrong)))).toContain('GUARD_INNER_ALT_UNREGISTERED');
      },
    },
  ];
}
