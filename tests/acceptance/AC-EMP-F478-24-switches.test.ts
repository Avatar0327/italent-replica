import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { REHIRE_SETTING } from './AC-EMP-F432-rehire-support.js';
import { RETIRE_REHIRE_SETTING, retireWorld } from './AC-EMP-F478-seniority-support.js';

const db = useTestDb();
it('AC-EMP-F478-24：开关关闭不写；开启后不回算旧业务，关闭不回退', async () => {
  const w = await retireWorld(db().db, 'off');
  const first = await w.retired();
  const old = await w.create(first.e.id, 'retire_rehire', 1);
  expect(old.record?.fields.workYearCompanyBefore).toBe(1);
  expect(await w.snapshots(old.id)).toBe(0);
  await w.setting(RETIRE_REHIRE_SETTING, true);
  expect((await w.s.record(old.id)).fields.workYearCompanyBefore).toBe(1);
  const next = await w.retired();
  const auto = await w.create(next.e.id, 'retire_rehire', 1);
  expect(auto.record?.fields.workYearCompanyBefore).toBe(3);
  await w.setting(RETIRE_REHIRE_SETTING, false);
  expect((await w.s.record(auto.id)).fields.workYearCompanyBefore).toBe(3);
  const last = await w.retired();
  expect((await w.create(last.e.id, 'retire_rehire', 1)).record?.fields.workYearCompanyBefore).toBe(1);
});

it.each([
  { label: '只开离职重聘', on: REHIRE_SETTING, leaveRehire: 3, retireRehire: 1 },
  { label: '只开退休返聘', on: RETIRE_REHIRE_SETTING, leaveRehire: 1, retireRehire: 3 },
])('AC-EMP-F478-24：$label，另一类业务不受影响', async ({ label, on, leaveRehire, retireRehire }) => {
  const w = await retireWorld(db().db, `independent-${on.includes('retire') ? 'retire' : 'rehire'}`);
  await w.setting(on, true);
  const left = await w.departed();
  const retired = await w.retired();
  const viaLeave = await w.create(left.e.id, 'rehire', 1);
  const viaRetire = await w.create(retired.e.id, 'retire_rehire', 1);
  expect(viaLeave.record?.fields.workYearCompanyBefore, label).toBe(leaveRehire);
  expect(viaRetire.record?.fields.workYearCompanyBefore, label).toBe(retireRehire);
  expect(await w.snapshots(viaLeave.id)).toBe(leaveRehire === 3 ? 1 : 0);
  expect(await w.snapshots(viaRetire.id)).toBe(retireRehire === 3 ? 1 : 0);
});

it('AC-EMP-F478-24：两开关都开，两类各按自己的前驱累计，审计动作互相区分', async () => {
  const w = await retireWorld(db().db, 'both');
  await w.setting(REHIRE_SETTING, true);
  await w.setting(RETIRE_REHIRE_SETTING, true);
  const left = await w.departed();
  const retired = await w.retired();
  const viaLeave = await w.create(left.e.id, 'rehire', 1);
  const viaRetire = await w.create(retired.e.id, 'retire_rehire', 1);
  expect([viaLeave, viaRetire].map((b) => b.record?.fields.workYearCompanyBefore)).toEqual([3, 3]);
  expect((await w.audits(viaLeave.id, 'employment.rehire.seniority')).length).toBe(1);
  expect((await w.audits(viaLeave.id, 'employment.retire_rehire.seniority')).length).toBe(0);
  expect((await w.audits(viaRetire.id, 'employment.retire_rehire.seniority')).length).toBe(1);
  expect((await w.audits(viaRetire.id, 'employment.rehire.seniority')).length).toBe(0);
});
