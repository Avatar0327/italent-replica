import { normalizeUuid } from '@italent/domain';

export function approvalHref({
  tenantId,
  instanceId,
  businessId,
  tab,
}: {
  tenantId?: string;
  instanceId?: string;
  businessId?: string;
  tab?: 'pending' | 'processed' | 'initiated';
} = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries({ tenantId, instanceId, businessId })) {
    const normalized = value && normalizeUuid(value);
    if (normalized) query.set(key, normalized);
  }
  if (tab) query.set('tab', tab);
  return `/approvals${query.size ? `?${query}` : ''}`;
}
