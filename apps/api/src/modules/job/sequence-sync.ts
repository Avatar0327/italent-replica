import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { authorizeInTransaction } from '../permission/module-access.js';
import type { EmploymentWriteAccess } from './employment-port.js';
import { auditJob } from './store.js';
import type { JobWriteContext } from './types.js';
import { authorizeSequenceTargets, sequenceTargets, type SequenceSource } from './sequence-targets.js';

export const SEQUENCE_REQUESTED = 'job.sequence-sync.requested';
export interface SequenceRequest {
  readonly recipientUserId: string;
  readonly sources: readonly SequenceSource[];
  readonly targetIds: readonly string[];
}

/** 命令台账保证同键同内容；目标与 outbox 同职务变更提交。异步执行时重新验当前权限与目标状态。 */
export async function queueSequenceSync(
  tx: Tx,
  ctx: JobWriteContext,
  sources: readonly SequenceSource[],
  access?: EmploymentWriteAccess,
): Promise<string> {
  // 冻结引用集合而非“现在不同值”的集合；连续 A→B→A 入队时，第二单执行前可能已被第一单改成 B。
  const targets = await sequenceTargets(tx, ctx, sources, undefined, true);
  const changed = targets.filter((target) => target.fields.sequenceId !== target.source.sequenceId);
  if (changed.length && !access) throw new AppError('FORBIDDEN', '未提供任职写入授权，不能同步序列');
  if (access)
    await authorizeSequenceTargets(
      tx,
      {
        ...ctx,
        scope: access.scope,
        authorize: authorizeInTransaction(access.authorize, tx),
      },
      changed,
    );
  const id = randomUUID();
  const request: SequenceRequest = {
    recipientUserId: ctx.userId,
    sources,
    targetIds: targets.map((target) => target.payload.businessId),
  };
  // 数据库入队时间用于消费顺序，不能使用请求开始时间（并发请求可能先发后提交）。
  await tx.execute(sql`INSERT INTO employment_outbox
    (id,tenant_id,object_type,object_id,event_type,payload,command_id,created_at)
    VALUES (${id},${ctx.tenantId},'job-sequence-sync',${id},${SEQUENCE_REQUESTED},
      ${JSON.stringify({ after: request })}::jsonb,${ctx.commandId},clock_timestamp())`);
  await tx.execute(sql`INSERT INTO employment_outbox_attempts(tenant_id,outbox_id,attempt_no,state)
    VALUES (${ctx.tenantId},${id},1,'pending')`);
  await auditJob(tx, ctx, SEQUENCE_REQUESTED, 'job-sequence-sync', id, null, request);
  return id;
}
