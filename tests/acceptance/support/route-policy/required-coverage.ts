/**
 * 突变覆盖断言的期望集合（F-039 PR-B1，B-05）：由显式表的义务与声明的准入备选**直接推导**，不读 requiredMutants 的输出。
 * 覆盖键 = 端点 | 权限 | 备选 i | 来源路径（“或”组整组失效：端点 | group:组名 | 备选 i）；
 * 每个键要有的突变类别见 expectedMutationKeys 的注释。比较时按“类别 + 键”核对，缺口逐条列出。
 */
import type { ManifestRoute } from '@italent/api';
import { declaredPerms, provides, type PermMap } from './perms.js';
import { OR_GROUP_KIND, type RequiredMutant } from './required-mutate.js';
import type { Obligation, RequiredTable } from './required/types.js';

const sources = (alt: PermMap, perm: string) =>
  alt
    .get(perm)!
    .map((s) => `${s.path}${s.field}`)
    .join(',');

/** 期望的 `类别|覆盖键` 集合。 */
export function expectedMutationKeys(route: ManifestRoute, table: RequiredTable): string[] {
  const key = `${route.method} ${route.path}`;
  const admission = (table[key] ?? []).filter((o) => o.purpose === undefined);
  const out: string[] = [];
  declaredPerms(route.policy).alternatives.forEach((alt, i) => {
    const cover = (o: Obligation) => `${key}|${o.perm}|${i + 1}|${sources(alt, o.perm)}`;
    // 无组准入义务：删除与移进 optional 各一
    for (const o of admission.filter((x) => !x.or && provides(alt, x.perm, x.need))) {
      out.push(`required→none|${cover(o)}`, `required→optional|${cover(o)}`);
    }
    // “或”组：求备选 i 里成立的组内备选集合 S
    const groups = new Map<string, Map<string, Obligation[]>>();
    for (const o of admission.filter((x) => x.or)) {
      const [group = '', name = ''] = o.or!.split(':');
      const alts = groups.get(group) ?? new Map<string, Obligation[]>();
      groups.set(group, alts.set(name, [...(alts.get(name) ?? []), o]));
    }
    for (const [group, alts] of groups) {
      const satisfied = [...alts.values()].filter((os) => os.every((o) => provides(alt, o.perm, o.need)));
      if (satisfied.length === 1) {
        // |S|=1：组内备选的每个权限都要有 or-member→none 与 required→optional
        for (const o of satisfied[0]!) out.push(`or-member→none|${cover(o)}`, `required→optional|${cover(o)}`);
      } else if (satisfied.length > 1) {
        out.push(`${OR_GROUP_KIND}|${key}|group:${group}|${i + 1}`);
      }
    }
  });
  return out;
}

/** 期望里没有对应突变的 `类别|覆盖键`。 */
export function missingCoverage(expected: readonly string[], mutants: readonly RequiredMutant[]): string[] {
  const actual = new Set(mutants.map((m) => `${m.kind}|${m.coverageKey}`));
  return [...new Set(expected)].filter((item) => !actual.has(item));
}
