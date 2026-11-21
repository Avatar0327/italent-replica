import type { OnboardingEntryCase, Tx } from '@italent/db';

export interface EntryLifecycleContext {
  readonly tenantId: string;
  readonly userId: string | null;
  readonly commandId: string;
  readonly now: Date;
  readonly timezone: string;
}

interface EntryIdentity {
  readonly employeeId: string;
  readonly businessId: string;
}

export type EntryLifecycleChange = EntryIdentity &
  (
    | { readonly kind: 'replace'; readonly replacementBusinessId: string; readonly pendingDate: string }
    | { readonly kind: 'cancel' }
    | { readonly kind: 'delete' }
    | { readonly kind: 'hire'; readonly hiredRecordId: string; readonly hiredOn: string }
  );

export interface EntryCaseWriteRef extends EntryIdentity {
  readonly caseId: string;
  readonly caseRevision: number;
  readonly businessRevision: number;
}

/**
 * R2-T01 §2、§6.2。受信端口，调用方同一租户事务内先验业务事实、权限并持 Offer（若有关联）、
 * 员工和业务头锁，再操作阶段。替换只发一次 replace，内部删旧建新不发独立事件。
 * hire 只由已到业务日期且确认生效的任职路径产生。
 */
export interface EntryLifecyclePort {
  create(
    tx: Tx,
    ctx: EntryLifecycleContext,
    entry: EntryIdentity & { readonly pendingDate: string },
  ): Promise<OnboardingEntryCase>;
  apply(tx: Tx, ctx: EntryLifecycleContext, change: EntryLifecycleChange): Promise<OnboardingEntryCase>;
  lockForWrite(
    tx: Tx,
    ctx: EntryLifecycleContext,
    ref: EntryCaseWriteRef,
    allowedStates: readonly OnboardingEntryCase['state'][],
  ): Promise<OnboardingEntryCase>;
}

let installed: EntryLifecyclePort | undefined;

export function registerEntryLifecyclePort(port: EntryLifecyclePort): void {
  if (installed && installed !== port) throw new Error('入职阶段端口重复装配');
  installed = port;
}

export function entryLifecyclePort(): EntryLifecyclePort {
  if (!installed) throw new Error('入职阶段端口未装配');
  return installed;
}
