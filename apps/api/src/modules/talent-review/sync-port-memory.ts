/**
 * 同步端口替身（《R3-T04/T05 同步协议》SP-18）：createInMemoryTalentReviewSyncPort(data) 按协议实现全部方法，
 * 供 R3-T05 / T06 在 T04 PR-D 之前开发与测试，并与真实实现跑同一套契约（sync-port.contract.test.ts）。
 * 回执组合与状态转换用领域层同一份规则（sync-outcomes.ts）。每个方法先校验、后写入，失败整调用不写；
 * transaction() 失败时整体回滚，模拟“一页一个事务”。读取（三档选择器、健康度）见 sync-port-memory-reads.ts。
 */
import type { Tx } from '@italent/db';
import {
  completionBlocker,
  type ConsumptionState,
  countOutcomes,
  type OutcomeItem,
  type OutcomePhase,
  outcomeAllowed,
  outcomeTransition,
  type PageCommit,
  pageCommandIdOf,
  ROW_KINDS,
  type RowKind,
  type SourceReadAuthorization,
  type SyncConsumer,
  type SyncErrorCode,
  type SyncTargetRegistration,
  TARGET_KEY_PATTERN,
} from '@italent/domain';
import { InMemoryReads, type InMemorySyncData, type MemoryState } from './sync-port-memory-reads.js';
import { type Page, SYNC_NOMINATION_PAGE_LIMIT, SYNC_OBJECT_PAGE_LIMIT, SyncPortError } from './sync-port.js';
import type { TalentReviewSyncPort } from './sync-port.js';

export type { InMemoryReviewSource, InMemorySyncData, InMemorySyncRun } from './sync-port-memory-reads.js';

type Port = TalentReviewSyncPort;
type Args<K extends keyof Port> = Parameters<Port[K]>[1];
type Consumption = MemoryState['consumptions'] extends Map<string, infer C> ? C : never;
type StoredOutcome = OutcomeItem;

const fail = (code: SyncErrorCode, message: string, params?: Record<string, unknown>): never => {
  throw new SyncPortError(code, message, params);
};
const rowKey = (runId: string, consumer: string, kind: RowKind, rowId: string) =>
  `${runId}|${consumer}|${kind}|${rowId}`;
const consumptionKey = (runId: string, consumer: string) => `${runId}|${consumer}`;
const commitKey = (runId: string, consumer: string, pageCommandId: string) => `${runId}|${consumer}|${pageCommandId}`;
const ABORT_RECOVERY: Readonly<Partial<Record<SyncErrorCode, 'terminate' | 'new_run'>>> = {
  ABORTED_BY_ADMIN: 'terminate',
  SCOPE_REQUIRED: 'new_run',
  ACTOR_SCOPE_EXCEEDED: 'new_run',
  UNSUPPORTED_TRIGGER: 'new_run',
};

/** 替身端口 + 测试控制面（撤权、取代、拨时钟）；真实实现的测试夹具提供同一组控制。 */
export class InMemorySyncPort extends InMemoryReads implements TalentReviewSyncPort {
  /** 在一个“事务”内执行；抛错时恢复到调用前的状态（整页回滚）。 */
  async transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    const saved = structuredClone(this.state);
    try {
      return await work({} as Tx);
    } catch (error) {
      this.state = saved;
      throw error;
    }
  }

  /** 项目重启取代 run（SP-04）：run → superseded；未完成的消费记录与全部非终态回执行 → superseded。 */
  supersede(runId: string, byRunId: string | null = null): void {
    const run = this.requireRun(this.data.tenantId, runId);
    run.header = { ...run.header, status: 'superseded', supersededByRunId: byRunId };
    for (const consumer of this.consumers) {
      const key = consumptionKey(runId, consumer);
      let record = this.state.consumptions.get(key);
      if (!record) this.state.consumptions.set(key, (record = this.freshRecord(runId, consumer, 0)));
      else if (record.status !== 'running') continue;
      Object.assign(record, { status: 'superseded', terminalCode: 'RUN_SUPERSEDED', terminalRecovery: 'terminate' });
      this.terminateRows(runId, consumer, 'superseded', 'RUN_SUPERSEDED');
    }
  }

  async loadRun(_tx: Tx, key: Args<'loadRun'>) {
    return this.findRun(key.tenantId, key.runId)?.header ?? null;
  }

  async authorizeSourceRead(_tx: Tx, input: Args<'authorizeSourceRead'>): Promise<SourceReadAuthorization> {
    const run = this.requireRun(input.tenantId, input.runId);
    const empty = { objectIds: [], fields: {}, sources: [], orgIds: [] };
    if (run.header.status === 'superseded') return { ok: false, runStatus: 'superseded', forbidden: empty };
    const revoked = this.state.revoked;
    const reason = revoked.principal
      ? 'PRINCIPAL_UNAVAILABLE'
      : revoked.owner
        ? 'OWNER_UNAVAILABLE'
        : revoked.project
          ? 'PROJECT_INVISIBLE'
          : undefined;
    if (reason) return { ok: false, runStatus: 'frozen', reason, forbidden: empty };
    const page = input.page;
    const nominationObjects = run.nominations
      .filter((n) => page.nominationIds?.includes(n.nominationId))
      .map((n) => n.objectId);
    const objectIds = [...new Set([...(page.objectIds ?? []), ...nominationObjects])].sort();
    const fieldCodes = page.fieldCodes ?? [...revoked.fieldCodes];
    const fields = fieldCodes.filter((code) => revoked.fieldCodes.includes(code));
    return {
      ok: true,
      runStatus: 'frozen',
      forbidden: {
        objectIds: objectIds.filter((id) => revoked.objectIds.includes(id)),
        fields: fields.length ? Object.fromEntries(objectIds.map((id) => [id, fields])) : {},
        sources: revoked.sources.filter((source) => objectIds.includes(source.objectId)),
        orgIds: (page.orgIds ?? []).filter((id) => revoked.orgIds.includes(id)),
      },
    };
  }

  async listRunObjects(_tx: Tx, input: Args<'listRunObjects'>) {
    const run = this.requireRun(input.tenantId, input.runId);
    return paginate(run.objects, (o) => o.objectId, input, SYNC_OBJECT_PAGE_LIMIT);
  }

  async listRunNominations(_tx: Tx, input: Args<'listRunNominations'>) {
    const run = this.requireRun(input.tenantId, input.runId);
    return paginate(run.nominations, (n) => n.nominationId, input, SYNC_NOMINATION_PAGE_LIMIT);
  }

  async listRunOrgHealth(_tx: Tx, key: Args<'listRunOrgHealth'>) {
    return [...this.requireRun(key.tenantId, key.runId).orgHealth].sort((a, b) => cmp(a.orgId, b.orgId));
  }

  async beginConsumption(_tx: Tx, input: Args<'beginConsumption'>): Promise<ConsumptionState> {
    const run = this.requireRun(input.tenantId, input.runId);
    const key = consumptionKey(input.runId, input.consumer);
    const record = this.state.consumptions.get(key);
    const lease = { leaseOwner: input.leaseOwner, leaseUntil: this.after(input.leaseSeconds) };
    if (!record) {
      if (run.header.status === 'superseded') fail('RUN_SUPERSEDED', 'run 已被取代');
      this.state.consumptions.set(key, { ...this.freshRecord(input.runId, input.consumer, 1), ...lease });
    } else if (record.status === 'running') {
      if (record.leaseUntil && record.leaseUntil > this.now()) fail('CONSUMPTION_LEASED', '另一执行持有效租约');
      // 租约已过期：接管，执行序号 + 1，旧执行此后一律 EXECUTION_INACTIVE（SP-08）
      Object.assign(record, { executionNo: record.executionNo + 1, ...lease });
    }
    return this.stateOf(input.runId, input.consumer);
  }

  async renewLease(_tx: Tx, input: Args<'renewLease'>): Promise<ConsumptionState> {
    const record = this.activeRecord(input);
    if (record.leaseOwner !== input.leaseOwner) fail('EXECUTION_INACTIVE', '租约持有人不符');
    record.leaseUntil = this.after(input.leaseSeconds);
    return this.stateOf(input.runId, input.consumer);
  }

  async registerTargets(_tx: Tx, input: Args<'registerTargets'>) {
    const record = this.activeRecord(input);
    const pageCommandId = pageCommandIdOf(input.runId, input.consumer, input.executionNo, 0);
    const digest = JSON.stringify([input.targets, input.planOutcomes.map(outcomeDigest)]);
    if (record.sealed) {
      if (record.planCommandId === input.planCommandId && record.planDigest === digest && record.planCommit) {
        return { state: this.stateOf(input.runId, input.consumer), pageCommit: record.planCommit };
      }
      fail('TARGETS_ALREADY_SEALED', '目标已封存');
    }
    const run = this.requireRun(input.tenantId, input.runId);
    validateTargets(input.targets, new Set(run.nominations.map((n) => n.nominationId)));
    const targetKeys = new Set<string>(input.targets.map((t) => t.targetKey));
    const writes = this.checkItems(input, input.planOutcomes, 'plan', targetKeys);
    for (const targetKey of targetKeys) this.putRow(input, { ...pendingRow('target', targetKey, this.now()) });
    this.applyItems(input, writes, input.executionNo, pageCommandId);
    const pageCommit = this.commit(input, 0, pageCommandId, 'plan', input.planOutcomes.length);
    Object.assign(record, { sealed: true, targetCount: targetKeys.size, planCommandId: input.planCommandId });
    Object.assign(record, { planDigest: digest, planCommit: pageCommit });
    return { state: this.stateOf(input.runId, input.consumer), pageCommit };
  }

  async assertExecutionActive(_tx: Tx, input: Args<'assertExecutionActive'>): Promise<void> {
    const record = this.activeRecord(input);
    if (record.leaseOwner !== input.leaseOwner || !record.leaseUntil || record.leaseUntil <= this.now()) {
      fail('EXECUTION_INACTIVE', '租约已失效');
    }
    if ((input.requireSealed ?? true) && !record.sealed) fail('TARGETS_NOT_SEALED', '目标尚未封存');
  }

  async recordOutcome(_tx: Tx, input: Args<'recordOutcome'>): Promise<PageCommit> {
    const record = this.activeRecord(input);
    if (!record.sealed) fail('TARGETS_NOT_SEALED', '目标尚未封存');
    const expected = pageCommandIdOf(input.runId, input.consumer, input.executionNo, input.pageNo);
    if (input.pageNo < 1 || input.pageCommandId !== expected) fail('OUTCOME_NOT_ALLOWED', '执行页命令身份不合法');
    const existing = this.state.commits.get(commitKey(input.runId, input.consumer, input.pageCommandId));
    if (existing) return existing;
    // SP-11：执行页回执不得为空，且须带本页处理过的目标行（健康度目标为 org_health 行）
    if (!input.items.some((item) => item.rowKind === 'target' || item.rowKind === 'org_health')) {
      fail('OUTCOME_NOT_ALLOWED', '执行页必须包含本页目标行的终态');
    }
    const writes = this.checkItems(input, input.items, 'execute', new Set());
    this.applyItems(input, writes, input.executionNo, input.pageCommandId);
    return this.commit(input, input.pageNo, input.pageCommandId, 'execute', input.items.length);
  }

  async getPageCommit(_tx: Tx, input: Args<'getPageCommit'>) {
    this.requireRun(input.tenantId, input.runId);
    return this.state.commits.get(commitKey(input.runId, input.consumer, input.pageCommandId)) ?? null;
  }

  async getOutcomes(_tx: Tx, input: Args<'getOutcomes'>): Promise<Page<OutcomeItem>> {
    this.requireRun(input.tenantId, input.runId);
    const rows = this.rowsOf(input.runId, input.consumer)
      .filter((row) => !input.rowKind || row.rowKind === input.rowKind)
      .filter((row) => !input.pageCommandId || row.pageCommandId === input.pageCommandId);
    const cursor = (row: OutcomeItem) => `${ROW_KINDS.indexOf(row.rowKind)}|${row.rowId}`;
    return paginate(rows, cursor, { after: input.after, limit: input.limit ?? 500 }, SYNC_NOMINATION_PAGE_LIMIT);
  }

  async completeConsumption(_tx: Tx, input: Args<'completeConsumption'>): Promise<ConsumptionState> {
    const record = this.state.consumptions.get(consumptionKey(input.runId, input.consumer));
    if (record?.status === 'completed' && record.executionNo === input.executionNo) {
      return this.stateOf(input.runId, input.consumer);
    }
    const active = this.activeRecord(input);
    if (!active.sealed) fail('TARGETS_NOT_SEALED', '目标尚未封存');
    const blocker = completionBlocker(countOutcomes(this.rowsOf(input.runId, input.consumer)));
    if (blocker) fail(blocker, blocker === 'PENDING_ROWS_REMAIN' ? '仍有待处理行' : '仍有可重试的失败行');
    active.status = 'completed';
    return this.stateOf(input.runId, input.consumer);
  }

  async abortConsumption(_tx: Tx, input: Args<'abortConsumption'>): Promise<ConsumptionState> {
    this.requireRun(input.tenantId, input.runId);
    const key = consumptionKey(input.runId, input.consumer);
    const record = this.state.consumptions.get(key);
    if (record && record.status !== 'running') return this.stateOf(input.runId, input.consumer); // 终态幂等，不改码
    if (ABORT_RECOVERY[input.code] !== input.recovery) fail('OUTCOME_NOT_ALLOWED', '终止码与恢复动作不匹配');
    if (input.executionNo === null) {
      // C 类：只在尚无消费记录（首次计划成功之前）时允许，建记录即 aborted（SP-13）
      if (record) fail('EXECUTION_INACTIVE', '已有消费记录，须带当前执行序号');
      this.state.consumptions.set(key, this.freshRecord(input.runId, input.consumer, 0));
    } else if (record?.executionNo !== input.executionNo) {
      fail('EXECUTION_INACTIVE', '执行序号不是当前执行');
    }
    const target = this.state.consumptions.get(key)!;
    Object.assign(target, { status: 'aborted', terminalCode: input.code, terminalRecovery: input.recovery });
    this.terminateRows(input.runId, input.consumer, 'aborted', input.code);
    return this.stateOf(input.runId, input.consumer);
  }

  // ---- 内部 ----

  private activeRecord(input: { tenantId: string; runId: string; consumer: SyncConsumer; executionNo: number }) {
    const run = this.requireRun(input.tenantId, input.runId);
    const record = this.state.consumptions.get(consumptionKey(input.runId, input.consumer));
    if (run.header.status === 'superseded' || record?.status === 'superseded') fail('RUN_SUPERSEDED', 'run 已被取代');
    if (!record || record.status !== 'running' || record.executionNo !== input.executionNo) {
      fail('EXECUTION_INACTIVE', '执行已失效');
    }
    return record!;
  }

  /** 校验整批回执：组合表（SP-14）、行存在、批内不重复、状态转换（SP-12）；任一不合格整调用不写。 */
  private checkItems(
    run: { runId: string; consumer: SyncConsumer },
    items: readonly OutcomeItem[],
    phase: OutcomePhase,
    newTargets: ReadonlySet<string>,
  ): OutcomeItem[] {
    const seen = new Set<string>();
    const kinds = new Map(
      this.requireRun(this.data.tenantId, run.runId).nominations.map((n) => [n.nominationId, n.kind]),
    );
    const writes: OutcomeItem[] = [];
    for (const item of items) {
      const key = rowKey(run.runId, run.consumer, item.rowKind, item.rowId);
      const current = this.state.outcomes.get(key);
      const exists = current || (item.rowKind === 'target' && newTargets.has(item.rowId));
      if (!exists || seen.has(key) || !outcomeAllowed(item, phase, { nominationKind: (id) => kinds.get(id) })) {
        fail('OUTCOME_NOT_ALLOWED', '回执组合不在协议表内', { rowKind: item.rowKind, rowId: item.rowId });
      }
      seen.add(key);
      const change = current ? outcomeTransition(current, item) : 'write';
      if (change === 'ROW_FINAL')
        fail('ROW_FINAL', '行已终态，不能改为其他结果', { rowKind: item.rowKind, rowId: item.rowId });
      if (change === 'write') writes.push(item);
    }
    return writes;
  }

  private applyItems(run: { runId: string; consumer: SyncConsumer }, items: OutcomeItem[], no: number, pageId: string) {
    for (const item of items) {
      this.putRow(run, { ...item, executionNo: no, pageCommandId: pageId, updatedAt: this.now() });
    }
  }

  private commit(
    run: { runId: string; consumer: SyncConsumer; executionNo: number },
    pageNo: number,
    pageCommandId: string,
    kind: PageCommit['kind'],
    rowCount: number,
  ): PageCommit {
    const value: PageCommit = { ...run, pageNo, pageCommandId, kind, rowCount, committedAt: this.now() };
    this.state.commits.set(commitKey(run.runId, run.consumer, pageCommandId), value);
    return value;
  }

  private terminateRows(runId: string, consumer: SyncConsumer, status: 'aborted' | 'superseded', code: SyncErrorCode) {
    for (const row of this.rowsOf(runId, consumer)) {
      if (row.status !== 'pending' && !(row.status === 'failed' && row.recovery === 'retry_same_run')) continue;
      const next = { ...row, status, recovery: 'none' as const, errorCode: code, updatedAt: this.now() };
      if (!outcomeAllowed(next, 'terminate', { nominationKind: () => undefined }))
        throw new Error(`终止码 ${code} 不合法`);
      this.putRow({ runId, consumer }, next);
    }
  }

  private putRow(run: { runId: string; consumer: string }, row: StoredOutcome) {
    const { errorCode, errorParams, ...rest } = row;
    const clean: StoredOutcome = {
      ...rest,
      ...(errorCode ? { errorCode } : {}),
      ...(errorParams ? { errorParams } : {}),
    };
    this.state.outcomes.set(rowKey(run.runId, run.consumer, row.rowKind, row.rowId), clean);
  }

  private stateOf(runId: string, consumer: SyncConsumer): ConsumptionState {
    const record: Consumption = this.state.consumptions.get(consumptionKey(runId, consumer))!;
    return {
      runId,
      consumer,
      status: record.status,
      executionNo: record.executionNo,
      leaseOwner: record.leaseOwner,
      leaseUntil: record.leaseUntil,
      targetsSealed: record.sealed,
      targetCount: record.targetCount,
      terminalCode: record.terminalCode,
      terminalRecovery: record.terminalRecovery,
      counts: countOutcomes(this.rowsOf(runId, consumer)),
    };
  }

  private after(seconds: number) {
    return new Date(this.now().getTime() + seconds * 1000);
  }
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const outcomeDigest = (item: OutcomeItem) => [
  item.rowKind,
  item.rowId,
  item.status,
  item.recovery,
  item.errorCode,
  item.errorParams,
];

export function pendingRow(rowKind: RowKind, rowId: string, now: Date): OutcomeItem {
  return {
    rowKind,
    rowId,
    status: 'pending',
    recovery: 'none',
    executionNo: null,
    pageCommandId: null,
    updatedAt: now,
  };
}

function validateTargets(targets: readonly SyncTargetRegistration[], nominations: ReadonlySet<string>) {
  const keys = new Set<string>();
  for (const target of targets) {
    const valid =
      TARGET_KEY_PATTERN.test(target.targetKey) &&
      !keys.has(target.targetKey) &&
      ['append', 'overwrite', 'scope_overwrite', 'delete_only'].includes(target.action) &&
      target.nominationIds.every((id) => nominations.has(id));
    if (!valid) fail('OUTCOME_NOT_ALLOWED', '目标登记不合法', { targetKey: target.targetKey });
    keys.add(target.targetKey);
  }
}

function paginate<T>(
  rows: readonly T[],
  cursorOf: (row: T) => string,
  input: { after?: string | undefined; limit: number },
  maximum: number,
): Page<T> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > maximum) {
    throw new RangeError(`每页 1～${maximum} 条`);
  }
  const sorted = [...rows].sort((a, b) => cmp(cursorOf(a), cursorOf(b)));
  const start = input.after === undefined ? 0 : sorted.findIndex((row) => cursorOf(row) > input.after!);
  const items = start < 0 ? [] : sorted.slice(start, start + input.limit);
  const last = items.at(-1);
  const more = start >= 0 && start + input.limit < sorted.length;
  return { items, next: more && last ? cursorOf(last) : null };
}

/** 替身工厂（SP-18）：按给定的冻结 run、三档来源、健康度行与准备度建一个端口。 */
export function createInMemoryTalentReviewSyncPort(data: InMemorySyncData): InMemorySyncPort {
  return new InMemorySyncPort(data);
}
