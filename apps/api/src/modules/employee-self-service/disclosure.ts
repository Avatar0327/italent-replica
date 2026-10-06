import { withTenant } from '@italent/db';
import { EMPLOYMENT_OBJECT } from '../employment/context.js';
import { getModuleViewableFields } from '../permission/module-access.js';
import type { SelfAccess } from './access.js';
import { referenceLabels } from './references.js';

/** 本人任职字段与引用名称一起裁剪；只显示该任职已有的最小引用，不开放引用对象档案。 */
export async function discloseOwnRecord(
  self: SelfAccess,
  record: {
    fields: object;
    customFields?: object;
    effectiveDate: string;
    [key: string]: unknown;
  },
) {
  const visible = (await getModuleViewableFields(self.deps, self.ctx, EMPLOYMENT_OBJECT)) ?? new Set<string>();
  const fields = Object.fromEntries(Object.entries(record.fields).filter(([code]) => visible.has(code)));
  const labels = await withTenant(self.deps.db, self.ctx.tenantId, async (tx) => {
    await self.check(tx);
    return referenceLabels(tx, self.ctx, fields, record.effectiveDate);
  });
  return {
    ...Object.fromEntries(
      Object.entries(record).filter(([code]) => visible.has(code) && !['fields', 'customFields'].includes(code)),
    ),
    fields,
    fieldLabels: labels,
    customFields: Object.fromEntries(
      Object.entries(record.customFields ?? {}).filter(([id]) => visible.has(`custom:${id}`)),
    ),
  };
}
