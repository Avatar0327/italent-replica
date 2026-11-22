import {
  and,
  employmentBusinessObjects,
  eq,
  onboardingEntryCases,
  type OnboardingEntryCase,
  type Tx,
} from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import {
  registerEntryLifecyclePort,
  type EntryLifecycleChange,
  type EntryLifecycleContext,
  type EntryLifecyclePort,
} from '../employment/onboarding-entry-port.js';

import { generateMaterialList } from './material-list.js';

const cases = onboardingEntryCases;
const businesses = employmentBusinessObjects;

function unavailable(): never {
  throw new AppError('CONFLICT', '待入职阶段关联已失效，请刷新后重提', { reason: 'ENTRY_CASE_NOT_CURRENT' });
}

function assertCaseRevision(expected: number, actual: number): void {
  if (expected !== actual) throw new AppError('REVISION_CONFLICT', '待入职资料已变更，请刷新后重提');
}

async function currentForUpdate(
  tx: Tx,
  ctx: EntryLifecycleContext,
  entry: { readonly employeeId: string; readonly businessId: string },
): Promise<OnboardingEntryCase> {
  const [current] = await tx
    .select()
    .from(cases)
    .where(
      and(
        eq(cases.tenantId, ctx.tenantId),
        eq(cases.employeeId, entry.employeeId),
        eq(cases.currentBusinessId, entry.businessId),
      ),
    )
    .for('update');
  return current ?? unavailable();
}

async function auditCase(
  tx: Tx,
  ctx: EntryLifecycleContext,
  action: string,
  before: OnboardingEntryCase | null,
  after: OnboardingEntryCase,
) {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    action: `onboarding.entry_case.${action}`,
    objectType: 'onboarding-entry-case',
    objectId: after.id,
    before,
    after,
    scope: { employeeId: after.employeeId },
    occurredAt: ctx.now,
    commandId: ctx.commandId,
  });
}

function lifecyclePatch(
  ctx: EntryLifecycleContext,
  current: OnboardingEntryCase,
  change: EntryLifecycleChange,
): Partial<typeof cases.$inferInsert> {
  if (current.state === 'hired' || current.state === 'deleted') return unavailable();
  switch (change.kind) {
    case 'replace':
      if (
        [current.rootBusinessId, current.currentBusinessId].includes(change.replacementBusinessId) ||
        (change.intent === 'restore' && current.state !== 'cancelled')
      )
        return unavailable();
      return {
        state: change.intent === 'restore' ? 'pending' : current.state,
        currentBusinessId: change.replacementBusinessId,
        pendingDate: change.pendingDate,
      };
    case 'cancel':
      return { state: 'cancelled' };
    case 'delete':
      return { state: 'deleted' };
    case 'hire':
      if (current.state !== 'pending' || change.hiredOn > tenantLocalDate(ctx.now, ctx.timezone)) return unavailable();
      return { state: 'hired', hiredRecordId: change.hiredRecordId, hiredOn: change.hiredOn };
  }
}

const lifecycle: EntryLifecyclePort = {
  async create(tx, ctx, entry) {
    const [created] = await tx
      .insert(cases)
      .values({
        tenantId: ctx.tenantId,
        employeeId: entry.employeeId,
        rootBusinessId: entry.businessId,
        currentBusinessId: entry.businessId,
        pendingDate: entry.pendingDate,
        createdAt: ctx.now,
        updatedAt: ctx.now,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      })
      .onConflictDoNothing()
      .returning();
    if (created) {
      await auditCase(tx, ctx, 'create', null, created);
      await generateMaterialList(tx, ctx, created);
      return created;
    }
    const current = await currentForUpdate(tx, ctx, entry);
    if (
      current.rootBusinessId !== entry.businessId ||
      current.state !== 'pending' ||
      current.pendingDate !== entry.pendingDate
    )
      return unavailable();
    return current;
  },
  async apply(tx, ctx, change) {
    const current = await currentForUpdate(tx, ctx, change);
    if (change.kind === 'cancel' && current.state === 'cancelled') return current;
    const patch = lifecyclePatch(ctx, current, change);
    const [updated] = await tx
      .update(cases)
      .set({ ...patch, revision: current.revision + 1, updatedAt: ctx.now, updatedBy: ctx.userId })
      .where(and(eq(cases.tenantId, ctx.tenantId), eq(cases.id, current.id)))
      .returning();
    if (!updated) return unavailable();
    await auditCase(tx, ctx, change.kind, current, updated);
    return updated;
  },
  async lockForWrite(tx, ctx, ref, allowedStates) {
    // 调用方已按 §6.2 锁员工。在阶段锁之前复核业务头，避免阶段写与改期逆序。
    const [business] = await tx
      .select({ revision: businesses.revision })
      .from(businesses)
      .where(
        and(
          eq(businesses.tenantId, ctx.tenantId),
          eq(businesses.employeeId, ref.employeeId),
          eq(businesses.id, ref.businessId),
        ),
      )
      .for('update');
    if (!business) return unavailable();
    const current = await currentForUpdate(tx, ctx, ref);
    if (current.id !== ref.caseId || !allowedStates.includes(current.state)) return unavailable();
    assertCaseRevision(ref.businessRevision, business.revision);
    assertCaseRevision(ref.caseRevision, current.revision);
    return current;
  },
};

/** 本片装配事务端口。现有待入职写入口在 16a-1 调用，采集任务从 16a-2a 起消费。 */
export function registerOnboardingContract(): void {
  registerEntryLifecyclePort(lifecycle);
}
