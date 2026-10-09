/**
 * 声明 × 必需项显式表的硬比对（F-039 PR-A 第 4 轮，DEC-348②；规则编号见修法说明第三节与补充）。
 * 表只来自人工审定（required/），探测器只提供漏登线索（REQUIRED_TABLE_GAP），不决定哪些是披露。
 * - R1 准入义务：声明的每个准入备选都要有；“或”组：每个备选至少满足组内一个备选的全部义务（备选内 AND、备选间 OR）；
 * - D1～D3（PR-B1）可选分支只挂声明根、不嵌套、名字合 ^[A-Za-z][A-Za-z0-9]*$ → OPTIONAL_POSITION / NESTED / NAME；
 * - R2 准入义务出现在 optional 分支 X → 报错，除非表里同时有 disclosure:X 且权限同为该权限的义务（同权“准入 + 披露”复用，
 *   R1 仍要求它出现在每个准入备选里，删准入只留 optional 一定报 REQUIRED_MISSING）；
 * - R3 披露义务 disclosure:<键>：必须由名为 <键> 的 optional 分支的**每个**备选授予（DISCLOSURE_MISSING = 分支不存在或
 *   没有任何备选授予；DISCLOSURE_WEAK = 有备选不含该权限或范围不符）；
 * - B-03 义务的 `need` 与权限合并判定“成立”：存在提供该权限且范围满足 need 的来源节点（“或”组随所属组内备选参与）；
 *   R1c 含 ≥2 个承载节点的准入备选里的 obj: / admin: 准入义务必须写 need（NEED_UNBOUND）、R3c 披露义务必须写 need
 *   （DISCLOSURE_NEED_UNBOUND）、need.scope 不是 none 的义务必须有 role: scope 的证据（NEED_EVIDENCE_MISSING）；
 * - 守卫内部义务（purpose = guard:*）必须登记内部角色 inner（GUARD_ROLE_UNBOUND）；角色 or 要在 GUARD_INNER_ALTS 里登记
 *   对应备选（GUARD_INNER_ALT_UNREGISTERED）；
 * - R4 纯披露（该权限在本端点只有披露用途）出现在准入备选里 → 报错；同一权限另有准入 / 守卫内部 / 条件用途的复用不算；
 * - R5 / R6 守卫内部与条件准入：承载者（守卫 / 关系）本身须是准入义务；条件权限不得写成无条件准入；
 * - R7 optional 里的分支名或权限不在表里 → OPTIONAL_UNCLASSIFIED；准入里的权限不在表里 → ADMISSION_UNCLASSIFIED；
 * - R8 探测器的权限类原始事实没有被任何义务承接 → REQUIRED_TABLE_GAP；义务登记的事实探测器已观测不到 → REQUIRED_STALE_FACT。
 * 第二道比较（compare.ts）的输入经 admissionPrimitives 分流：只由非准入义务承接的事实不进准入比较；
 * 同一事实同时被准入义务承接时留在准入里（共享原语不被披露分流吞掉）。
 */
import type { ManifestRoute } from '@italent/api';
import type { Finding } from './compare.js';
import type { ObservedContract, ObservedRoute } from './contract.js';
import { branchPerms, declaredPerms, provides, type PermMap, type ScopeSig } from './perms.js';
import { GUARD_INNER_ALTS } from './required/guard-inner.js';
import type { Need, Obligation, RequiredTable } from './required/types.js';

/** 权限类原语维度：它们的每个原始事实都要有义务承接；其余维度（范围 / 字段 / 命令 / 前提 …）是元数据。 */
export const PERMISSION_DIMENSIONS: ReadonlySet<string> = new Set([
  'admin',
  'object',
  'button',
  'relation',
  'self',
  'own',
  'guard',
  'or',
  'objectOp',
]);

const isAdmission = (o: Obligation) => o.purpose === undefined;
const kindOf = (o: Obligation) => o.purpose?.split(':')[0] ?? 'admission';
const carrierOf = (o: Obligation) => o.purpose?.slice(o.purpose.indexOf(':') + 1) ?? '';

/** 基准里一条路由的全部原始事实（`维度:名字`）。 */
export function rawFacts(observed: ObservedRoute): string[] {
  return Object.entries(observed.primitives).flatMap(([dim, names]) => names.map((name) => `${dim}:${name}`));
}

/** 第二道比较的输入：去掉只由非准入义务承接的事实（披露 / 守卫内部 / 条件准入）。 */
export function admissionPrimitives(
  observed: ObservedRoute,
  obligations: readonly Obligation[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [dim, names] of Object.entries(observed.primitives)) {
    const kept = names.filter((name) => {
      const claimers = obligations.filter((o) => o.facts?.includes(`${dim}:${name}`));
      return !claimers.length || claimers.some(isAdmission);
    });
    if (kept.length) out[dim] = kept;
  }
  return out;
}

function union(maps: Iterable<PermMap>): Set<string> {
  return new Set([...maps].flatMap((map) => [...map.keys()]));
}

const sigText = (sig: ScopeSig) => (sig.name ? `${sig.mode}(${sig.name})` : sig.mode);
const needText = (need: Need | undefined) =>
  need ? sigText({ mode: need.scope, name: need.locator ?? need.predicate ?? need.guard }) : '任意';
const declaredText = (alt: PermMap, perm: string) =>
  [...new Set((alt.get(perm) ?? []).flatMap((source) => source.scopes.map(sigText)))].join('/') || '无';

/** 备选 alt 里义务 o 成立：有提供权限且范围满足 need 的来源节点。 */
const holds = (alt: PermMap, o: Obligation) => provides(alt, o.perm, o.need);

/** 不成立的原因：权限本身没有，或有权限但范围不符。 */
function whyNot(alt: PermMap, o: Obligation): string {
  if (!alt.has(o.perm)) return `缺必需 ${o.perm}`;
  return `${o.perm} 范围不符（需要 ${needText(o.need)}，声明 ${declaredText(alt, o.perm)}）`;
}

type Groups = Map<string, Map<string, Obligation[]>>;
function groupsOf(obligations: readonly Obligation[]): Groups {
  const groups: Groups = new Map();
  for (const o of obligations.filter((x) => x.or)) {
    const [group = '', alt = ''] = o.or!.split(':');
    const alts = groups.get(group) ?? new Map<string, Obligation[]>();
    alts.set(alt, [...(alts.get(alt) ?? []), o]);
    groups.set(group, alts);
  }
  return groups;
}

/** 备选 alt 里“或”组 group 成立的组内备选名（每个组内备选的全部义务都成立）。 */
export function satisfiedGroupAlts(alt: PermMap, alts: ReadonlyMap<string, readonly Obligation[]>): string[] {
  return [...alts].filter(([, os]) => os.every((o) => holds(alt, o))).map(([name]) => name);
}

const isCarrierPerm = (perm: string) => perm.startsWith('obj:') || perm.startsWith('admin:');

export function checkRoute(
  key: string,
  obligations: readonly Obligation[],
  route: ManifestRoute,
  observed: ObservedRoute | undefined,
): Finding[] {
  const findings: Finding[] = [];
  const report = (code: string, detail: string) => findings.push({ route: key, code, detail });
  const decl = declaredPerms(route.policy);
  const many = decl.alternatives.length > 1;
  const label = (i: number) => (many ? `备选 ${i + 1}/${decl.alternatives.length}：` : '');
  const admission = obligations.filter(isAdmission);
  const plain = admission.filter((o) => !o.or);
  const groups = groupsOf(admission);
  const byPerm = new Map<string, Obligation[]>();
  for (const o of obligations) byPerm.set(o.perm, [...(byPerm.get(o.perm) ?? []), o]);
  const admissionPerms = new Set(admission.map((o) => o.perm));

  // D1～D3：可选分支的位置 / 嵌套 / 名字（先于 R3）
  for (const v of decl.layout) report(v.code, `optional.${v.name}（${v.path}）`);
  // R1：每个准入备选都要满足全部准入义务（权限 + need）与每个“或”组
  decl.alternatives.forEach((alt, i) => {
    for (const o of plain) if (!holds(alt, o)) report('REQUIRED_MISSING', `${label(i)}${whyNot(alt, o)}`);
    for (const [group, alts] of groups) {
      if (satisfiedGroupAlts(alt, alts).length) continue;
      const want = [...alts].map(([name, os]) => `${name}=${os.map((o) => o.perm).join('+')}`).join(' 或 ');
      const scoped = [...alts.values()].flat().filter((o) => alt.has(o.perm) && !holds(alt, o));
      const why = scoped.length ? `；${scoped.map((o) => whyNot(alt, o)).join('；')}` : '';
      report('REQUIRED_MISSING', `${label(i)}不满足“或”组 ${group}（${want}）${why}`);
    }
  });
  // R1c：含 ≥2 个承载节点的准入备选，其 obj: / admin: 准入义务必须写 need
  const unbound = new Set<string>();
  for (const alt of decl.alternatives) {
    const carriers = new Set(
      [...alt]
        .flatMap(([perm, sources]) => (isCarrierPerm(perm) ? sources.filter((s) => s.carrier) : []))
        .map((s) => s.path),
    );
    if (carriers.size < 2) continue;
    for (const [perm, sources] of alt) {
      if (isCarrierPerm(perm) && sources.some((s) => s.carrier)) unbound.add(perm);
    }
  }
  for (const o of admission) {
    if (unbound.has(o.perm) && !o.need) report('NEED_UNBOUND', `${o.perm} 所在备选含多个承载节点，须登记 need`);
  }
  // R2：准入义务出现在 optional 分支 X，除非表里有同权的 disclosure:X
  for (const [name, branch] of decl.optional) {
    const reused = new Set(obligations.filter((o) => o.purpose === `disclosure:${name}`).map((o) => o.perm));
    for (const perm of branchPerms(branch)) {
      if (admissionPerms.has(perm) && !reused.has(perm)) {
        report('REQUIRED_IN_OPTIONAL', `必需 ${perm} 出现在 optional.${name}（表里没有同权的 disclosure:${name}）`);
      }
    }
  }
  // R3：披露义务由同名 optional 分支的每个备选授予（权限 + need）；R4：纯披露不得进准入
  const disclosures = obligations.filter((x) => kindOf(x) === 'disclosure');
  const named = (o: Obligation) => carrierOf(o);
  for (const o of disclosures.filter((x) => !x.or)) {
    const branch = decl.optional.get(named(o));
    if (!branch?.alternatives.some((alt) => alt.has(o.perm))) {
      report('DISCLOSURE_MISSING', `披露 ${named(o)} 没有 optional 分支授予 ${o.perm}`);
      continue;
    }
    branch.alternatives.forEach((alt, k) => {
      if (!holds(alt, o)) report('DISCLOSURE_WEAK', `披露 ${named(o)} 第 ${k + 1} 个备选：${whyNot(alt, o)}`);
    });
  }
  for (const [name, alts] of groupsOf(disclosures)) {
    const branchName = named([...alts.values()][0]![0]!);
    const branch = decl.optional.get(branchName);
    if (!branch) report('DISCLOSURE_MISSING', `披露 ${branchName}（组 ${name}）没有 optional 分支`);
    else
      branch.alternatives.forEach((alt, k) => {
        if (!satisfiedGroupAlts(alt, alts).length)
          report('DISCLOSURE_WEAK', `披露 ${branchName} 第 ${k + 1} 个备选不满足“或”组 ${name}`);
      });
  }
  const declaredAdmission = union(decl.alternatives);
  for (const [perm, uses] of byPerm) {
    if (!declaredAdmission.has(perm)) continue;
    if (uses.every((o) => kindOf(o) === 'disclosure')) report('DISCLOSURE_AS_ADMISSION', `纯披露 ${perm} 出现在准入`);
    if (!uses.some(isAdmission) && uses.some((o) => kindOf(o) === 'when')) {
      report('CONDITIONAL_AS_ADMISSION', `条件准入 ${perm} 被写成无条件准入`);
    }
  }
  // R3c：披露义务必须写 need
  for (const o of disclosures) {
    if (!o.need) report('DISCLOSURE_NEED_UNBOUND', `披露 ${named(o)} 的 ${o.perm} 须登记 need`);
  }
  // need.scope 不是 none 的义务必须有强制范围判定处的证据
  for (const o of obligations) {
    if (o.need && o.need.scope !== 'none' && !o.at.some((e) => e.role === 'scope')) {
      report('NEED_EVIDENCE_MISSING', `${o.perm} 的 need ${needText(o.need)} 缺 role: scope 证据`);
    }
  }
  // R5 / R6：承载者须是准入义务
  for (const o of obligations.filter((x) => kindOf(x) === 'guard' || kindOf(x) === 'when')) {
    const carrier = carrierOf(o);
    if (!admissionPerms.has(`guard:${carrier}`) && !admissionPerms.has(`rel:${carrier}`)) {
      report('TABLE_CARRIER_MISSING', `${o.perm} 的承载者 ${carrier} 不是本端点的准入义务`);
    }
  }
  // 守卫内部角色：必须登记；内部“或”要在 GUARD_INNER_ALTS 里有对应备选
  for (const o of obligations.filter((x) => kindOf(x) === 'guard')) {
    if (!o.inner) {
      report('GUARD_ROLE_UNBOUND', `${o.perm} 在 ${carrierOf(o)} 内部的角色未登记（required / or / when）`);
    } else if (o.inner.role === 'or') {
      const registered = GUARD_INNER_ALTS[carrierOf(o)];
      const alt = registered?.alts[o.inner.alt];
      const ok =
        registered?.group === o.inner.group && alt !== undefined && (typeof alt === 'string' || alt.includes(o.perm));
      if (!ok)
        report(
          'GUARD_INNER_ALT_UNREGISTERED',
          `${o.perm} 的内部备选 ${o.inner.group}:${o.inner.alt} 未在 GUARD_INNER_ALTS 登记`,
        );
    }
  }
  // R7：表外的权限
  for (const [name, branch] of decl.optional) {
    const allowed = new Set(obligations.filter((o) => o.purpose === `disclosure:${name}`).map((o) => o.perm));
    if (!allowed.size) report('OPTIONAL_UNCLASSIFIED', `optional.${name} 不是表里的披露用途`);
    else
      for (const perm of branchPerms(branch)) {
        if (!allowed.has(perm)) report('OPTIONAL_UNCLASSIFIED', `optional.${name} 授予表外的 ${perm}`);
      }
  }
  for (const perm of declaredAdmission) {
    if (!byPerm.has(perm)) report('ADMISSION_UNCLASSIFIED', `准入里的 ${perm} 不在表里`);
  }
  // R8：探测器事实与表的承接
  if (observed) {
    const facts = new Set(rawFacts(observed).map((f) => f));
    const claimed = new Set(obligations.flatMap((o) => o.facts ?? []));
    for (const fact of facts) {
      if (PERMISSION_DIMENSIONS.has(fact.split(':')[0]!) && !claimed.has(fact)) {
        report('REQUIRED_TABLE_GAP', `探测器事实 ${fact} 没有被任何义务承接（补登或标明用途）`);
      }
    }
    for (const fact of claimed) {
      if (!facts.has(fact)) report('REQUIRED_STALE_FACT', `义务登记的事实 ${fact} 探测器已观测不到`);
    }
  }
  return findings;
}

export function checkRequired(
  table: RequiredTable,
  contract: ObservedContract,
  routes: readonly ManifestRoute[],
): Finding[] {
  return routes.flatMap((route) => {
    const key = `${route.method} ${route.path}`;
    const obligations = table[key];
    if (!obligations) return [{ route: key, code: 'REQUIRED_ENTRY_MISSING', detail: '必需项表没有这条端点' }];
    return checkRoute(key, obligations, route, contract.routes[key]);
  });
}
