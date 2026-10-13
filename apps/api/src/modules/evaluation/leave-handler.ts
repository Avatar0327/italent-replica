/** C2-1b / DEC-032：DEC-447 协议持员工锁并完成 F-055 复核后，复用唯一终止内核。 */
import { sql, type Db } from '@italent/db';
import {
  runEmploymentOutboxConsumer,
  type EmploymentOutboxConsumer,
  type OutboxConsumerProbe,
  type OutboxRunOptions,
} from '../employment/outbox-consumer.js';
import { rowsOf } from './access.js';
import { inProgressSql, terminateEvaluations } from './flow-service.js';

export const evaluationLeaveProbe: OutboxConsumerProbe = {};
export const evaluationLeaveConsumer: EmploymentOutboxConsumer = {
  kind: 'evaluation_leave',
  commandPrefix: 'evaluation-leave',
  label: '评定离职终止',
  probe: evaluationLeaveProbe,
  async handle(tx, ctx, _row, record) {
    if (record.kind !== 'leave' && record.kind !== 'retirement') return { state: 'skipped', reason: 'KIND_NOT_LEAVE' };
    // 员工锁已由消费协议持有。活动先于评定，避免与完成活动的同一终止内核反序。
    const activities = rowsOf<{ id: string }>(
      await tx.execute(sql`SELECT a.id FROM ev_activities a
      WHERE a.tenant_id=${ctx.tenantId}::uuid AND EXISTS (
        SELECT 1 FROM ev_staff_evaluations e WHERE e.tenant_id=a.tenant_id AND e.activity_id=a.id
          AND e.employee_id=${record.employeeId}::uuid AND e.cycle_id=${record.staffId}::uuid
          AND ${inProgressSql('e')}) ORDER BY a.id FOR UPDATE`),
    );
    if (activities.length) {
      const ids = rowsOf<{ id: string }>(
        await tx.execute(sql`SELECT e.id FROM ev_staff_evaluations e
        WHERE e.tenant_id=${ctx.tenantId}::uuid AND e.employee_id=${record.employeeId}::uuid
          AND e.cycle_id=${record.staffId}::uuid AND ${inProgressSql('e')} ORDER BY e.id`),
      );
      // 日期交给 PostgreSQL 的租户时区转换；审计 / 通知记录的仍是实际消费时刻。
      const [effective] = rowsOf<{ at: Date | string }>(
        await tx.execute(sql`
        SELECT ${record.effectiveDate}::date::timestamp AT TIME ZONE ${ctx.timezone} AS at`),
      );
      await terminateEvaluations(
        tx,
        ctx,
        ids.map((row) => row.id),
        'leave',
        new Date(effective!.at),
      );
    }
    return { state: 'done', reason: null };
  },
};

/** 真正的单租户取数循环，复用状态队列、重试及持锁后复核，不在处理器再实现一份。 */
export function runEvaluationLeave(db: Db, tenantId: string, options: OutboxRunOptions = {}) {
  return runEmploymentOutboxConsumer(db, tenantId, evaluationLeaveConsumer, options);
}
