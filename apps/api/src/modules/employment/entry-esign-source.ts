import type { Tx } from '@italent/db';
import { ENTRY_STATUS, tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import type { CommandResultDeps } from '../command-result/registry.js';
import { requireEntrySignSource } from '../esign/source-command-result.js';
import { sourceTemplateOptions } from '../esign/source-templates.js';
import { ENTRY_KINDS, isPendingEntryRecord } from './employee-status.js';
import { entryOfferHooks } from './entry-offer-hooks.js';
import { loadEmploymentRecord } from './read-model.js';
import { lockEmploymentBusiness, lockEmploymentEmployee } from './record-store.js';
import type { EmploymentContext, EmploymentRecord } from './types.js';

export const missingEntrySignSource = () => new AppError('NOT_FOUND', '入职记录不存在');

export async function authorizeEntrySignSource(tx: Tx, deps: CommandResultDeps, ctx: TenantContext, id: string) {
  try {
    await requireEntrySignSource(tx, deps, ctx, id);
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') throw missingEntrySignSource();
    throw error;
  }
}

function entrySignReason(record: EmploymentRecord) {
  if (!isPendingEntryRecord(record)) return 'NOT_PENDING_ENTRY';
  if (record.entryStatus === ENTRY_STATUS.cancelled) return 'ENTRY_CANCELLED';
  return undefined;
}

async function loadSourceRecord(tx: Tx, ctx: EmploymentContext, id: string) {
  const record = await loadEmploymentRecord(tx, ctx.tenantId, id, tenantLocalDate(ctx.now, ctx.timezone));
  if (!record || !ENTRY_KINDS.includes(record.kind)) throw missingEntrySignSource();
  return record;
}

export async function entrySignContext(tx: Tx, deps: CommandResultDeps, ctx: EmploymentContext, id: string) {
  await authorizeEntrySignSource(tx, deps, ctx, id);
  const record = await loadSourceRecord(tx, ctx, id);
  const reason = entrySignReason(record);
  const { items } = reason ? { items: [] } : await sourceTemplateOptions(tx, ctx.tenantId);
  return { sourceId: id, revision: record.revision, canInitiate: !reason, ...(reason ? { reason } : {}), items };
}

/** F-505 §5：与 Offer 入站、取消、改期使用相同锁序；等锁期间来源可能已被替换。 */
export async function lockEntrySignSource(tx: Tx, deps: CommandResultDeps, ctx: EmploymentContext, id: string) {
  await entryOfferHooks.beforeAction(tx, ctx, { businessId: id });
  const before = await loadSourceRecord(tx, ctx, id);
  await lockEmploymentEmployee(tx, ctx, before.employeeId);
  await authorizeEntrySignSource(tx, deps, ctx, id);
  const business = await lockEmploymentBusiness(tx, ctx, id);
  const record = await loadSourceRecord(tx, ctx, id);
  const reason = entrySignReason(record);
  if (business.state !== 'effective' || reason)
    throw new AppError('CONFLICT', '此入职记录不可发起签署', { reason: reason ?? 'NOT_PENDING_ENTRY' });
  return {
    employeeId: business.employeeId,
    ownerDepartmentId: record.fields.departmentId,
    revision: business.revision,
  };
}
