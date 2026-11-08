import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { RETIRE_REHIRE_SETTING, retireWorld } from './AC-EMP-F478-seniority-support.js';

const db = useTestDb();
it.each([0, 1])(
  'AC-EMP-F478-23：删除已落地返聘从快照恢复校正值 %s 并审计 restore；先关开关再删除仍恢复，重放幂等',
  async (manual) => {
    const w = await retireWorld(db().db, `restore-${manual}`);
    const prior = await w.retired();
    await w.setting(RETIRE_REHIRE_SETTING, true);
    const rehire = await w.create(prior.e.id, 'retire_rehire', manual);
    expect(rehire.record?.fields.workYearCompanyBefore).toBe(3);
    const edit = await w.s.request('PATCH', `/records/${rehire.id}`, {
      ifMatch: rehire.revision,
      body: { fields: { remarks: '撤销前的合成备注' } },
    });
    expect(edit.status, await edit.clone().text()).toBe(200);
    // 撤销退休在返聘未删时仍 409，且不留任何写入
    const retirement = await w.saved(prior.retirement.id);
    const blocked = await w.s.request('DELETE', `/businesses/${prior.retirement.id}`, { ifMatch: retirement.revision });
    expect(blocked.status).toBe(409);
    expect(JSON.stringify(await blocked.json())).toContain('RETIREMENT_HAS_REHIRE');
    // 关开关后删除返聘：恢复与开关当前值无关
    await w.setting(RETIRE_REHIRE_SETTING, false);
    const current = await w.saved(rehire.id);
    const commandId = randomUUID();
    const cancel = () =>
      w.s.request('DELETE', `/businesses/${rehire.id}`, {
        ifMatch: current.revision,
        idempotencyKey: commandId,
        body: {},
      });
    const cancelled = await cancel();
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    const after = await w.saved(rehire.id);
    expect(after).toMatchObject({ status: 'deleted', record: null, fields: { remarks: '撤销前的合成备注' } });
    expect(after.fields.workYearCompanyBefore).toBe(manual);
    expect(await w.versions(rehire.id)).toEqual([manual, 3, 3, manual]);
    expect((await cancel()).status).toBe(200);
    expect(await w.versions(rehire.id)).toEqual([manual, 3, 3, manual]);
    expect(await w.audits(rehire.id, 'employment.retire_rehire.seniority.restore')).toEqual([
      { before: { workYearCompanyBefore: 3 }, after: { workYearCompanyBefore: manual } },
    ]);
    expect(await w.audits(rehire.id, 'employment.rehire.seniority.restore')).toEqual([]);
    expect((await w.s.record(prior.retirement.id)).fields.workYearCompanyBefore).toBe(2);
  },
);

it('AC-EMP-F478-23：开关关闭期间落地的返聘没有快照，删除不追加版本也不写 restore 审计', async () => {
  const w = await retireWorld(db().db, 'restore-nosnap');
  const prior = await w.retired();
  const rehire = await w.create(prior.e.id, 'retire_rehire', 1);
  expect(await w.snapshots(rehire.id)).toBe(0);
  const current = await w.saved(rehire.id);
  const removed = await w.s.request('DELETE', `/businesses/${rehire.id}`, { ifMatch: current.revision, body: {} });
  expect(removed.status, await removed.clone().text()).toBe(200);
  expect(await w.audits(rehire.id, 'employment.retire_rehire.seniority.restore')).toEqual([]);
  expect((await w.saved(rehire.id)).fields.workYearCompanyBefore).toBe(1);
});
