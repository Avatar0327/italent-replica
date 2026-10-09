/**
 * 非法标识校验位置的证据（F-039 PR-B4a 第 2 轮，审查 #163 P2-4）：P3 的"占位请求与非法标识请求观测相同"既可能是
 * 两次失败在别处（请求体先于标识校验、令牌先于标识校验），也可能是标识校验确实先失败、占位请求随后因对象不存在或
 * 请求体为空得到同一状态码。仅凭观测相同无法区分，所以由审定过的证据说明"本端点的标识校验在哪里"：
 * 有证据的端点 P3 适用；没有证据且观测相同的（如请求体先于标识校验的 9 个端点）保持未达。
 * 数据 baseline/probe-id-evidence.json：端点 → 标识校验调用点（文件 + 原文片段），锚点变化要求复核。
 */
import type { Finding } from './compare.js';
import { containsAnchor, repoSource, type SourceReader } from './evidence.js';
import { baselineJson, type EvidenceRef } from './probe-known-gaps.js';

export const ID_CHECK_EVIDENCE: Readonly<Record<string, EvidenceRef>> = baselineJson('probe-id-evidence.json');

export function checkIdCheckEvidence(
  evidence: Readonly<Record<string, EvidenceRef>> = ID_CHECK_EVIDENCE,
  read: SourceReader = repoSource,
): Finding[] {
  return Object.entries(evidence).flatMap(([endpoint, { file, anchor }]) => {
    let found = false;
    try {
      found = containsAnchor(read(file), anchor);
    } catch {
      found = false;
    }
    return found
      ? []
      : [{ route: endpoint, code: 'PROBE_ID_EVIDENCE_STALE', detail: `${file} 里找不到标识校验锚点：${anchor}` }];
  });
}
