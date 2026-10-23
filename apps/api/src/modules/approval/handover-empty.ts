/** F-316 / DEC-678：交接节点取人和空审批人三选一的唯一分支；旧定义保留 DEC-663 兜底链。 */
import type { Tx } from '@italent/db';
import {
  HANDOVER_NODE_KEYS,
  type Candidate,
  type CountersignApprovalNode,
  type ApproverExpression,
} from '@italent/domain';
import { resolveCandidates, resolveFallbackCandidates, type RoutingSubject } from './resolver.js';

export type ResolvedApprover = readonly [ApproverExpression, Candidate];
export type HandoverResolution =
  | { readonly kind: 'candidates'; readonly candidates: readonly ResolvedApprover[] }
  | { readonly kind: 'stop' }
  | { readonly kind: 'exception_admin' }
  | { readonly kind: 'auto_approve' };

export async function resolveHandoverApprovers(
  tx: Tx,
  subject: RoutingSubject,
  node: CountersignApprovalNode,
): Promise<HandoverResolution> {
  const policy = node.emptyApproverPolicy;
  const resolved: ResolvedApprover[] = [];
  for (const expression of node.approvers) {
    const list = await resolveCandidates(tx, subject, expression, policy === undefined ? node.fallbackUserIds : []);
    for (const candidate of list) resolved.push([expression, candidate]);
  }
  if (policy === undefined) return { kind: 'candidates', candidates: resolved };
  // 策略针对整个节点无人：已有主处理人时不追加兜底，也不为其他空表达式自动投票。
  const present = resolved.filter(([, candidate]) => candidate.userId !== null);
  if (present.length) return { kind: 'candidates', candidates: present };
  if (policy === 'specified') {
    const fallback = await resolveFallbackCandidates(tx, subject, node.fallbackUserIds ?? []);
    if (fallback.length)
      return { kind: 'candidates', candidates: fallback.map((candidate) => [node.approvers[0]!, candidate]) };
    return { kind: node.key === HANDOVER_NODE_KEYS.work ? 'stop' : 'exception_admin' };
  }
  return { kind: policy };
}
