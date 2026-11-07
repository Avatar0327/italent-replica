import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { rehireWorld } from './AC-EMP-F432-rehire-support.js';

const db = useTestDb();
it('AC-EMP-F432-08：开启后重聘一次性写上一段 3.0；不回算旧业务，关闭不回退且新重聘保留手工值', async () => {
  const w = await rehireWorld(db().db, 'toggle');
  const first = await w.departed();
  const old = await w.create(first.e.id);
  expect(old.record?.fields.workYearCompanyBefore).toBe(1);
  await w.setting(true);
  expect((await w.s.record(old.id)).fields.workYearCompanyBefore).toBe(1);
  const next = await w.departed();
  const auto = await w.create(next.e.id);
  expect(auto.record?.fields.workYearCompanyBefore).toBe(3);
  expect(await w.versions(auto.id)).toEqual([1, 3]);
  expect((await w.s.record(next.leave.id)).fields.workYearCompanyBefore).toBe(2);
  await w.setting(false);
  expect((await w.s.record(auto.id)).fields.workYearCompanyBefore).toBe(3);
  const last = await w.departed();
  expect((await w.create(last.e.id)).record?.fields.workYearCompanyBefore).toBe(1);
});

it('AC-EMP-F432-09：以业务落地时开关为准，审批通过未生效不写；开后才落地累计、落地前关闭不累计', async () => {
  const w = await rehireWorld(db().db, 'activation');
  const first = await w.departed();
  const planned = await w.create(first.e.id, 1, 'application', '2026-10-05');
  const approved = await w.approve(planned);
  expect(approved.status).toBe('approved');
  expect(await w.versions(planned.id)).toEqual([1]);
  await w.setting(true);
  const effective = await w.transition(approved, 'activate', '2026-10-05T01:00:00Z');
  expect(effective.record?.fields.workYearCompanyBefore).toBe(3);
  const second = await w.departed();
  const pending = await w.approve(await w.create(second.e.id, 1, 'application', '2026-10-06'));
  await w.setting(false);
  const off = await w.transition(pending, 'activate', '2026-10-06T01:00:00Z');
  expect(off.record?.fields.workYearCompanyBefore).toBe(1);
});

it('AC-EMP-F432-10：上一段取离职快照与最后工作日；后续同周期继承；重聘开关不管实习转正（转正归 DEC-797 独立开关）', async () => {
  const w = await rehireWorld(db().db, 'snapshot');
  const prior = await w.departed();
  const changed = await w.s.request('PATCH', `/records/${prior.leave.id}`, {
    ifMatch: prior.leave.revision,
    body: { fields: { workYearCompanyBefore: 2.29 } },
  });
  expect(changed.status).toBe(200);
  await w.setting(true);
  const auto = await w.create(prior.e.id, 1);
  expect(auto.record?.fields.workYearCompanyBefore).toBe(3.2);
  const next = await w.s.business(
    prior.e.id,
    {
      kind: 'org_adjustment',
      mode: 'direct',
      effectiveDate: '2026-10-02',
      fields: { remarks: '合成后继' },
    },
    auto.employeeRevision,
  );
  expect(next.record?.fields.workYearCompanyBefore).toBe(3.2);
  const intern = await w.s.employee();
  const hired = await w.s.business(
    intern.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2025-01-01',
      fields: { employType: 'intern', workYearCompanyBefore: 1 },
    },
    intern.revision,
  );
  const regularized = await w.s.business(
    intern.id,
    {
      kind: 'intern_regularization',
      mode: 'direct',
      effectiveDate: '2026-10-01',
    },
    hired.employeeRevision,
  );
  // 重聘开关打开不影响转正的写法；转正的入职日与校正值由 F-480 的独立开关决定（默认开：1 + 638 天 / 365 → 2.7）
  expect(regularized.record).toMatchObject({ entryDate: '2026-10-01', fields: { workYearCompanyBefore: 2.7 } });
});
