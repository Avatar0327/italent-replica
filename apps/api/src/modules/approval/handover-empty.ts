import { resolveSource } from './source-resolver.js';
/** F-316 / DEC-678：交接节点取人和空审批人三选一的唯一分支；旧定义保留 DEC-663 兜底链。 */
import type { Tx } from '@italent/db';
import {
  HANDOVER_NODE_KEYS,
  HANDOVER_FALLBACK_APPROVERS,
  type Candidate,
  type CountersignApprovalNode,
  type ApproverSource,
  expressionValue,
} from '@italent/domain';
import { resolveFallbackCandidates, type RoutingSubject } from './resolver.js';

export type ResolvedApprover = readonly [ApproverSource, Candidate];
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
  const resolved: ResolvedApprover[] = [];
  for (const expression of node.approvers) {
    const list = await resolveSource(tx, subject, expression);
    for (const candidate of list) resolved.push([expression, candidate]);
  }
  const specified: ResolvedApprover[] = [];
  if (node.emptyApproverPolicy === 'specified' && !resolved.some(([, c]) => c.userId)) {
    for (const source of node.emptyApproverSources ?? [])
      for (const candidate of await resolveSource(tx, subject, source)) specified.push([source, candidate]);
  }
  const fallback = resolved.some(([, candidate]) => candidate.userId === null)
    ? await resolveFallbackCandidates(tx, subject, node.fallbackUserIds ?? [])
    : [];
  return decideHandoverApprovers(node, resolved, fallback, specified);
}

/** 运行与仿真共用的纯判定：运行传入资格过滤后的候选，仿真只传虚拟关系与配置中的账号。 */
export function decideHandoverApprovers(
  node: CountersignApprovalNode,
  resolved: readonly ResolvedApprover[],
  fallback: readonly Candidate[],
  specified: readonly ResolvedApprover[] = [],
): HandoverResolution {
  const policy = node.emptyApproverPolicy;
  if (policy === undefined) {
    // DEC-663 未配置策略时，只有交接表达式逐项使用兜底名单。
    const candidates = resolved.flatMap(([expression, candidate]): ResolvedApprover[] =>
      candidate.userId === null && HANDOVER_FALLBACK_APPROVERS.has(expressionValue(expression)!) && fallback.length
        ? fallback.map((person) => [expression, person])
        : [[expression, candidate]],
    );
    return { kind: 'candidates', candidates };
  }
  // 策略针对整个节点无人：已有主处理人时不追加兜底，也不为其他空表达式自动投票。
  const present = resolved.filter(([, candidate]) => candidate.userId !== null);
  if (present.length) return { kind: 'candidates', candidates: present };
  if (policy === 'specified') {
    const people = specified.filter(([, candidate]) => candidate.userId !== null);
    if (people.length) return { kind: 'candidates', candidates: people };
    return { kind: node.key === HANDOVER_NODE_KEYS.work ? 'stop' : 'exception_admin' };
  }
  return { kind: policy };
}
