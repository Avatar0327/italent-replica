import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { withLoginEmail } from './AC-EMP-support.js';
import { RETIRE_REHIRE_SETTING, retireWorld } from './AC-EMP-F478-seniority-support.js';

const db = useTestDb();
it.each([false, true])(
  'AC-EMP-F478-24：添加待返聘时开关为 %s，办理入职才累计；撤销恢复办理前手工 1.25',
  async (initiallyOn) => {
    const w = await retireWorld(db().db, `pending-${initiallyOn}`);
    const prior = await w.retired();
    const org = await w.s.org('合成返聘部门', { establishedOn: '2020-01-01' });
    await w.setting(RETIRE_REHIRE_SETTING, initiallyOn);
    const added = await w.s.request('POST', `/employees/${prior.e.id}/businesses`, {
      ifMatch: prior.retirement.employeeRevision,
      body: withLoginEmail(prior.e.id, {
        kind: 'retire_rehire',
        mode: 'direct',
        pendingEntry: true,
        effectiveDate: '2026-10-01',
        fields: { employType: 'internal', departmentId: org.id, workYearCompanyBefore: 1 },
      }),
    });
    expect(added.status, await added.clone().text()).toBe(201);
    const b = (await added.json()) as { id: string; revision: number };
    expect((await w.s.record(b.id)).fields.workYearCompanyBefore).toBe(1);
    const edit = await w.s.request('PATCH', `/records/${b.id}`, {
      ifMatch: b.revision,
      body: { fields: { workYearCompanyBefore: 1.25 } },
    });
    expect(edit.status, await edit.clone().text()).toBe(200);
    await w.setting(RETIRE_REHIRE_SETTING, true);
    const current = await w.saved(b.id);
    const completed = await w.s.request('POST', `/pending-entries/${b.id}/complete`, {
      ifMatch: current.revision,
      body: { probation: false },
    });
    expect(completed.status, await completed.clone().text()).toBe(200);
    expect((await w.s.record(b.id)).fields.workYearCompanyBefore).toBe(3);
    expect(await w.snapshots(b.id)).toBe(1);
    expect((await w.audits(b.id, 'employment.retire_rehire.seniority')).length).toBe(1);
    const after = await w.saved(b.id);
    expect((await w.s.request('DELETE', `/businesses/${b.id}`, { ifMatch: after.revision })).status).toBe(200);
    expect((await w.saved(b.id)).fields.workYearCompanyBefore).toBe(1.25);
    expect((await w.audits(b.id, 'employment.retire_rehire.seniority.restore')).length).toBe(1);
  },
);
