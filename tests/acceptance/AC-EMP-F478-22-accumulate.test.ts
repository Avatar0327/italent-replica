import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { handTenure, RETIRE_REHIRE_SETTING, retireWorld } from './AC-EMP-F478-seniority-support.js';

const db = useTestDb();
it('AC-EMP-F478-22：开关开，退休后返聘落地写 tenure(入职, 最后工作日, 校正值)；版本链 +1、快照 1 行、审计 1 条', async () => {
  const w = await retireWorld(db().db, 'accumulate');
  await w.setting(RETIRE_REHIRE_SETTING, true);
  for (const correction of [0, 1]) {
    const prior = await w.retired();
    const expected = handTenure('2023-01-01', '2024-01-01', 2);
    expect(expected).toBe(3);
    const rehire = await w.create(prior.e.id, 'retire_rehire', correction);
    expect(rehire.record?.fields.workYearCompanyBefore).toBe(expected);
    expect(await w.versions(rehire.id)).toEqual([correction, expected]);
    expect(await w.snapshots(rehire.id)).toBe(1);
    const audits = await w.audits(rehire.id, 'employment.retire_rehire.seniority');
    expect(audits).toEqual([
      { before: { workYearCompanyBefore: correction }, after: { workYearCompanyBefore: expected } },
    ]);
    // 与离职重聘的审计动作区分，且退休段自己的校正值不被改写
    expect(await w.audits(rehire.id, 'employment.rehire.seniority')).toEqual([]);
    expect((await w.s.record(prior.retirement.id)).fields.workYearCompanyBefore).toBe(2);
  }
});

it('AC-EMP-F478-22：非整年与前段校正值按 2.29 → 3.2 一位向下舍位；后续同周期业务继承累计值', async () => {
  const w = await retireWorld(db().db, 'rounding');
  const prior = await w.retired();
  const changed = await w.s.request('PATCH', `/records/${prior.retirement.id}`, {
    ifMatch: prior.retirement.revision,
    body: { fields: { workYearCompanyBefore: 2.29 } },
  });
  expect(changed.status, await changed.clone().text()).toBe(200);
  await w.setting(RETIRE_REHIRE_SETTING, true);
  const rehire = await w.create(prior.e.id, 'retire_rehire', 1);
  expect(rehire.record?.fields.workYearCompanyBefore).toBe(handTenure('2023-01-01', '2024-01-01', 2.29));
  expect(rehire.record?.fields.workYearCompanyBefore).toBe(3.2);
  const next = await w.s.business(
    prior.e.id,
    { kind: 'org_adjustment', mode: 'direct', effectiveDate: '2026-10-02', fields: { remarks: '合成后继' } },
    rehire.employeeRevision,
  );
  expect(next.record?.fields.workYearCompanyBefore).toBe(3.2);
});
