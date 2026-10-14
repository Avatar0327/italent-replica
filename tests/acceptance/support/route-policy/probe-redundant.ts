/**
 * 冗余观测记录（F-039 PR-B4a 第 2 轮，DEC-367 选 C）：处理函数实际问了授权器、但答案不影响该端点放行 / 披露 /
 * 范围结果的请求（41 项，审查 #163 第 1 轮附录 A 逐类读源码核对）。规则：
 *   - 精确到"端点 × 请求键"，每组带调用证据与"为何答案不影响该端点结果"；
 *   - **只做记录**：不是准入 / 披露义务，不进显式表，也不用来豁免有实际用途的 P0 漏登——那些在 probe-known-gaps；
 *   - 比较器做精确集合核对（多一条、少一条都报，防替换），与已知缺口分开存放、互斥；
 *   - 去掉生产代码里的冗余授权调用属运行时变化，另开 F 任务（开工前列清单交用户确认），不在 PR-B。
 */
import type { Finding } from './compare.js';
import type { SourceReader } from './evidence.js';
import { baselineJson, checkEvidenceRefs, type EvidenceRef } from './probe-known-gaps.js';

export interface RedundantGroup {
  readonly id: string;
  /** 为何答案不影响该端点结果。 */
  readonly why: string;
  readonly evidence: readonly EvidenceRef[];
  readonly pairs: readonly (readonly [string, string])[];
}

export const REDUNDANT_OBSERVATIONS: readonly RedundantGroup[] = baselineJson('probe-redundant-observations.json');

export const checkRedundantEvidence = (groups: readonly RedundantGroup[], read?: SourceReader): Finding[] =>
  checkEvidenceRefs(groups, 'PROBE_REDUNDANT_EVIDENCE', read);
