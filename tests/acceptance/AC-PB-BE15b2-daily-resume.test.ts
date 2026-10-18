/**
 * BE-15b2 第 1 轮 P2-1：每日批次“分段推进”（docs/02_业务建模/29 PB-R17，AC-PB-06；DEC-539①、DEC-052）。
 * 当天批次不能先永久占用——员工被他人持锁而跳过、或存储临时出错时，同一业务日的后续调度要继续推进这些员工，
 * 全部处理完才算当天完成；仍按租户当地业务日判定，次日不补发昨天的考核（只在第 N 天命中）。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as assessment from '../../apps/api/src/modules/employment/assessment.js';
import { autoAssessmentWorld } from './AC-PB-BE15b2-support.js';

const testDb = useTestDb();
const DAY = '2026-10-01T01:00:00.000Z';
const NEXT_DAY = '2026-10-01T20:30:00.000Z';

afterEach(() => vi.restoreAllMocks());

describe('存储临时出错后同日恢复', () => {
  it('某员工发起时存储出错：首次批次记 errors、当天未完成；同日下一时槽自动发起一次，再调度不重复，次日不补发', async () => {
    const w = await autoAssessmentWorld(testDb().db, 'resume-error');
    await w.created(w.body());
    const flaky = await w.probationer('出错员工');
    const fine = await w.probationer('正常员工');
    await w.enableSwitch();
    const original = assessment.launchAssessment;
    let failedOnce = false;
    vi.spyOn(assessment, 'launchAssessment').mockImplementation(async (tx, ctx, launch) => {
      if (launch.employeeId === flaky.employeeId && !failedOnce) {
        failedOnce = true;
        throw new Error('存储暂不可用（测试注入）');
      }
      return original(tx, ctx, launch);
    });
    const first = await w.batch(DAY);
    expect(first).toMatchObject({ ran: true, failed: [] });
    expect(first.errors).toEqual([{ employeeId: flaky.employeeId, code: 'INTERNAL_ERROR' }]);
    expect(first.launched.map((item) => item.employeeId)).toEqual([fine.employeeId]);
    expect(await w.assessmentsOf(flaky.employeeId)).toEqual([]);

    const second = await w.batch(DAY);
    expect(second).toMatchObject({ ran: true, errors: [], failed: [] });
    expect(second.launched.map((item) => item.employeeId)).toEqual([flaky.employeeId]);
    // 全部处理完当天才算完成；再调度不重复，也不重扫
    expect(await w.batch(DAY)).toMatchObject({ ran: false });
    expect(await w.assessmentsOf(flaky.employeeId)).toHaveLength(1);
    expect(await w.assessmentsOf(fine.employeeId)).toHaveLength(1);
    // 次日是第 31 天：不补发昨天的考核
    expect(await w.batch(NEXT_DAY)).toMatchObject({ ran: true, launched: [], failed: [] });
    expect(await w.assessmentsOf(flaky.employeeId)).toHaveLength(1);
  });
});

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('员工被他人持锁而跳过后同日恢复（真 PG）', () => {
  it('两连接：持锁时首次批次确实跳过 → 释放锁 → 同日下一时槽发起一次 → 再调度不重复 → 次日不补发', async () => {
    const w = await autoAssessmentWorld(testDb().db, 'resume-locked');
    await w.created(w.body());
    const person = await w.probationer('被锁员工');
    await w.enableSwitch();

    let locked!: () => void;
    let release!: () => void;
    const holding = new Promise<void>((done) => (locked = done));
    const gate = new Promise<void>((done) => (release = done));
    // 另一连接持有该员工的行锁（等价于手工办理 / 其他实例正在处理他）
    const holder = withTenant(w.db, w.tenant.id, async (tx) => {
      await tx.execute(sql`SELECT id FROM employment_employees
        WHERE tenant_id=${w.tenant.id} AND id=${person.employeeId}::uuid FOR UPDATE`);
      locked();
      await gate;
    });
    await holding;
    const first = await w.batch(DAY);
    expect(first).toMatchObject({ ran: true, skippedLocked: 1, launched: [], failed: [], errors: [] });
    release();
    await holder;
    expect(await w.assessmentsOf(person.employeeId)).toEqual([]);

    const second = await w.batch(DAY);
    expect(second).toMatchObject({ ran: true, skippedLocked: 0, errors: [], failed: [] });
    expect(second.launched.map((item) => item.employeeId)).toEqual([person.employeeId]);
    expect(await w.batch(DAY)).toMatchObject({ ran: false });
    expect(await w.assessmentsOf(person.employeeId)).toHaveLength(1);
    expect(await w.batch(NEXT_DAY)).toMatchObject({ ran: true, launched: [], failed: [] });
    expect(await w.assessmentsOf(person.employeeId)).toHaveLength(1);
  });
});
