/** D2 / SP-09～14：页外续租；页内只取消费记录共享锁；终结另开互斥 → 消费记录事务。 */
import {
  and,
  eq,
  getTenant,
  sql,
  withTenant,
  successionSyncBatches as batches,
  successionSyncItems as items,
  successionSyncTargets as targets,
  type Tx,
} from '@italent/db';
import { inArray } from 'drizzle-orm';
import { SyncPortError } from '../talent-review/sync-port.js';
import { PlanFailure, writerAccess } from './sync-access.js';
import { lockTargets } from './record-write.js';
import { enqueueCalcRun } from './calc-worker.js';
import { mutex, release, save, notify, type SyncDeps, type SyncInput } from './sync-consume.js';
import {
  executeTarget,
  openItem,
  openTarget,
  type SyncBatch,
  type SyncTarget,
  type TargetContext,
} from './sync-execute-target.js';
import { terminateLocal } from './sync-control.js';
import { objectOutcomes, persistTarget } from './sync-execute-outcomes.js';

const pending = sql`(status='pending' OR (status='failed' AND retryable))`;
class Execution {
  readonly key;
  readonly transaction;
  constructor(
    readonly deps: SyncDeps,
    readonly input: SyncInput,
    public batch: SyncBatch,
    readonly timezone: string,
  ) {
    this.key = {
      tenantId: batch.tenantId,
      runId: batch.sourceRunId,
      consumer: 'succession' as const,
      executionNo: batch.executionNo!,
      leaseOwner: input.leaseOwner,
    };
    this.transaction =
      deps.transaction ?? (<T>(work: (tx: Tx) => Promise<T>) => withTenant(deps.db, batch.tenantId, work));
  }
  load(tx: Tx, lock = false) {
    const query = tx
      .select()
      .from(batches)
      .where(and(eq(batches.tenantId, this.batch.tenantId), eq(batches.id, this.batch.id)));
    return lock ? query.for('update') : query;
  }
  async next(tx: Tx, after = '') {
    return tx
      .select()
      .from(targets)
      .where(
        and(
          eq(targets.tenantId, this.batch.tenantId),
          eq(targets.batchId, this.batch.id),
          pending,
          sql`${targets.targetRowKey}>${after}`,
        ),
      )
      .orderBy(targets.targetRowKey)
      .limit(200);
  }
  async run() {
    let after = '';
    try {
      for (;;) {
        const page = await this.transaction((tx) => this.next(tx, after));
        if (!page.length) break;
        await this.transaction((tx) => this.deps.port.renewLease(tx, { ...this.key, leaseSeconds: 120 }));
        this.batch = await this.commitPage(page);
        after = page.at(-1)!.targetRowKey;
      }
      return await this.transaction((tx) => this.finish(tx));
    } catch (error) {
      if (error instanceof SyncPortError && error.code === 'EXECUTION_INACTIVE')
        return (await this.transaction((tx) => this.load(tx)))[0]!;
      return this.transaction((tx) => this.fail(tx, error));
    }
  }
  async commitPage(page: SyncTarget[]) {
    const pageNo = this.batch.nextPageNo;
    const commandId = `${this.key.runId}:succession:${this.key.executionNo}:${pageNo}`;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.transaction((tx) => this.page(tx, page, pageNo, commandId));
      } catch (error) {
        if (error instanceof PlanFailure || error instanceof SyncPortError) throw error;
        const confirmed = await this.transaction(async (tx) => {
          const proof = await this.deps.port.getPageCommit(tx, { ...this.key, pageCommandId: commandId });
          const [local] = await this.load(tx);
          const valid = proof?.kind === 'execute' && proof.executionNo === this.key.executionNo;
          if (valid) return local!;
          if (local!.nextPageNo > pageNo) throw new PlanFailure('STORAGE_UNAVAILABLE');
          return undefined;
        });
        if (confirmed) return confirmed;
        if (attempt) throw new PlanFailure('STORAGE_UNAVAILABLE');
      }
    }
  }
  async prepare(tx: Tx, page: SyncTarget[], commandId: string): Promise<TargetContext> {
    const nominations = await tx
      .select()
      .from(items)
      .where(
        and(
          eq(items.tenantId, this.key.tenantId),
          eq(items.batchId, this.batch.id),
          inArray(
            items.id,
            page.flatMap((t) => t.plannedItemIds),
          ),
        ),
      );
    const source = await this.deps.port.authorizeSourceRead(tx, {
      ...this.key,
      page: {
        objectIds: [...new Set(nominations.map((n) => n.objectId))],
        nominationIds: nominations.map((n) => n.nominationId),
        orgIds: page.filter((t) => t.targetKind === 'org_health').map((t) => t.targetId),
        fieldCodes: [
          'kind',
          'direction',
          'orgId',
          'positionId',
          'successorEmployeeId',
          'readinessId',
          'readinessCode',
          'syncEligible',
        ],
      },
    });
    if (source.runStatus === 'superseded') throw new PlanFailure('RUN_SUPERSEDED');
    if (!source.ok) throw new PlanFailure(source.reason ?? 'SOURCE_UNAVAILABLE');
    await writerAccess(this.deps, tx, this.key.tenantId, this.timezone);
    // 与 A2 / A3 同序；不能在前一目标写完后才取后一目标的员工锁或目标锁。
    const employees = [...new Set(nominations.filter(openItem).map((n) => n.successorEmployeeId))].sort();
    for (const id of employees)
      await tx.execute(sql`SELECT id FROM employment_employees
      WHERE tenant_id=${this.key.tenantId}::uuid AND id=${id}::uuid FOR SHARE`);
    await lockTargets(
      tx,
      this.key.tenantId,
      page.map((t) => ({
        kind: t.targetKind === 'position' ? 'position' : 'org',
        id: t.targetId,
      })),
    );
    // 等锁期间可能撤权，不能复用锁前 targetAccess 的范围缓存。
    const writer = await writerAccess(this.deps, tx, this.key.tenantId, this.timezone);
    return { batch: this.batch, writer, denied: source.forbidden, now: this.deps.clock(), commandId };
  }
  async page(tx: Tx, page: SyncTarget[], pageNo: number, commandId: string) {
    await this.deps.port.assertExecutionActive(tx, this.key); // 必须为页事务第一步。
    const [batch] = await this.load(tx, true);
    if (batch!.nextPageNo !== pageNo) {
      const proof = await this.deps.port.getPageCommit(tx, { ...this.key, pageCommandId: commandId });
      if (proof?.kind !== 'execute' || proof.executionNo !== this.key.executionNo)
        throw new PlanFailure('STORAGE_UNAVAILABLE');
      return batch!;
    }
    const ctx = await this.prepare(tx, page, commandId);
    const rows = [];
    const objectIds: string[] = [];
    for (const peek of page) {
      const [target] = await tx
        .select()
        .from(targets)
        .where(and(eq(targets.tenantId, this.key.tenantId), eq(targets.id, peek.id)))
        .for('update');
      if (!target || !openTarget(target)) continue;
      // D4 接实际健康度写回；未接通时整页 A 类失败，不制造成功回执。
      if (target.targetKind === 'org_health') throw new PlanFailure('SOURCE_UNAVAILABLE');
      const nominations = (
        await tx
          .select()
          .from(items)
          .where(and(eq(items.tenantId, this.key.tenantId), inArray(items.id, [...target.plannedItemIds])))
          .orderBy(items.nominationId)
          .for('update')
      ).filter(openItem);
      const result = await tx
        .transaction((sp) => executeTarget(sp, ctx, target, nominations))
        .catch((error: unknown) => {
          const failure = error instanceof PlanFailure ? error : new PlanFailure('STORAGE_UNAVAILABLE');
          return {
            failure,
            ended: [],
            results: nominations.map((item) => ({ item, outcome: 'failed' as const, failure })),
          };
        });
      rows.push(...(await persistTarget(tx, ctx, target, result)));
      objectIds.push(...nominations.map((n) => n.objectId));
    }
    rows.push(...(await objectOutcomes(tx, ctx, this.deps.port, objectIds)));
    await this.deps.port.recordOutcome(tx, { ...this.key, pageNo, pageCommandId: commandId, items: rows });
    return save(
      tx,
      batch!,
      { nextPageNo: pageNo + 1, status: 'executing', blockReason: null },
      ctx.now,
      commandId,
      'execute',
    );
  }
  async finish(tx: Tx) {
    await mutex(tx, this.key.tenantId);
    if ((await this.next(tx)).length) {
      await this.deps.port.assertExecutionActive(tx, { ...this.key, requireSealed: false });
      const [batch] = await this.load(tx, true);
      return save(
        tx,
        batch!,
        { status: 'blocked', blockReason: 'STORAGE_UNAVAILABLE' },
        this.deps.clock(),
        `${this.key.runId}:succession:${this.key.executionNo}:blocked`,
        'blocked',
      );
    }
    const state = await this.deps.port.completeConsumption(tx, this.key);
    const [batch] = await this.load(tx, true);
    if (batch!.status === 'completed') return batch!;
    const now = this.deps.clock();
    const completed = await save(
      tx,
      batch!,
      {
        status: 'completed',
        blockReason: null,
        result: state.counts.failed ? 'partial' : 'succeeded',
        finishedAt: now,
      },
      now,
      `${this.key.runId}:succession:${this.key.executionNo}:complete`,
      'complete',
    );
    await release(tx, completed);
    await notify(tx, completed, now);
    const orgs = await tx
      .select({ id: targets.targetId })
      .from(targets)
      .where(
        and(eq(targets.tenantId, this.key.tenantId), eq(targets.batchId, batch!.id), eq(targets.targetKind, 'org')),
      );
    await enqueueCalcRun(
      tx,
      {
        tenantId: this.key.tenantId,
        kind: 'org_health',
        trigger: 'review_sync',
        commandId: `${batch!.id}:org_health`,
        batchId: batch!.id,
        requestedBy: null,
        businessDate: batch!.businessDate,
        objects: orgs.map((o) => ({ objectType: 'org', objectId: o.id })),
        scope: { sourceBatchId: batch!.id },
      },
      now,
    );
    return completed;
  }
  async fail(tx: Tx, error: unknown) {
    const code = error instanceof PlanFailure || error instanceof SyncPortError ? error.code : 'STORAGE_UNAVAILABLE';
    if (code === 'RUN_SUPERSEDED') {
      await mutex(tx, this.key.tenantId);
      const [batch] = await this.load(tx, true);
      if (['completed', 'terminated', 'rejected'].includes(batch!.status)) return batch!;
      return terminateLocal(tx, batch!, 'superseded', this.deps.clock(), `${this.key.runId}:superseded`);
    }
    // 新执行接管或终止后，旧 worker 不得再以错误处理覆盖批次。
    try {
      await this.deps.port.assertExecutionActive(tx, { ...this.key, requireSealed: false });
    } catch (inactive) {
      if (inactive instanceof SyncPortError && inactive.code === 'EXECUTION_INACTIVE') return (await this.load(tx))[0]!;
      throw inactive;
    }
    const [batch] = await this.load(tx, true);
    return save(
      tx,
      batch!,
      { status: 'blocked', blockReason: code },
      this.deps.clock(),
      `${this.key.runId}:succession:${this.key.executionNo}:blocked`,
      'blocked',
    );
  }
}
export async function executeSyncBatch(deps: SyncDeps, input: SyncInput, batch: SyncBatch) {
  const tenant = await getTenant(deps.db, batch.tenantId);
  return new Execution(deps, input, batch, tenant!.timezone).run();
}
