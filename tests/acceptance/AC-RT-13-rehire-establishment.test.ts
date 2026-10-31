/**
 * R2-T04 BE-5b 返工（#464 第 1 轮 P2-1）/ AC-RT-13：同时返聘生效必须过严格编制校验（设计 §8.3 第 3 步“编制与部门可用性”）。
 * 返聘任职在生效保存点内走真实容量检查（establishment/employment-check.ts 单一入口，retire_rehire 与调动、实习转正同口径）：
 * 目标部门严格编制已满 → 整个退休生效回滚，记 RETIREMENT_REHIRE_FAILED（detail.rule = ESTABLISHMENT_EXCEEDED），HR 待办可见；
 * 释放容量后重试只生成一次返聘。返聘回到原部门（编制被本人占满）不算超编：原任职止于 E′，返聘始于 E′ + 1。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { retirementCancelWorld } from './AC-RT-cancel-support.js';
import { withRehire } from './AC-RT-rehire-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
async function world(label: string) {
  return withRehire(database().db, await retirementCancelWorld(database().db, label, TODAY), TODAY);
}

describe('AC-RT-13 同时返聘的严格编制校验', () => {
  it('目标部门严格编制已满：生效失败整套回滚；释放容量后重试只生成一次返聘', async () => {
    const x = await world('rt13-establishment');
    // x.to 严格编制 1，另一人 10-06 起占满
    const occupant = await x.newcomer('占编者');
    expect((await x.transferInto(occupant.id, x.to.id, TODAY)).status).toBe(201);
    const oldContract = await x.createContract(await x.contractType('合成合同类型'));

    // L = 10-04：E 已过，保存当场进入生效链（E′ = 10-06、R = 10-07），返聘落在已满的 x.to
    const retire = await x.createdRehire(x.rehireBody('2026-10-04', 'direct'));

    expect(retire.status).toBe('approved');
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire']);
    expect(await x.cycles()).toHaveLength(1);
    expect(await x.extension(retire.id)).toMatchObject({ re_employed: true, rehire_business_id: null });
    expect(await x.rehireEffects(retire.id)).toEqual([]);
    expect(await x.audits(retire.id, 'employment.retirement.rehired')).toEqual([]);
    expect(await x.audits(retire.id, 'employment.retirement.effective')).toEqual([]);
    expect((await x.retirementDates()).actual).toBeNull();
    expect(await x.contractStarts()).toEqual([
      expect.objectContaining({ id: oldContract.id, status: 'valid', actual: null }),
    ]);
    const attempts = await x.attempts(retire.id);
    expect(attempts.map((row) => [row.outcome, row.reason])).toEqual([['failed', 'RETIREMENT_REHIRE_FAILED']]);
    expect(attempts[0]!.detail).toMatchObject({ rule: 'ESTABLISHMENT_EXCEEDED' });
    expect((await x.todos()).map((todo) => todo.id)).toContain(retire.id);

    // 释放容量：占编者 10-07 起调走（返聘日 10-07 起 x.to 有空位），HR 重试一次成功
    expect((await x.transferInto(occupant.id, x.other.id, '2026-10-07')).status).toBe(201);
    const retried = await x.retry(retire, `${TODAY}T03:00:00Z`);
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect((await x.business(retire.id)).status).toBe('effective');
    const rehireId = (await x.extension(retire.id))!.rehire_business_id;
    expect(rehireId).toBeTruthy();
    expect((await x.timeline()).filter((row) => row.kind === 'retire_rehire').map((row) => row.record_id)).toEqual([
      rehireId,
    ]);
    expect(await x.rehireEffects(retire.id)).toHaveLength(1);
    expect(await x.audits(retire.id, 'employment.retirement.rehired')).toHaveLength(1);
    expect((await x.attempts(retire.id)).map((row) => row.outcome)).toEqual(['failed', 'effective']);
  });

  it('返聘回到原部门（编制被本人占满）：原任职止于 E′，返聘始于 E′ + 1，不算超编', async () => {
    const x = await world('rt13-same-department');
    const retire = await x.createdRehire(
      x.rehireBody('2026-10-04', 'direct', x.rehirePlan({ departmentId: x.from.id })),
    );
    expect(retire.status).toBe('effective');
    expect((await x.timeline()).map((row) => [row.kind, row.start_date])).toEqual([
      ['hire', '2026-09-01'],
      ['retirement', '2026-10-06'],
      ['retire_rehire', '2026-10-07'],
    ]);
  });
});
