import {
  APPROVAL_TYPES,
  expressionValue,
  HANDOVER_FALLBACK_APPROVERS,
  HANDOVER_FALLBACK_LIMIT,
  type ApprovalNode,
} from '@italent/domain';
import { m } from './messages.js';

export function supportsFallback(node: ApprovalNode, approvalType?: string): boolean {
  return (
    APPROVAL_TYPES[approvalType as keyof typeof APPROVAL_TYPES]?.adapter === 'exit_handover' &&
    node.kind === 'countersign' &&
    Array.isArray(node.approvers) &&
    node.approvers.some((source) => {
      const value = expressionValue(source);
      return value !== null && HANDOVER_FALLBACK_APPROVERS.has(value);
    })
  );
}
export function fallbackError(value: unknown): string | undefined {
  if (
    !Array.isArray(value) ||
    value.some(
      (id) => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
    )
  )
    return m.fallbackInvalid;
  if (value.length > HANDOVER_FALLBACK_LIMIT) return m.fallbackLimit(HANDOVER_FALLBACK_LIMIT);
  if (new Set(value.map((id: string) => id.toLowerCase())).size !== value.length) return m.fallbackDuplicate;
  return undefined;
}
