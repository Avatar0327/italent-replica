/** F-481 §3.1 / §4.2：同租户模板校验与联动详情投影，不要求模板维护权限。 */
import { and, eq, inArray, esignTemplates, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';

export async function selectedTemplates(tx: Tx, tenantId: string, ids: readonly string[]) {
  if (!ids.length) return [];
  return tx
    .select()
    .from(esignTemplates)
    .where(and(eq(esignTemplates.tenantId, tenantId), inArray(esignTemplates.id, [...ids])));
}

export async function validateSignTemplates(tx: Tx, tenantId: string, ids: readonly string[]) {
  const rows = await selectedTemplates(tx, tenantId, ids);
  const unavailable = ids.filter((id) => !rows.some((row) => row.id === id && row.status === 'enabled'));
  if (unavailable.length)
    throw new AppError('VALIDATION_FAILED', '签署模板不可用', {
      reason: 'ESIGN_TEMPLATE_UNAVAILABLE',
      templateIds: unavailable,
    });
}

export async function signTemplateView(tx: Tx, tenantId: string, ids: readonly string[]) {
  const rows = await selectedTemplates(tx, tenantId, ids);
  return ids.map((id) => {
    const row = rows.find((item) => item.id === id);
    return { id, name: row?.name ?? null, available: row?.status === 'enabled' };
  });
}
