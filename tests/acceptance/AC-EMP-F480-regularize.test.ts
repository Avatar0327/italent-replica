/** F-480 / DEC-797：实习转正重置入职日、保存实习开始日，并按【实习转正】累计司龄开关写司龄校正值。 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { withLoginEmail } from './AC-EMP-support.js';
import { internWorld } from './AC-EMP-F480-support.js';

const db = useTestDb();

it('AC-EMP-F480-01：默认开启——转正日覆盖入职日，实习开始日单独保存，校正值 = 实习段 638 天 / 365 向下舍位 1.7；实习段记录不动', async () => {
  const w = await internWorld(db().db, 'default');
  const { e, hire } = await w.intern('2025-01-01');
  const reg = await w.regularize(e.id, { date: '2026-10-01' });
  expect(reg.status).toBe('effective');
  expect(reg.record).toMatchObject({
    entryDate: '2026-10-01',
    traineeStartDate: '2025-01-01',
    effectiveDate: '2026-10-01',
    fields: { workYearCompanyBefore: 1.7 },
  });
  const before = await w.record(hire.id);
  expect(before).toMatchObject({
    entryDate: '2025-01-01',
    traineeStartDate: null,
    fields: { workYearCompanyBefore: 0 },
  });
  expect(before.staffId).not.toBe(reg.record!.staffId);
});

it('AC-EMP-F480-02：与既有手工校正值合并而不重复累计——手工 1 + 实习段 1.747 = 2.7', async () => {
  const w = await internWorld(db().db, 'merge');
  const { e } = await w.intern('2025-01-01', 1);
  const reg = await w.regularize(e.id);
  expect(reg.record).toMatchObject({ entryDate: '2026-10-01', fields: { workYearCompanyBefore: 2.7 } });
});

it('AC-EMP-F480-03：关闭开关——入职日与实习开始日照常处理，但不写校正值，保留原值', async () => {
  const w = await internWorld(db().db, 'off');
  await w.setting(false);
  const { e } = await w.intern('2025-01-01', 1);
  const reg = await w.regularize(e.id);
  expect(reg.record).toMatchObject({
    entryDate: '2026-10-01',
    traineeStartDate: '2025-01-01',
    fields: { workYearCompanyBefore: 1 },
  });
});

it('AC-EMP-F480-04：同周期后续业务继承转正日与校正值，不再次累计', async () => {
  const w = await internWorld(db().db, 'inherit');
  const { e } = await w.intern('2025-01-01');
  const reg = await w.regularize(e.id);
  const next = await w.s.business(
    e.id,
    { kind: 'org_adjustment', mode: 'direct', effectiveDate: '2026-10-02', fields: { remarks: '合成后继' } },
    (await w.s.getEmployee(e.id)).revision,
  );
  expect(next.record).toMatchObject({
    entryDate: '2026-10-01',
    staffId: reg.record!.staffId,
    fields: { workYearCompanyBefore: 1.7 },
  });
});

it('AC-EMP-F480-05：同一命令 ID 重放不重复累计，返回同一业务', async () => {
  const w = await internWorld(db().db, 'replay');
  const { e } = await w.intern('2025-01-01');
  const commandId = randomUUID();
  const revision = (await w.s.getEmployee(e.id)).revision;
  const send = () =>
    w.s.request('POST', `/employees/${e.id}/businesses`, {
      ifMatch: revision,
      idempotencyKey: commandId,
      body: withLoginEmail(e.id, {
        kind: 'intern_regularization',
        mode: 'direct',
        effectiveDate: '2026-10-01',
        fields: {},
      }),
    });
  const first = await send();
  expect(first.status, await first.clone().text()).toBe(201);
  const created = (await first.json()) as { id: string };
  const replay = await send();
  expect(replay.status, await replay.clone().text()).toBe(201);
  expect(((await replay.json()) as { id: string }).id).toBe(created.id);
  expect(await w.s.records(e.id)).toHaveLength(2);
  expect((await w.record(created.id)).fields.workYearCompanyBefore).toBe(1.7);
});

it('AC-EMP-F480-06：撤销（删除）转正恢复入职日、实习开始日与校正值；重放删除命令不再变化，再次转正只累计一次', async () => {
  const w = await internWorld(db().db, 'revoke');
  const { e, hire } = await w.intern('2025-01-01');
  const reg = await w.regularize(e.id);
  const commandId = randomUUID();
  const current = await w.saved(reg.id);
  const removed = await w.remove(current, commandId);
  expect(removed.status, await removed.clone().text()).toBe(200);
  expect((await w.remove(current, commandId)).status).toBe(200);
  const records = await w.s.records(e.id);
  expect(records.map((r) => r.id)).toEqual([hire.id]);
  expect(records[0]).toMatchObject({ entryDate: '2025-01-01', fields: { workYearCompanyBefore: 0 } });
  const again = await w.regularize(e.id, { date: '2026-10-01' });
  expect(again.record).toMatchObject({ entryDate: '2026-10-01', fields: { workYearCompanyBefore: 1.7 } });
});

it('AC-EMP-F480-07：申请方式以落地（到期生效）时的开关为准；审批通过未生效不写入', async () => {
  const w = await internWorld(db().db, 'application');
  const { e } = await w.intern('2025-01-01');
  const planned = await w.regularize(e.id, { mode: 'application', date: '2026-10-05' });
  const approved = await w.approve(planned);
  expect(approved.status).toBe('approved');
  await w.setting(false);
  const effective = await w.transition(approved, 'activate', '2026-10-05T01:00:00Z');
  expect(effective.record).toMatchObject({
    entryDate: '2026-10-05',
    traineeStartDate: '2025-01-01',
    fields: { workYearCompanyBefore: 0 },
  });
});
