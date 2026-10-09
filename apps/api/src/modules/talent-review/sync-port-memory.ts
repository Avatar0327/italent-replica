/**
 * 同步端口替身（《R3-T04/T05 同步协议》SP-18）：createInMemoryTalentReviewSyncPort(data) 按协议实现全部方法，
 * 供 R3-T05 / T06 在 T04 PR-D 之前开发与测试，并与真实实现跑同一套契约（tests/acceptance/support/sync-port-contract.ts）。
 * - 回执组合与状态转换用领域层同一份规则（sync-outcomes.ts）；每个方法先校验租户，再校验协议，最后写入；
 * - 事务边界（SP-11）：每个事务只回滚自己的写入；消费记录按 S / X 锁等待（执行页断言取 S，接管 / 终止 / 完成 / 取代取 X）；
 *   完成只能在独立终结事务里做，执行页内调用 completeConsumption 是协议违例；
 * - 幂等（DEC-067）：计划提交与执行页都按完整内容指纹比较，同键异内容拒绝，比较在返回已有证明之前。
 * 读取（三档选择器、健康度）见 sync-port-memory-reads.ts，事务与锁见 sync-port-memory-tx.ts。
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
import { type Consumption, InMemoryReads, type InMemorySyncData } from './sync-port-memory-reads.js';
import type { MemoryTx } from './sync-port-memory-tx.js';
import { type Page, SYNC_NOMINATION_PAGE_LIMIT, SYNC_OBJECT_PAGE_LIMIT, SyncPortError } from './sync-port.js';
import type { TalentReviewSyncPort } from './sync-port.js';

export type { InMemoryReviewSource, InMemorySyncData, InMemorySyncRun } from './sync-port-memory-reads.js';

type Args<K extends keyof TalentReviewSyncPort> = Parameters<TalentReviewSyncPort[K]>[1];
interface RunConsumer {
  readonly tenantId: string;
  readonly runId: string;
  readonly consumer: SyncConsumer;
}
interface Execution extends RunConsumer {
  readonly executionNo: number;
}

const fail = (code: SyncErrorCode, message: string, params?: Record<string, unknown>): never => {
  throw new SyncPortError(code, message, params);
};
const rowKey = (runId: string, consumer: string, kind: RowKind, rowId: string) =>
  `${runId}|${consumer}|${kind}|${rowId}`;
const consumptionKey = (runId: string, consumer: string) => `${runId}|${consumer}`;
const commitKey = (runId: string, consumer: string, pageCommandId: string) => `${runId}|${consumer}|${pageCommandId}`;
/** 消费记录锁：消费记录、它的回执行与页证明都挂在这把锁下（S = 执行页 / 读取，X = 接管 / 计划 / 终结）。 */
const recordLock = (runId: string, consumer: string) => `consumption|${runId}|${consumer}`;
const C_CLASS: readonly SyncErrorCode[] = ['SCOPE_REQUIRED', 'ACTOR_SCOPE_EXCEEDED', 'UNSUPPORTED_TRIGGER'];
const outcomeDigest = (item: OutcomeItem) => [
  item.rowKind,
  item.rowId,
  item.status,
  item.recovery,
  item.errorCode ?? null,
  item.errorParams ?? null,
];

/** 替身端口 + 测试控制面（撤权、取代、拨时钟）；真实实现的测试夹具提供同一组控制。 */
export class InMemorySyncPort extends InMemoryReads implements TalentReviewSyncPort {
  /** 一个事务：失败只回滚本事务的写入，锁到事务结束才释放。 */
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.txs.run(work);
  }

  /** 项目重启取代 run（SP-04）：消费记录 X 锁内，run → superseded，未完成的消费记录与全部非终态回执行 → superseded。 */
  supersede(runId: string, byRunId: string | null = null): Promise<void> {
    return this.txs.run((tx) => this.txs.within(tx, (m) => this.supersedeIn(m, runId, byRunId)));
  }

  private async supersedeIn(m: MemoryTx, runId: string, byRunId: string | null): Promise<void> {
    this.requireRun(this.data.tenantId, runId);
    for (const consumer of this.consumers) await this.txs.lock(m, recordLock(runId, consumer), 'X');
    const run = this.requireRun(this.data.tenantId, runId);
    const header = { ...run.header, status: 'superseded' as const, supersededByRunId: byRunId };
    this.set(m, this.state.runs, runId, { ...run, header });
    const terminal = { status: 'superseded', terminalCode: 'RUN_SUPERSEDED', terminalRecovery: 'terminate' } as const;
    for (const consumer of this.consumers) {
      const key = consumptionKey(runId, consumer);
      const record = this.state.consumptions.get(key);
      if (record && record.status !== 'running') continue;
      this.set(m, this.state.consumptions, key, { ...(record ?? this.freshRecord(0)), ...terminal });
      this.terminateRows(m, runId, consumer, 'superseded', 'RUN_SUPERSEDED');
    }
  }

  async loadRun(_tx: Tx, key: Args<'loadRun'>) {
    return this.findRun(key.tenantId, key.runId)?.header ?? null;
  }

  authorizeSourceRead(tx: Tx, input: Args<'authorizeSourceRead'>): Promise<SourceReadAuthorization> {
    return this.txs.within(tx, async (m) => {
      this.requireRun(input.tenantId, input.runId);
      await this.txs.lock(m, recordLock(input.runId, input.consumer), 'S');
      const run = this.requireRun(input.tenantId, input.runId);
      const empty = { objectIds: [], fields: {}, sources: [], orgIds: [], orgFields: {} };
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
      const orgIds = page.orgIds ?? [];
      const fields = (page.fieldCodes ?? [...revoked.fieldCodes]).filter((code) => revoked.fieldCodes.includes(code));
      const perId = (ids: readonly string[]) =>
        fields.length ? Object.fromEntries(ids.map((id) => [id, fields])) : {};
      return {
        ok: true,
        runStatus: 'frozen',
        forbidden: {
          objectIds: objectIds.filter((id) => revoked.objectIds.includes(id)),
          fields: perId(objectIds),
          sources: revoked.sources.filter((source) => objectIds.includes(source.objectId)),
          orgIds: orgIds.filter((id) => revoked.orgIds.includes(id)),
          orgFields: perId(orgIds),
        },
      };
    });
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

  beginConsumption(tx: Tx, input: Args<'beginConsumption'>): Promise<ConsumptionState> {
    return this.txs.within(tx, async (m) => {
      this.requireRun(input.tenantId, input.runId);
      await this.txs.lock(m, recordLock(input.runId, input.consumer), 'X');
      const run = this.requireRun(input.tenantId, input.runId);
      const key = consumptionKey(input.runId, input.consumer);
      const record = this.state.consumptions.get(key);
      const lease = { leaseOwner: input.leaseOwner, leaseUntil: this.after(input.leaseSeconds) };
      if (!record) {
        if (run.header.status === 'superseded') fail('RUN_SUPERSEDED', 'run 已被取代');
        this.set(m, this.state.consumptions, key, { ...this.freshRecord(1), ...lease });
      } else if (record.status === 'running') {
        if (record.leaseUntil && record.leaseUntil > this.now()) fail('CONSUMPTION_LEASED', '另一执行持有效租约');
        // 租约已过期：接管，执行序号 + 1，旧执行此后一律 EXECUTION_INACTIVE（SP-08）
        this.set(m, this.state.consumptions, key, { ...record, executionNo: record.executionNo + 1, ...lease });
      }
      return this.stateOf(input.runId, input.consumer);
    });
  }

  renewLease(tx: Tx, input: Args<'renewLease'>): Promise<ConsumptionState> {
    return this.txs.within(tx, async (m) => {
      const record = await this.activeRecord(m, input, 'X');
      if (record.leaseOwner !== input.leaseOwner) fail('EXECUTION_INACTIVE', '租约持有人不符');
      const key = consumptionKey(input.runId, input.consumer);
      this.set(m, this.state.consumptions, key, { ...record, leaseUntil: this.after(input.leaseSeconds) });
      return this.stateOf(input.runId, input.consumer);
    });
  }

  registerTargets(tx: Tx, input: Args<'registerTargets'>) {
    return this.txs.within(tx, async (m) => {
      const record = await this.activeRecord(m, input, 'X');
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
      for (const targetKey of targetKeys) this.putRow(m, input, pendingRow('target', targetKey, this.now()));
      this.applyItems(m, input, writes, pageCommandId);
      const pageCommit = this.commit(m, input, 0, pageCommandId, 'plan', input.planOutcomes, digest);
      const sealed = { sealed: true, targetCount: targetKeys.size, planCommandId: input.planCommandId };
      const key = consumptionKey(input.runId, input.consumer);
      this.set(m, this.state.consumptions, key, { ...record, ...sealed, planDigest: digest, planCommit: pageCommit });
      return { state: this.stateOf(input.runId, input.consumer), pageCommit };
    });
  }

  assertExecutionActive(tx: Tx, input: Args<'assertExecutionActive'>): Promise<void> {
    return this.txs.within(tx, async (m) => {
      const record = await this.activeRecord(m, input, 'S');
      if (record.leaseOwner !== input.leaseOwner || !record.leaseUntil || record.leaseUntil <= this.now()) {
        fail('EXECUTION_INACTIVE', '租约已失效');
      }
      const requireSealed = input.requireSealed ?? true;
      if (requireSealed && !record.sealed) fail('TARGETS_NOT_SEALED', '目标尚未封存');
      if (requireSealed) m.page = true;
    });
  }

  recordOutcome(tx: Tx, input: Args<'recordOutcome'>): Promise<PageCommit> {
    return this.txs.within(tx, async (m) => {
      const record = await this.activeRecord(m, input, 'S');
      if (!record.sealed) fail('TARGETS_NOT_SEALED', '目标尚未封存');
      const expected = pageCommandIdOf(input.runId, input.consumer, input.executionNo, input.pageNo);
      if (input.pageNo < 1 || input.pageCommandId !== expected) fail('OUTCOME_NOT_ALLOWED', '执行页命令身份不合法');
      const digest = JSON.stringify(input.items.map(outcomeDigest));
      const existing = this.state.commits.get(commitKey(input.runId, input.consumer, input.pageCommandId));
      if (existing) {
        // 同页重放须同内容（DEC-067）：比较在返回已有证明之前
        if (existing.digest !== digest) fail('IDEMPOTENCY_CONFLICT', '同一页命令的回执内容不同');
        return existing.commit;
      }
      // SP-11：执行页回执不得为空，且须带本页处理过的目标行（健康度目标为 org_health 行）
      if (!input.items.some((item) => item.rowKind === 'target' || item.rowKind === 'org_health')) {
        fail('OUTCOME_NOT_ALLOWED', '执行页必须包含本页目标行的终态');
      }
      const writes = this.checkItems(input, input.items, 'execute', new Set());
      m.page = true;
      this.applyItems(m, input, writes, input.pageCommandId);
      return this.commit(m, input, input.pageNo, input.pageCommandId, 'execute', input.items, digest);
    });
  }

  getPageCommit(tx: Tx, input: Args<'getPageCommit'>) {
    return this.txs.within(tx, async (m) => {
      this.requireRun(input.tenantId, input.runId);
      await this.txs.lock(m, recordLock(input.runId, input.consumer), 'S');
      return this.state.commits.get(commitKey(input.runId, input.consumer, input.pageCommandId))?.commit ?? null;
    });
  }

  getOutcomes(tx: Tx, input: Args<'getOutcomes'>): Promise<Page<OutcomeItem>> {
    return this.txs.within(tx, async (m) => {
      this.requireRun(input.tenantId, input.runId);
      await this.txs.lock(m, recordLock(input.runId, input.consumer), 'S');
      const rows = this.rowsOf(input.runId, input.consumer)
        .filter((row) => !input.rowKind || row.rowKind === input.rowKind)
        .filter((row) => !input.pageCommandId || row.pageCommandId === input.pageCommandId);
      const cursor = (row: OutcomeItem) => `${ROW_KINDS.indexOf(row.rowKind)}|${row.rowId}`;
      return paginate(rows, cursor, { after: input.after, limit: input.limit ?? 500 }, SYNC_NOMINATION_PAGE_LIMIT);
    });
  }

  completeConsumption(tx: Tx, input: Args<'completeConsumption'>): Promise<ConsumptionState> {
    return this.txs.within(tx, async (m) => {
      // 租户先于一切，包括已完成的重放分支
      this.requireRun(input.tenantId, input.runId);
      if (m.page) fail('OUTCOME_NOT_ALLOWED', '完成须在执行页提交后的独立终结事务里做');
      await this.txs.lock(m, recordLock(input.runId, input.consumer), 'X');
      const record = this.state.consumptions.get(consumptionKey(input.runId, input.consumer));
      if (record?.status === 'completed' && record.executionNo === input.executionNo) {
        return this.stateOf(input.runId, input.consumer);
      }
      const active = await this.activeRecord(m, input, 'X');
      if (!active.sealed) fail('TARGETS_NOT_SEALED', '目标尚未封存');
      const blocker = completionBlocker(countOutcomes(this.rowsOf(input.runId, input.consumer)));
      if (blocker) fail(blocker, blocker === 'PENDING_ROWS_REMAIN' ? '仍有待处理行' : '仍有可重试的失败行');
      this.set(m, this.state.consumptions, consumptionKey(input.runId, input.consumer), {
        ...active,
        status: 'completed',
      });
      return this.stateOf(input.runId, input.consumer);
    });
  }

  abortConsumption(tx: Tx, input: Args<'abortConsumption'>): Promise<ConsumptionState> {
    return this.txs.within(tx, async (m) => {
      this.requireRun(input.tenantId, input.runId);
      await this.txs.lock(m, recordLock(input.runId, input.consumer), 'X');
      const key = consumptionKey(input.runId, input.consumer);
      const record = this.state.consumptions.get(key);
      if (record && record.status !== 'running') return this.stateOf(input.runId, input.consumer); // 终态幂等，不改码
      // SP-13：C 类码只在首次计划成功前、尚无消费记录时以 executionNo = null 使用；null 也只用于 C 类
      const cClass = C_CLASS.includes(input.code);
      const allowed = cClass
        ? input.recovery === 'new_run' && input.executionNo === null
        : input.code === 'ABORTED_BY_ADMIN' && input.recovery === 'terminate' && input.executionNo !== null;
      if (!allowed) fail('OUTCOME_NOT_ALLOWED', '终止码、恢复动作与执行序号不匹配');
      if (input.executionNo === null) {
        if (record) fail('EXECUTION_INACTIVE', '已有消费记录，不能按计划前拒绝终止');
      } else if (record?.executionNo !== input.executionNo) {
        fail('EXECUTION_INACTIVE', '执行序号不是当前执行');
      }
      const base = record ?? this.freshRecord(0);
      const terminal = { status: 'aborted' as const, terminalCode: input.code, terminalRecovery: input.recovery };
      this.set(m, this.state.consumptions, key, { ...base, ...terminal });
      this.terminateRows(m, input.runId, input.consumer, 'aborted', input.code);
      return this.stateOf(input.runId, input.consumer);
    });
  }

  // ---- 内部 ----

  /** 租户 → 取消费记录锁 → 断言 running ∧ 当前执行序号 ∧ run 未取代。 */
  private async activeRecord(m: MemoryTx, input: Execution, mode: 'S' | 'X'): Promise<Consumption> {
    this.requireRun(input.tenantId, input.runId);
    await this.txs.lock(m, recordLock(input.runId, input.consumer), mode);
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
    run: RunConsumer,
    items: readonly OutcomeItem[],
    phase: OutcomePhase,
    newTargets: ReadonlySet<string>,
  ): OutcomeItem[] {
    const seen = new Set<string>();
    const kinds = new Map(this.requireRun(run.tenantId, run.runId).nominations.map((n) => [n.nominationId, n.kind]));
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
      if (change === 'ROW_FINAL') {
        fail('ROW_FINAL', '行已终态，不能改为其他结果', { rowKind: item.rowKind, rowId: item.rowId });
      }
      if (change === 'write') writes.push(item);
    }
    return writes;
  }

  private applyItems(m: MemoryTx, run: Execution, items: OutcomeItem[], pageCommandId: string) {
    for (const item of items) {
      this.putRow(m, run, { ...item, executionNo: run.executionNo, pageCommandId, updatedAt: this.now() });
    }
  }

  /** 页提交证明：只取协议字段，不把调用参数（items / targets / planOutcomes）带进 DTO。 */
  private commit(
    m: MemoryTx,
    run: Execution,
    pageNo: number,
    pageCommandId: string,
    kind: PageCommit['kind'],
    items: readonly OutcomeItem[],
    digest: string,
  ): PageCommit {
    const commit: PageCommit = {
      runId: run.runId,
      consumer: run.consumer,
      executionNo: run.executionNo,
      pageNo,
      pageCommandId,
      kind,
      rowCount: items.length,
      committedAt: this.now(),
    };
    this.set(m, this.state.commits, commitKey(run.runId, run.consumer, pageCommandId), { commit, digest });
    return commit;
  }

  private terminateRows(
    m: MemoryTx,
    runId: string,
    consumer: SyncConsumer,
    status: 'aborted' | 'superseded',
    code: SyncErrorCode,
  ) {
    for (const row of this.rowsOf(runId, consumer)) {
      if (row.status !== 'pending' && !(row.status === 'failed' && row.recovery === 'retry_same_run')) continue;
      const next = { ...row, status, recovery: 'none' as const, errorCode: code, updatedAt: this.now() };
      if (!outcomeAllowed(next, 'terminate', { nominationKind: () => undefined }))
        throw new Error(`终止码 ${code} 不合法`);
      this.putRow(m, { runId, consumer }, next);
    }
  }

  private putRow(m: MemoryTx, run: { runId: string; consumer: string }, row: OutcomeItem) {
    const { errorCode, errorParams, ...rest } = row;
    const clean: OutcomeItem = {
      ...rest,
      ...(errorCode ? { errorCode } : {}),
      ...(errorParams ? { errorParams } : {}),
    };
    this.set(m, this.state.outcomes, rowKey(run.runId, run.consumer, row.rowKind, row.rowId), clean);
  }

  private stateOf(runId: string, consumer: SyncConsumer): ConsumptionState {
    const record = this.state.consumptions.get(consumptionKey(runId, consumer))!;
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
