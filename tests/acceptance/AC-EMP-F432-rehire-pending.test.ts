import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { withLoginEmail } from './AC-EMP-support.js';
import { rehireWorld } from './AC-EMP-F432-rehire-support.js';

const db = useTestDb();
it.each([false, true])(
  'AC-EMP-F432-12：添加待重聘时开关为 %s，办理入职才累计；撤销恢复办理前手工 1.25',
  async (initiallyOn) => {
    const w = await rehireWorld(db().db, `pending-${initiallyOn}`);
    const prior = await w.departed();
    const org = await w.s.org('合成重聘部门', { establishedOn: '2020-01-01' });
    await w.setting(initiallyOn);
    const added = await w.s.request('POST', `/employees/${prior.e.id}/businesses`, {
      ifMatch: prior.leave.employeeRevision,
      body: withLoginEmail(prior.e.id, {
        kind: 'rehire',
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
    await w.setting(true);
    const future = await w.s.business(
      prior.e.id,
      {
        kind: 'org_adjustment',
        mode: 'direct',
        effectiveDate: '2026-10-02',
        fields: { remarks: '合成后继' },
      },
      (await w.s.getEmployee(prior.e.id)).revision,
    );
    const current = await w.saved(b.id);
    const commandId = randomUUID();
    const complete = () =>
      w.s.request('POST', `/pending-entries/${b.id}/complete`, {
        ifMatch: current.revision,
        idempotencyKey: commandId,
        body: { probation: false },
      });
    const completed = await complete();
    expect(completed.status, await completed.clone().text()).toBe(200);
    expect((await w.s.record(b.id)).fields.workYearCompanyBefore).toBe(3);
    expect(await completed.json()).toMatchObject({ employeeStatus: 3 });
    expect((await w.s.record(future.id, '2026-10-02')).fields.workYearCompanyBefore).toBe(3);
    const versions = await w.versions(b.id);
    expect((await complete()).status).toBe(200);
    expect(await w.versions(b.id)).toEqual(versions);
    const futureState = await w.saved(future.id);
    expect((await w.s.request('DELETE', `/businesses/${future.id}`, { ifMatch: futureState.revision })).status).toBe(
      200,
    );
    const after = await w.saved(b.id);
    expect((await w.s.request('DELETE', `/businesses/${b.id}`, { ifMatch: after.revision })).status).toBe(200);
    expect((await w.saved(b.id)).fields.workYearCompanyBefore).toBe(1.25);
  },
);
