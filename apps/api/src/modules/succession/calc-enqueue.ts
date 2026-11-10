/**
 * 计算 run 的冻结入队与 run 审计（叶模块，F-512）：enqueueCalcRun 及其共用小函数原在 calc-worker.ts。
 * exit-sweep（A3 生产者 / 处理器）顶层被 calc-contract 的 SUCCESSION_CALC_KINDS 读取，却要调 enqueueCalcRun；calc-worker 又为
 * runCalcPage 的默认参数引用 calc-contract，三者成环，以 exit-sweep 为首个入口时 calc-contract 读到未初始化的
 * EXIT_SWEEP_HANDLER。本文件只依赖 calc-contract-core / 库，不引用 calc-contract 登记表，不在环上。
 * calc-worker 对 enqueueCalcRun 原名再导出。
 */
import { createHash } from 'node:crypto';
import { and, eq, isUuid, successionCalcRunObjects as objects, successionCalcRuns as runs, type Tx } from '@italent/db';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { calcKey, type CalcInput, type CalcRun } from './calc-contract-core.js';

export const conflict = (reason: string) => new AppError('CONFLICT', '计算任务状态冲突', { reason });
export const uuid = (id: string) => {
  if (!isUuid(id)) throw new TypeError('计算对象 ID 非法');
  return id.toLowerCase();
};
export const objectType = (kind: CalcInput['kind']) => {
  if (kind === 'exit_sweep') return 'employee';
  return kind === 'position_risk' ? 'position' : 'org';
};

export async function audit(tx: Tx, run: CalcRun, before: unknown, now: Date, commandId = run.commandId) {
  await recordAudit(tx, {
    tenantId: run.tenantId,
    actorUserId: null,
    objectType: 'Succession.CalcRun',
    objectId: run.id,
    action: 'succession.calc_run',
    commandId,
    occurredAt: now,
    before,
    after: { status: run.status, attemptNo: run.attemptNo, phase: run.phase, blockReason: run.blockReason },
  });
}
/** 在调用方的命令/调度事务内冻结集合。调用方先授权，不接受未经校验的 HTTP 输入。
 * A3/C1 在自身 SUCCESSION_JOBS 中生成输入；调度时间传 now/timezone，businessDate 必须为同一租户日期。
 * manual 的同键异内容冲突；定时同槽已存在则保留首次冻结集合（不能因后来成员变化扩大集合）。 */
export async function enqueueCalcRun(tx: Tx, input: CalcInput, now: Date): Promise<string> {
  const normalized = {
    ...input,
    tenantId: uuid(input.tenantId),
    requestedBy: input.requestedBy ? uuid(input.requestedBy) : null,
    batchId: input.batchId ? uuid(input.batchId) : undefined,
  };
  const key = calcKey(normalized);
  if (!input.commandId.trim()) throw new TypeError('命令 ID 不得为空');
  const scope = {
    ...(input.scope?.rootOrgId ? { rootOrgId: uuid(input.scope.rootOrgId) } : {}),
    ...(input.scope?.sourceBatchId ? { sourceBatchId: uuid(input.scope.sourceBatchId) } : {}),
  };
  const frozen = input.objects
    .map((o) => ({
      objectType: o.objectType,
      objectId: uuid(o.objectId),
      expectedRevision: o.expectedRevision ?? null,
    }))
    .sort((a, b) => a.objectId.localeCompare(b.objectId));
  if (
    new Set(frozen.map((o) => o.objectId)).size !== frozen.length ||
    frozen.some(
      (o) =>
        o.objectType !== objectType(input.kind) ||
        (o.expectedRevision !== null && (!Number.isSafeInteger(o.expectedRevision) || o.expectedRevision < 0)) ||
        (input.kind === 'org_health_reset' && o.expectedRevision === null),
    )
  )
    throw new TypeError('冻结对象类型、revision 或唯一性非法');
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        kind: input.kind,
        businessDate: input.businessDate,
        requestedBy: normalized.requestedBy,
        objects: frozen,
        scope,
      }),
    )
    .digest('hex');
  const [created] = await tx
    .insert(runs)
    .values({
      tenantId: normalized.tenantId,
      kind: input.kind,
      trigger: input.trigger,
      idempotencyKey: key,
      requestHash: hash,
      scope,
      requestedBy: normalized.requestedBy,
      commandId: input.commandId,
      businessDate: input.businessDate,
    })
    .onConflictDoNothing()
    .returning();
  if (!created) {
    const [existing] = await tx
      .select()
      .from(runs)
      .where(and(eq(runs.tenantId, normalized.tenantId), eq(runs.idempotencyKey, key)));
    if (!existing || (input.trigger === 'manual' && existing.requestHash !== hash))
      throw conflict('IDEMPOTENCY_CONFLICT');
    return existing.id;
  }
  for (let offset = 0; offset < frozen.length; offset += 200)
    await tx
      .insert(objects)
      .values(
        frozen
          .slice(offset, offset + 200)
          .map((o) => ({ ...o, tenantId: created.tenantId, runId: created.id, pageNo: offset / 200 })),
      );
  await audit(tx, created, null, now);
  return created.id;
}
