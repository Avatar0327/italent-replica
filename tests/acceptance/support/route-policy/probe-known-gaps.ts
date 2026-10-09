/**
 * 发现探测 P0 的"已知漏登"台账（F-039 PR-B4a 第 2 轮，审查 #163 P2-3；DEC-303 / DEC-367）。
 * 全允许探测在真实声明 + 显式表上发现的**有实际授权用途**的未认领请求（91 项）：它们的表 / 声明修补归别的 PR
 * （IDP 归 B3；依赖 B1 承载者语义的等 B1；其余转 F），按"只改本 PR 文件"不在这里改表，改为逐对精确登记：
 *   - 登记的是**精确的"端点 × 请求键"集合**，每组带用途、归属、源码证据（审查者逐类读源码审定）；
 *   - 检查器核对精确集合：登记对不再未认领（表已补）→ PROBE_KNOWN_GAP_STALE，必须同 PR 删对；
 *     未认领的对不在登记里 → 照常 PROBE_ADMISSION_UNCLAIMED。所以"补一处、误删另一处"两边都会报；
 *   - 数据在 baseline/probe-known-gaps.json，只能减不能增（B-11 削减登记接手）；
 *   - 41 项冗余预取（答案不影响端点结果）另存 probe-redundant.ts，两者互斥、分别核对。
 * 这不是 DEC-303 取消的 PENDING_B：它不豁免声明缺失，也不是模块级宽匹配。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Finding } from './compare.js';
import { containsAnchor, repoSource, type SourceReader } from './evidence.js';

export interface EvidenceRef {
  /** 仓库相对路径。 */
  readonly file: string;
  /** 调用点原文片段（按词法记号比较，空白与注释不计）。 */
  readonly anchor: string;
}

export interface KnownGapGroup {
  readonly id: string;
  /** 这组请求的实际授权用途（审查分类）。 */
  readonly purpose: string;
  /** 修补归属与退出条件。 */
  readonly owner: string;
  readonly evidence: readonly EvidenceRef[];
  /** [端点 `METHOD 最终路径`, 请求键]。 */
  readonly pairs: readonly (readonly [string, string])[];
}

export const baselineJson = <T>(name: string): T =>
  JSON.parse(
    readFileSync(path.resolve(process.cwd(), 'tests/acceptance/support/route-policy/baseline', name), 'utf8'),
  ) as T;

export const KNOWN_GAPS: readonly KnownGapGroup[] = baselineJson('probe-known-gaps.json');

/** 证据锚点仍出现在所指文件里（调用点被改会要求复核）。 */
export function checkEvidenceRefs(
  groups: readonly { readonly id: string; readonly evidence: readonly EvidenceRef[] }[],
  code: string,
  read: SourceReader = repoSource,
): Finding[] {
  const findings: Finding[] = [];
  for (const group of groups) {
    for (const { file, anchor } of group.evidence) {
      let found = false;
      try {
        found = containsAnchor(read(file), anchor);
      } catch {
        found = false;
      }
      if (!found) findings.push({ route: group.id, code, detail: `${file} 里找不到证据锚点：${anchor}` });
    }
  }
  return findings;
}

export const checkKnownGapEvidence = (groups: readonly KnownGapGroup[], read?: SourceReader) =>
  checkEvidenceRefs(groups, 'PROBE_KNOWN_GAP_EVIDENCE', read);
