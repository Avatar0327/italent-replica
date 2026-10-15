/**
 * R2-T03 B1a 数据层（设计 §2.1 / §2.4，B-67 附带）：租户路径（app_user + RLS）下的列级授权、只追加与约束。
 * 扩展行只可改非日期业务字段与系统补写字段；效果台账只追加；撤销记录只可改撤销原因；三张表都不可删除；跨租户不可见。
 */
import { randomUUID } from 'node:crypto';
import { and, eq, exitCancellations, exitEffects, exitRequests, sql, withTenant } from '@italent/db';
import { AUDIT_CONFIG_OBJECT_TYPES, auditObjectMeta } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { exitWorld, type ExitWorld } from './AC-EXIT-support.js';

const testDb = useTestDb();

/** 在租户事务里执行一条语句并返回错误（成功返回 undefined）；失败只回滚这个事务。 */
async function attempt(w: ExitWorld, statement: ReturnType<typeof sql>) {
  try {
    await withTenant(w.db, w.tenant.id, (tx) => tx.execute(statement));
    return undefined;
  } catch (error) {
    return String((error as { cause?: unknown }).cause ?? error);
  }
}

describe('R2-T03 B1a 离职数据表', () => {
  it('扩展行：非日期业务字段可改；业务、员工、周期、发起方式、转交时机快照不可改；不可删除', async () => {
    const w = await exitWorld(testDb().db, 'data-request');
    const { business } = await w.seedExitBusiness();
    const where = sql`tenant_id=${w.tenant.id} AND business_id=${business.id}`;
    expect(
      await attempt(
        w,
        sql`UPDATE exit_requests SET exit_type_code='voluntary', pre_release_date='2026-09-01'
      WHERE ${where}`,
      ),
    ).toBeUndefined();
    for (const column of ['staff_id', 'employee_id', 'mode', 'initiator', 'initiator_user_id', 'batch_id']) {
      const value = ['mode', 'initiator'].includes(column) ? sql`'application'` : sql`${randomUUID()}::uuid`;
      expect(await attempt(w, sql`UPDATE exit_requests SET ${sql.identifier(column)}=${value} WHERE ${where}`)).toMatch(
        /permission denied/,
      );
    }
    expect(
      await attempt(w, sql`UPDATE exit_requests SET duty_transfer_timing='approval_passed' WHERE ${where}`),
    ).toMatch(/permission denied/);
    expect(await attempt(w, sql`DELETE FROM exit_requests WHERE ${where}`)).toMatch(/permission denied/);
    const [row] = await withTenant(w.db, w.tenant.id, (tx) =>
      tx.select().from(exitRequests).where(eq(exitRequests.businessId, business.id)),
    );
    expect(row).toMatchObject({ exitTypeCode: 'voluntary', preReleaseDate: '2026-09-01', mode: 'direct' });
  });

  it('约束：直接离职只能由 HR 发起；附件引用须为数组；金额非负；月份格式', async () => {
    const w = await exitWorld(testDb().db, 'data-checks');
    const { business } = await w.seedExitBusiness();
    const where = sql`tenant_id=${w.tenant.id} AND business_id=${business.id}`;
    for (const [set, constraint] of [
      [sql`attachment_refs='{"a":1}'::jsonb`, 'exit_requests_attachments'],
      [sql`compensation_amount=-1`, 'exit_requests_amounts'],
      [sql`social_insurance_end_month='2026-13'`, 'exit_requests_months'],
      [sql`tax_year=12345`, 'exit_requests_tax_year'],
    ] as const) {
      expect(await attempt(w, sql`UPDATE exit_requests SET ${set} WHERE ${where}`)).toMatch(constraint);
    }
    const rejected = await w.seedExitBusiness({ mode: 'direct', initiator: 'self' }).catch((error: unknown) => error);
    expect(String((rejected as { cause?: unknown }).cause)).toMatch(/exit_requests_direct_by_hr/);
  });

  it('效果台账只追加；撤销记录只可改撤销原因与 revision，同一业务至多一行；跨租户不可见', async () => {
    const w = await exitWorld(testDb().db, 'data-ledger');
    const other = await exitWorld(testDb().db, 'data-ledger-other');
    const { business, employee } = await w.seedExitBusiness();
    const base = { tenantId: w.tenant.id, businessId: business.id, employeeId: employee.id, commandId: 'cmd-1' };
    await withTenant(w.db, w.tenant.id, async (tx) => {
      await tx.insert(exitEffects).values({
        ...base,
        phase: 'confirmed',
        kind: 'establishment_pre_released',
        targetType: 'employment_cycle',
      });
      await tx.insert(exitCancellations).values({
        ...base,
        stateBefore: 'effective',
        cancelCase: 'record_deleted',
        reason: '误操作',
        actorUserId: w.user.id,
      });
    });
    expect(await attempt(w, sql`UPDATE exit_effects SET kind='duty_failed' WHERE tenant_id=${w.tenant.id}`)).toMatch(
      /permission denied|只允许追加/,
    );
    expect(await attempt(w, sql`DELETE FROM exit_effects WHERE tenant_id=${w.tenant.id}`)).toMatch(
      /permission denied|只允许追加/,
    );
    const cancel = sql`tenant_id=${w.tenant.id} AND business_id=${business.id}`;
    expect(
      await attempt(w, sql`UPDATE exit_cancellations SET reason='补充原因', revision=2 WHERE ${cancel}`),
    ).toBeUndefined();
    expect(await attempt(w, sql`UPDATE exit_cancellations SET cancel_case='approved_voided' WHERE ${cancel}`)).toMatch(
      /permission denied/,
    );
    expect(await attempt(w, sql`DELETE FROM exit_cancellations WHERE ${cancel}`)).toMatch(/permission denied/);
    expect(
      await attempt(
        w,
        sql`INSERT INTO exit_cancellations(tenant_id,business_id,employee_id,state_before,cancel_case,reason,command_id,
          actor_user_id) VALUES(${w.tenant.id},${business.id},${employee.id},'effective','record_deleted','再撤一次',
          'cmd-2',${w.user.id})`,
      ),
    ).toMatch(/exit_cancellations_business/);
    const seen = await withTenant(w.db, other.tenant.id, (tx) =>
      tx
        .select()
        .from(exitEffects)
        .where(and(eq(exitEffects.businessId, business.id))),
    );
    expect(seen).toEqual([]);
  });

  it('审计登记：离职三类对象与字典有标签，字典属于配置类日志', () => {
    for (const type of ['exit-request', 'exit-cancellation', 'exit-effect', 'exit_dictionary']) {
      expect(auditObjectMeta(type).label).not.toBe(type);
    }
    expect(AUDIT_CONFIG_OBJECT_TYPES.has('exit_dictionary')).toBe(true);
    expect(AUDIT_CONFIG_OBJECT_TYPES.has('exit-request')).toBe(false);
  });
});
