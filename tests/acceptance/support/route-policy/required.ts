/**
 * 声明 × 必需项显式表的硬比对（F-039 PR-A 第 4 轮，DEC-348②；规则编号见修法说明第三节与补充）。
 * 表只来自人工审定（required/），探测器只提供漏登线索（REQUIRED_TABLE_GAP），不决定哪些是披露。
 * - R1 准入义务：声明的每个准入备选都要有；“或”组：每个备选至少满足组内一个备选的全部义务（备选内 AND、备选间 OR）；
 * - R2 准入义务出现在任何 optional 分支 → 直接报错（不看准入里是否也有）；
 * - R3 披露义务 disclosure:<键>：必须由名为 <键> 的 optional 分支授予（独立存在性检查）；
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
import { declaredPerms, type PermMap } from './perms.js';
import type { Obligation, RequiredTable } from './required/types.js';

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
  const groups = new Map<string, Map<string, Set<string>>>();
  for (const o of admission.filter((x) => x.or)) {
    const [group = '', alt = ''] = o.or!.split(':');
    const alts = groups.get(group) ?? new Map<string, Set<string>>();
    alts.set(alt, (alts.get(alt) ?? new Set()).add(o.perm));
    groups.set(group, alts);
  }
  const byPerm = new Map<string, Obligation[]>();
  for (const o of obligations) byPerm.set(o.perm, [...(byPerm.get(o.perm) ?? []), o]);
  const admissionPerms = new Set(admission.map((o) => o.perm));

  // R1：每个准入备选都要满足全部准入义务与每个“或”组
  decl.alternatives.forEach((alt, i) => {
    for (const o of plain) if (!alt.has(o.perm)) report('REQUIRED_MISSING', `${label(i)}缺必需 ${o.perm}`);
    for (const [group, alts] of groups) {
      if ([...alts.values()].some((perms) => [...perms].every((p) => alt.has(p)))) continue;
      const want = [...alts].map(([name, perms]) => `${name}=${[...perms].join('+')}`).join(' 或 ');
      report('REQUIRED_MISSING', `${label(i)}不满足“或”组 ${group}（${want}）`);
    }
  });
  // R2：准入义务不得出现在 optional
  const optionalPerms = union(decl.optional.values());
  for (const perm of admissionPerms) {
    if (optionalPerms.has(perm)) report('REQUIRED_IN_OPTIONAL', `必需 ${perm} 出现在 optional`);
  }
  // R3 / R4：披露义务由同名 optional 授予；纯披露不得进准入
  for (const o of obligations.filter((x) => kindOf(x) === 'disclosure')) {
    const branch = decl.optional.get(carrierOf(o));
    if (!branch?.has(o.perm)) report('DISCLOSURE_MISSING', `披露 ${carrierOf(o)} 没有 optional 分支授予 ${o.perm}`);
  }
  const declaredAdmission = union(decl.alternatives);
  for (const [perm, uses] of byPerm) {
    if (!declaredAdmission.has(perm)) continue;
    if (uses.every((o) => kindOf(o) === 'disclosure')) report('DISCLOSURE_AS_ADMISSION', `纯披露 ${perm} 出现在准入`);
    if (!uses.some(isAdmission) && uses.some((o) => kindOf(o) === 'when')) {
      report('CONDITIONAL_AS_ADMISSION', `条件准入 ${perm} 被写成无条件准入`);
    }
  }
  // R5 / R6：承载者须是准入义务
  for (const o of obligations.filter((x) => kindOf(x) === 'guard' || kindOf(x) === 'when')) {
    const carrier = carrierOf(o);
    if (!admissionPerms.has(`guard:${carrier}`) && !admissionPerms.has(`rel:${carrier}`)) {
      report('TABLE_CARRIER_MISSING', `${o.perm} 的承载者 ${carrier} 不是本端点的准入义务`);
    }
  }
  // R7：表外的权限
  for (const [name, branch] of decl.optional) {
    const allowed = new Set(obligations.filter((o) => o.purpose === `disclosure:${name}`).map((o) => o.perm));
    if (!allowed.size) report('OPTIONAL_UNCLASSIFIED', `optional.${name} 不是表里的披露用途`);
    else
      for (const perm of branch.keys()) {
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
