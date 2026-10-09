/**
 * F-055 夹具：任职事件生效日门禁（R3-T02 实现拆分方案 §10）。
 * - 业务保存 / 删除 / 改期经真实入口（改期没有生产入口，直接挪时间轴行，等价于订阅方看到的结果）；
 * - 探针队列严格按 §10.2 的消费方约定实现：recordEventReadySql 取数 → 员工锁 → recheckRecordEvent → 更新队列；
 *   C1-4 / C2-1b 的真实调度器各自再用同一组用例重跑。
 */
import { randomUUID } from 'node:crypto';
import { APP_ROLE, sql, withTenant, type Db, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { expect } from 'vitest';
import {
  recheckRecordEvent,
  recordEventDueSql,
  recordEventReadySql,
  type RecordEventRecheck,
} from '../../apps/api/src/modules/employment/record-events.js';
import { lockEmploymentEmployee } from '../../apps/api/src/modules/employment/record-store.js';
import type { EmploymentContext } from '../../apps/api/src/modules/employment/types.js';
import { activationWorld, type ActivationWorld } from './AC-TRF-activation-support.js';

export const rowsOf = <T>(value: unknown) => (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];

export const RECORD_CREATE = 'employment.record.create';

export interface OutboxEvent {
  readonly id: string;
  readonly eventType: string;
  readonly objectId: string;
  readonly employeeId: string;
}

export type F055World = Awaited<ReturnType<typeof f055World>>;

export async function f055World(db: Db, label: string, options: { timezone?: string } = {}) {
  const w = await activationWorld(db, label, { timezone: options.timezone });
  const subject = await w.hired('生效日门禁员工');
  const tenantId = w.session.tenant.id;

  function context(at: string): EmploymentContext {
    return {
      tenantId,
      userId: w.session.user.id,
      timezone: w.session.tenant.timezone,
      now: new Date(at),
      commandId: randomUUID(),
      expectedRevision: 0,
    };
  }

  /** 直接保存一条未来 / 当天 / 过去生效的调动，返回业务单（= 任职记录）标识。 */
  async function transfer(effectiveDate: string, employeeId = subject.employee.id): Promise<string> {
    const employee = await w.session.getEmployee(employeeId);
    const business = await w.session.business(
      employeeId,
      { kind: 'transfer', mode: 'direct', effectiveDate, fields: { departmentId: w.to.id } },
      employee.revision,
    );
    expect(business.status).toBe('effective');
    return business.id;
  }

  /** 直接保存离职；生效日 = 最后工作日次日。 */
  async function leave(lastWorkDate: string, employeeId = subject.employee.id): Promise<string> {
    const employee = await w.session.getEmployee(employeeId);
    const business = await w.session.business(
      employeeId,
      { kind: 'leave', mode: 'direct', lastWorkDate },
      employee.revision,
    );
    return business.id;
  }

  async function remove(recordId: string) {
    const current = await w.business(recordId);
    const response = await w.session.request('DELETE', `/businesses/${recordId}`, { ifMatch: current.revision });
    expect(response.status).toBe(200);
  }

  /** 订阅方读到的事件行（record.create），按写入先后。 */
  async function events(recordId?: string): Promise<OutboxEvent[]> {
    return withTenant(db, tenantId, async (tx) =>
      rowsOf<OutboxEvent>(
        await tx.execute(sql`SELECT id, event_type AS "eventType", object_id AS "objectId", employee_id AS "employeeId"
          FROM employment_outbox
          WHERE tenant_id=${tenantId} AND event_type=${RECORD_CREATE}
            AND (${recordId ?? null}::uuid IS NULL OR object_id=${recordId ?? null}::uuid)
          ORDER BY created_at, id`),
      ),
    );
  }

  /** 把已落在时间轴上的记录挪到新生效日（没有生产入口，等价于改期后的时间轴状态）。 */
  async function moveTimeline(recordId: string, newDate: string) {
    await withTenant(db, tenantId, async (tx) => moveTimelineIn(tx, recordId, newDate));
  }

  async function moveTimelineIn(tx: Tx, recordId: string, newDate: string) {
    const [self] = rowsOf<{ employeeId: string }>(
      await tx.execute(sql`SELECT employee_id AS "employeeId" FROM employment_timeline
        WHERE tenant_id=${tenantId} AND record_id=${recordId}::uuid`),
    );
    expect(self).toBeDefined();
    await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
    // 前一条的区间截到新日期，自己从新日期起（与改期后的时间轴形态一致）
    await tx.execute(sql`UPDATE employment_timeline p
      SET valid_during=daterange(p.start_date, ${newDate}::date, '[)')
      WHERE p.tenant_id=${tenantId} AND p.employee_id=${self!.employeeId}::uuid
        AND upper(p.valid_during)=(SELECT start_date FROM employment_timeline
          WHERE tenant_id=${tenantId} AND record_id=${recordId}::uuid)`);
    await tx.execute(sql`UPDATE employment_timeline
      SET start_date=${newDate}::date, valid_during=daterange(${newDate}::date, upper(valid_during), '[)')
      WHERE tenant_id=${tenantId} AND record_id=${recordId}::uuid`);
  }

  /** 逐事件求值谓词：返回 事件 ID → 门禁结果。 */
  async function gate(which: 'due' | 'ready', today: string, recordId?: string): Promise<Map<string, boolean>> {
    const predicate = which === 'due' ? recordEventDueSql('e', today) : recordEventReadySql('e', today);
    return withTenant(db, tenantId, async (tx) => {
      const found = rowsOf<{ id: string; pass: boolean }>(
        await tx.execute(sql`SELECT e.id, (${predicate}) AS pass FROM employment_outbox e
          WHERE e.tenant_id=${tenantId} AND e.event_type=${RECORD_CREATE}
            AND (${recordId ?? null}::uuid IS NULL OR e.object_id=${recordId ?? null}::uuid)`),
      );
      return new Map(found.map((row) => [row.id, row.pass]));
    });
  }

  async function recheck(recordId: string, today: string): Promise<RecordEventRecheck> {
    return withTenant(db, tenantId, (tx) => recheckRecordEvent(tx, context(`${today}T04:00:00Z`), recordId, today));
  }

  return {
    ...w,
    subject,
    tenantId,
    context,
    transfer,
    leave,
    remove,
    events,
    moveTimeline,
    moveTimelineIn,
    gate,
    recheck,
  };
}

/** 探针队列：每个（事件）一行；派生表模拟订阅方写下的派生数据（子集、终止评定）。 */
export async function installProbeQueue(db: Db) {
  await db.execute(sql`CREATE TABLE f055_probe_queue (
    tenant_id uuid NOT NULL, outbox_id uuid NOT NULL, state text NOT NULL DEFAULT 'pending',
    reason text, effective_date date, PRIMARY KEY (tenant_id, outbox_id))`);
  await db.execute(sql`CREATE TABLE f055_probe_derived (
    tenant_id uuid NOT NULL, record_id uuid NOT NULL, effective_date date, PRIMARY KEY (tenant_id, record_id))`);
  for (const table of ['f055_probe_queue', 'f055_probe_derived'])
    await db.execute(sql.raw(`GRANT ALL ON ${table} TO ${APP_ROLE.tenant}`));
}

export interface ProbeStep {
  /** 复核之后、更新队列之前停一下（真 PG 交错测试用）。 */
  readonly afterRecheck?: () => Promise<void>;
  /** 取到员工锁之前停一下（制造“取数后才被删除 / 改期”的窗口）。 */
  readonly beforeLock?: () => Promise<void>;
}

/** 入队：等价于 C1-4 的 AFTER INSERT 触发器（每个事件一行，重复入队只一行）。 */
export async function probeEnqueue(db: Db, tenantId: string) {
  await withTenant(db, tenantId, (tx) =>
    tx.execute(sql`INSERT INTO f055_probe_queue (tenant_id, outbox_id)
      SELECT tenant_id, id FROM employment_outbox WHERE tenant_id=${tenantId} AND event_type=${RECORD_CREATE}
      ON CONFLICT DO NOTHING`),
  );
}

/**
 * 一轮取数循环，严格按 §10.2 消费方约定：状态队列 + recordEventReadySql 取数（不用 created_at 高水位），
 * 每行单独事务：员工锁 → 复核 → 同事务写派生数据并更新队列行。
 */
export async function probeRound(db: Db, ctx: EmploymentContext, step: ProbeStep = {}) {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const picked = await withTenant(db, ctx.tenantId, async (tx) =>
    rowsOf<{ outboxId: string; employeeId: string; recordId: string }>(
      await tx.execute(sql`SELECT q.outbox_id AS "outboxId", e.employee_id AS "employeeId", e.object_id AS "recordId"
        FROM f055_probe_queue q JOIN employment_outbox e ON e.tenant_id=q.tenant_id AND e.id=q.outbox_id
        WHERE q.tenant_id=${ctx.tenantId} AND q.state='pending' AND (${recordEventReadySql('e', today)})
        ORDER BY e.created_at, e.id`),
    ),
  );
  for (const row of picked) {
    await step.beforeLock?.();
    await withTenant(db, ctx.tenantId, async (tx) => {
      await lockEmploymentEmployee(tx, ctx, row.employeeId);
      const result = await recheckRecordEvent(tx, ctx, row.recordId, today);
      await step.afterRecheck?.();
      if (result.kind === 'effective') {
        await tx.execute(sql`INSERT INTO f055_probe_derived (tenant_id, record_id, effective_date)
          VALUES (${ctx.tenantId}, ${row.recordId}::uuid, ${result.record.effectiveDate}::date)
          ON CONFLICT DO NOTHING`);
        await updateProbe(tx, ctx.tenantId, row.outboxId, 'done', null);
      } else if (result.kind === 'gone') {
        await updateProbe(tx, ctx.tenantId, row.outboxId, 'skipped', result.reason);
      } else {
        await updateProbe(tx, ctx.tenantId, row.outboxId, 'pending', null);
      }
    });
  }
  return picked;
}

async function updateProbe(tx: Tx, tenantId: string, outboxId: string, state: string, reason: string | null) {
  await tx.execute(sql`UPDATE f055_probe_queue SET state=${state}, reason=${reason}
    WHERE tenant_id=${tenantId} AND outbox_id=${outboxId}::uuid`);
}

export async function probeState(db: Db, tenantId: string, recordId: string) {
  return withTenant(db, tenantId, async (tx) =>
    rowsOf<{ state: string; reason: string | null }>(
      await tx.execute(sql`SELECT q.state, q.reason FROM f055_probe_queue q
        JOIN employment_outbox e ON e.tenant_id=q.tenant_id AND e.id=q.outbox_id
        WHERE q.tenant_id=${tenantId} AND e.object_id=${recordId}::uuid`),
    ),
  );
}

export async function probeDerived(db: Db, tenantId: string, recordId: string) {
  return withTenant(db, tenantId, async (tx) =>
    rowsOf<{ effectiveDate: string }>(
      await tx.execute(sql`SELECT effective_date::text AS "effectiveDate" FROM f055_probe_derived
        WHERE tenant_id=${tenantId} AND record_id=${recordId}::uuid`),
    ),
  );
}

export type { ActivationWorld };
