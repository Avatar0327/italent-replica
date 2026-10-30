/**
 * R2-T04 BE-5b / AC-RT-13：同时返聘失败原子性（设计 §8.3 第 6 步）。
 * 返聘生成在 runSteps 的保存点内：任一步失败（这里是返聘部门在返聘日已停用）整个退休生效回滚，只留一条 failed 尝试，
 * 不出现“已退休、未返聘”的半套；HR 待办可见，修正（撤销停用）后重试一次成功。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { seedLegacyOrgDeactivation } from './AC-TRF-activation-support.js';
import { rehireWorld } from './AC-RT-rehire-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const world = (label: string) => rehireWorld(database().db, label, TODAY);

describe('AC-RT-13 同时返聘失败原子性', () => {
  it('返聘部门 R 日已停用：退休生效失败、无退休记录、无返聘、合同未终止；撤销停用后重试成功', async () => {
    const x = await world('rt13-atomic');
    const master = await x.contractMaster();
    const oldContract = await x.createContract(master.typeId);
    // L = 10-15 → E = 10-16；到期按时执行时 E′ = 10-16、R = 10-17
    const retire = await x.createdRehire(
      x.rehireBody('2026-10-15', 'direct', x.rehirePlan({ contract: x.contractPlan(master) })),
    );
    expect(retire.status).toBe('approved');
    await seedLegacyOrgDeactivation(x, '2026-10-17', x.to);

    expect(await x.runScheduler('2026-10-16T01:00:00Z')).toMatchObject({ activated: [], failed: [retire.id] });

    // 保存点回滚：时间轴、合同、扩展行、返聘台账与审计都没有变化（只多一条 failed 尝试）
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire']);
    expect(await x.cycles()).toHaveLength(1);
    expect(await x.contractStarts()).toEqual([
      expect.objectContaining({ id: oldContract.id, status: 'valid', actual: null }),
    ]);
    expect(await x.extension(retire.id)).toMatchObject({ re_employed: true, rehire_business_id: null });
    expect(await x.rehireEffects(retire.id)).toEqual([]);
    expect(await x.audits(retire.id, 'employment.retirement.rehired')).toEqual([]);
    expect(await x.audits(retire.id, 'employment.retirement.effective')).toEqual([]);
    expect((await x.retirementDates()).actual).toBeNull();
    expect(await x.employeeStatusOf(retire.id)).toBeUndefined();
    const attempts = await x.attempts(retire.id);
    expect(attempts.map((row) => [row.outcome, row.reason])).toEqual([['failed', 'RETIREMENT_REHIRE_FAILED']]);
    expect(attempts[0]!.detail).toMatchObject({ message: expect.any(String) });
    expect((await x.todos()).map((todo) => todo.id)).toContain(retire.id);

    // 修正：撤销该部门的停用，HR 重试一次成功，返聘日 = E′ + 1 = 10-17
    await seedLegacyOrgDeactivation(x, '2026-10-17', x.to, true);
    x.setNow('2026-10-16T02:00:00Z');
    const retried = await x.retry(retire, '2026-10-16T03:00:00Z');
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect((await x.business(retire.id)).status).toBe('effective');
    expect((await x.timeline()).map((row) => [row.kind, row.start_date])).toEqual([
      ['hire', '2026-09-01'],
      ['retirement', '2026-10-16'],
      ['retire_rehire', '2026-10-17'],
    ]);
    expect((await x.extension(retire.id))!.rehire_business_id).toBeTruthy();
    expect((await x.attempts(retire.id)).map((row) => row.outcome)).toEqual(['failed', 'effective']);
  });
});
