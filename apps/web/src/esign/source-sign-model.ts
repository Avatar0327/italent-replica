import type { ESignSourceKind } from '@italent/domain';
import { ApiError } from '../foundation/client.js';
import { m } from './messages.js';
import { parseTemplateOptions } from './TemplatePicker.js';
import { statusText } from './sign-model.js';

export type SignSource = Readonly<{ kind: ESignSourceKind; id: string }>;
export type SourceSignReceipt = Readonly<{ sourceId: string; taskId: string }>;
const paths: Record<ESignSourceKind, string> = {
  offer: '/api/tenant/offers',
  entry: '/api/tenant/employment/pending-entries',
};
export const sourceSignPath = ({ kind, id }: SignSource) => `${paths[kind]}/${encodeURIComponent(id)}`;
export const SOURCE_TEMPLATE_LIMIT = 20;

export function parseSourceSignContext(raw: unknown, source: SignSource) {
  const context = raw as { sourceId?: unknown; revision?: number; canInitiate?: unknown; reason?: unknown } | null;
  if (
    context?.sourceId !== source.id ||
    !Number.isSafeInteger(context.revision) ||
    context.revision! <= 0 ||
    typeof context.canInitiate !== 'boolean'
  )
    throw new Error(m.source.invalidContext);
  return {
    revision: context.revision!,
    canInitiate: context.canInitiate,
    reason: context.reason === 'ESIGN_OWNER_UNAVAILABLE' ? m.source.unlinked : m.source.unavailable,
    items: parseTemplateOptions(raw),
  };
}

/** POST 与 F-553 回查均返回固定回执；来源不符或无任务 ID 仍属结果未知。 */
export function parseSourceSignReceipt(raw: unknown, source: SignSource): SourceSignReceipt {
  const receipt = raw as Partial<SourceSignReceipt> | null;
  if (
    receipt?.sourceId !== source.id ||
    typeof receipt.taskId !== 'string' ||
    !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(receipt.taskId)
  )
    throw new Error(m.source.invalidReceipt);
  return { sourceId: receipt.sourceId, taskId: receipt.taskId };
}

export const unreadable = (error: unknown) => error instanceof ApiError && [401, 403, 404].includes(error.status);
export const sourceStatus = (status: unknown, node: unknown) =>
  status === 'signing' && node === 'employee' ? m.source.signingEmployee : statusText(status, node);

export const sourceSignKey = (
  session: { tenantId: string; userId?: string; identityKey: string },
  source: SignSource,
) => JSON.stringify([session.tenantId, session.userId, session.identityKey, source.kind, source.id]);
