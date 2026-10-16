/**
 * AC-DM-19 / B-67 附带的数据层（R2-T03 设计 §2.1 / §2.4）：租户路径（app_user + RLS）下的列级授权、只追加与约束。
 * 扩展行只可改非日期业务字段与系统补写字段；效果台账只追加；撤销记录只可改撤销原因；三张表都不可删除；跨租户不可见。
 * 只用 SQL 断言（不依赖新增的 schema 导出），表或约束缺失时是断言失败。
 */
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { exitWorld } from './AC-EXIT-support.js';

const testDb = useTestDb();
const DENIED = /permission denied/;

describe('AC-DM-19 / B-67 离职数据表（R2-T03 B1a）', () => {
  it('扩展行：非日期业务字段可改；业务 / 员工 / 周期 / 发起方式 / 批次 / 转交时机快照不可改；约束生效；不可删除', async () => {
    const w = await exitWorld(testDb().db, 'data-request');
    const seeded = await w.seedExitBusiness();
    expect(seeded.error).toBeUndefined();
    const where = sql`tenant_id = ${w.tenant.id} AND business_id = ${seeded.business.id}`;
    const update = (set: ReturnType<typeof sql>) => w.attempt(sql`UPDATE exit_requests SET ${set} WHERE ${where}`);
    expect(await update(sql`exit_type_code = 'voluntary', pre_release_date = '2026-09-01'`)).toBeUndefined();
    for (const column of ['staff_id', 'employee_id', 'initiator_user_id', 'batch_id']) {
      expect(await update(sql`${sql.identifier(column)} = gen_random_uuid()`), column).toMatch(DENIED);
    }
    for (const column of ['mode', 'initiator', 'duty_transfer_timing']) {
      expect(await update(sql`${sql.identifier(column)} = 'approval_passed'`), column).toMatch(DENIED);
    }
    for (const [set, constraint] of [
      [sql`attachment_refs = '{"a":1}'::jsonb`, 'exit_requests_attachments'],
      [sql`compensation_amount = -1`, 'exit_requests_amounts'],
      [sql`social_insurance_end_month = '2026-13'`, 'exit_requests_months'],
      [sql`tax_year = 12345`, 'exit_requests_tax_year'],
    ] as const) {
      expect(await update(set)).toMatch(constraint);
    }
    expect(await w.attempt(sql`DELETE FROM exit_requests WHERE ${where}`)).toMatch(DENIED);
    const direct = await w.seedExitBusiness({ initiator: 'self' });
    expect(direct.error).toMatch(/exit_requests_direct_by_hr/);
  });

  it('效果台账只追加；撤销记录只可改原因与 revision，同一业务至多一行；跨租户不可见', async () => {
    const w = await exitWorld(testDb().db, 'data-ledger');
    const other = await exitWorld(testDb().db, 'data-ledger-other');
    const { business, employee, error } = await w.seedExitBusiness();
    expect(error).toBeUndefined();
    const base = sql`${w.tenant.id}, ${business.id}, ${employee.id}`;
    const effect = sql`INSERT INTO exit_effects(tenant_id, business_id, employee_id, phase, kind, target_type,
      command_id) VALUES(${base}, 'confirmed', 'establishment_pre_released', 'employment_cycle', 'cmd-1')`;
    const cancel = (reason: string) => sql`INSERT INTO exit_cancellations(tenant_id, business_id, employee_id,
      state_before, cancel_case, reason, command_id, actor_user_id)
      VALUES(${base}, 'effective', 'record_deleted', ${reason}, 'cmd-1', ${w.user.id})`;
    expect(await w.attempt(effect)).toBeUndefined();
    expect(await w.attempt(cancel('误操作'))).toBeUndefined();
    const own = sql`tenant_id = ${w.tenant.id} AND business_id = ${business.id}`;
    expect(await w.attempt(sql`UPDATE exit_effects SET kind = 'duty_failed' WHERE ${own}`)).toMatch(DENIED);
    expect(await w.attempt(sql`DELETE FROM exit_effects WHERE ${own}`)).toMatch(DENIED);
    expect(
      await w.attempt(sql`UPDATE exit_cancellations SET reason = '补充', revision = 2 WHERE ${own}`),
    ).toBeUndefined();
    expect(await w.attempt(sql`UPDATE exit_cancellations SET cancel_case = 'approved_voided' WHERE ${own}`)).toMatch(
      DENIED,
    );
    expect(await w.attempt(sql`DELETE FROM exit_cancellations WHERE ${own}`)).toMatch(DENIED);
    expect(await w.attempt(cancel('再撤一次'))).toMatch(/exit_cancellations_business/);
    // 另一租户的事务里，按本租户的业务 ID 查不到行（RLS）：用除零把“查到了”变成错误文本
    const probe = sql`SELECT 1 / (SELECT count(*) FROM exit_effects WHERE business_id = ${business.id})::int`;
    expect(await w.attempt(probe)).toBeUndefined();
    expect(await w.attempt(probe, other.tenant.id)).toMatch(/division by zero/);
  });
});
