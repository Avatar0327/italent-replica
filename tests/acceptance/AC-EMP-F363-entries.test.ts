/** F-363：页面共用的 HTTP 写入口、批量 / 导入、改期与审批落地。 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { employmentSession, installProbationSeeds } from './AC-EMP-support.js';
import { disableForm, formRefused } from './AC-EMP-F363-support.js';
import { stateSnapshot } from './AC-EXIT-gate-support.js';
import { requestWorld } from './AC-PT-request-support.js';
import { addHire, entryAction, entryWorld, hireBody } from './AC-EN-BE2a-support.js';

const database = useTestDb();

for (const action of ['postpone', 'edit', 'complete'] as const) {
  it(`AC-EMP-F363-23 ${action}：待入职原引用停用后仍可办理，新增待入职不得选用`, async () => {
    const w = await entryWorld(database().db, `f363-pending-${action}`);
    const employee = await w.session.employee();
    const body = hireBody(w.org.id, '2026-10-10', {
      pendingEntry: true,
      probation: false,
      fields: { departmentId: w.org.id, employType: 'internal', employmentForm: 'regular' },
    });
    const created = await addHire(w.session, employee, body);
    expect(created.status, await created.clone().text()).toBe(201);
    const pending = (await created.json()) as { id: string; revision: number };
    expect((await disableForm(w.session.request)).status).toBe(200);
    const fresh = await w.session.employee();
    await formRefused(await addHire(w.session, fresh, body));
    w.session.setNow('2026-10-12T01:00:00Z');
    const response =
      action === 'edit'
        ? await w.session.request('PATCH', `/pending-entries/${pending.id}`, {
            ifMatch: pending.revision,
            body: { effectiveDate: '2026-10-11', probation: false },
          })
        : await entryAction(
            w,
            pending.id,
            action,
            action === 'postpone' ? { effectiveDate: '2026-10-15' } : { probation: false },
            pending.revision,
          );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ record: { fields: { employmentForm: 'regular' } } });
  });
}

it('AC-EMP-F363-24：延后继承在落地时沿用停用前驱，显式改选仍拒绝', async () => {
  const configure = async (s: Awaited<ReturnType<typeof employmentSession>>) => {
    const response = await s.request('PUT', '/transfers/settings', {
      ifMatch: 0,
      body: { unrestrictTargetDepartment: true, autoPopulate: false },
    });
    expect(response.status).toBe(200);
  };
  const w = await world('deferred');
  await configure(w.s);
  expect((await disableForm(w.s.request)).status).toBe(200);
  const response = await w.s.request('POST', `/employees/${w.employee.id}/businesses`, {
    ifMatch: w.hire.employeeRevision,
    body: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-20' },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  expect(await response.json()).toMatchObject({ record: { fields: { employmentForm: 'regular' } } });
  const other = await world('deferred-reselect', 'consultant');
  await configure(other.s);
  expect((await disableForm(other.s.request)).status).toBe(200);
  await formRefused(
    await other.s.request('POST', `/employees/${other.employee.id}/businesses`, {
      ifMatch: other.hire.employeeRevision,
      body: {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-09-20',
        fields: { employmentForm: 'regular' },
      },
    }),
  );
});

async function world(label: string, code = 'regular') {
  const db = database().db;
  const s = await employmentSession(db, `f363-${label}`);
  const org = await s.org('合成用工部门', { establishedOn: '2020-01-01' });
  const employee = await s.employee();
  const hire = await s.business(
    employee.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-09-01',
      fields: { departmentId: org.id, employmentForm: code },
    },
    employee.revision,
  );
  return { db, s, org, employee, hire };
}

for (const preview of [false, true]) {
  it(`AC-EMP-F363-25：兼职${preview ? '预览' : '直接新增'}无继承基准，主职同值也不能新选停用项`, async () => {
    const w = await world(`new-side-${preview}`);
    expect((await disableForm(w.s.request)).status).toBe(200);
    const path = `/employees/${w.employee.id}/part-times${preview ? '/preview' : ''}`;
    const body = {
      partTimeType: 'part_time',
      startDate: '2026-09-10',
      fields: { departmentId: w.org.id, employmentForm: 'regular' },
    };
    const before = await stateSnapshot(w.db, w.s.tenant.id, w.employee.id);
    await formRefused(await w.s.request('POST', path, { ifMatch: w.hire.employeeRevision, body }));
    expect(await stateSnapshot(w.db, w.s.tenant.id, w.employee.id)).toEqual(before);
    const cleared = await w.s.request('POST', path, {
      ifMatch: w.hire.employeeRevision,
      body: { ...body, fields: { ...body.fields, employmentForm: null } },
    });
    expect(cleared.status, await cleared.clone().text()).toBe(preview ? 200 : 201);
  });
}

const entries = [
  'record',
  'batch',
  'import-edit',
  'import-create',
  'transfer',
  'preview',
  'forward-create',
  'forward-edit',
  'forward-import',
] as const;

for (const entry of entries) {
  for (const retained of [true, false]) {
    it(`AC-EMP-F363-20 ${entry}：${retained ? '沿用停用原引用放行' : '改选停用项拒绝且无业务写入'}`, async () => {
      const w = await world(`${entry}-${retained}`, retained ? 'regular' : 'consultant');
      expect((await disableForm(w.s.request)).status).toBe(200);
      const snapshot = () => stateSnapshot(w.db, w.s.tenant.id, w.employee.id);
      const before = await snapshot();
      const fields = { employmentForm: 'regular', place: '合成新地点' };
      const business = { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-20', fields };
      const item = { operation: 'edit', id: w.hire.id, revision: w.hire.revision, patch: { fields } };
      const owner = await w.s.getEmployee(w.employee.id);
      let response: Response;
      if (entry === 'record' || entry === 'forward-edit') {
        response = await w.s.request(
          entry === 'record' ? 'PATCH' : 'POST',
          `/records/${w.hire.id}${entry === 'record' ? '' : '/forward-update-preview'}`,
          { ifMatch: w.hire.revision, body: { fields } },
        );
      } else if (entry === 'batch') {
        response = await w.s.request('POST', '/records/batch-edit', {
          ifMatch: 0,
          body: { items: [{ id: w.hire.id, revision: w.hire.revision }], patch: { fields } },
        });
      } else if (entry.startsWith('import-') || entry === 'forward-import') {
        response = await w.s.request(
          'POST',
          `/employees/${w.employee.id}/import${entry === 'forward-import' ? '/forward-update-preview' : ''}`,
          {
            ifMatch: owner.revision,
            body: { items: [entry === 'import-create' ? { operation: 'create', business } : item] },
          },
        );
      } else {
        const suffix = entry === 'transfer' ? 'businesses' : entry === 'preview' ? 'preview' : 'forward-update-preview';
        response = await w.s.request('POST', `/employees/${w.employee.id}/${suffix}`, {
          ifMatch: owner.revision,
          body: business,
        });
      }
      if (!retained) {
        await formRefused(response);
        expect(await snapshot()).toEqual(before);
      } else {
        expect(response.status, await response.clone().text()).toBe(entry === 'transfer' ? 201 : 200);
        const records = await w.s.records(w.employee.id);
        expect(records.every((record) => record.fields.employmentForm === 'regular')).toBe(true);
        if (entry === 'preview' || entry.startsWith('forward-')) expect(await snapshot()).toEqual(before);
      }
    });
  }
}

for (const explicit of [true, false]) {
  it(`AC-EMP-F363-21：草稿改期到停用前驱，${explicit ? '显式改选拒绝' : '未显式填写重新继承放行'}`, async () => {
    const w = await world(`reschedule-${explicit}`);
    const later = await w.s.business(
      w.employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-09-20',
        fields: { employmentForm: 'consultant' },
      },
      w.hire.employeeRevision,
    );
    const draft = await w.s.business(
      w.employee.id,
      {
        kind: 'transfer',
        mode: 'application',
        effectiveDate: '2026-10-10',
        fields: { place: '草稿地点' },
      },
      later.employeeRevision,
    );
    expect((await disableForm(w.s.request)).status).toBe(200);
    const before = await w.s.request('GET', `/businesses/${draft.id}`).then((r) => r.json());
    const response = await w.s.request('PATCH', `/businesses/${draft.id}`, {
      ifMatch: draft.revision,
      body: { effectiveDate: '2026-09-10', ...(explicit ? { fields: { employmentForm: 'regular' } } : {}) },
    });
    if (explicit) {
      await formRefused(response);
      expect(await w.s.request('GET', `/businesses/${draft.id}`).then((r) => r.json())).toEqual(before);
    } else {
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({ fields: { employmentForm: 'regular' } });
    }
  });
}

it('AC-EMP-F363-22：兼职新增申请、草稿编辑、提交、审批编辑与落地共用本单旧值', async () => {
  const w = await requestWorld(database().db, 'f363-request', {
    editMode: 'separate',
    extraEditable: ['employmentForm'],
  });
  await installProbationSeeds(w.db, w.tenant.id);
  const api = w.http();
  const kept = await w.ok(await api.create({ fields: { employmentForm: 'regular' } }), 201);
  const changed = await w.ok(await api.create({ fields: { employmentForm: 'consultant' } }), 201);
  const request = (method: string, path: string, options = {}) =>
    w.request(w.hr.id, method, `/api/tenant/employment${path}`, options);
  expect((await disableForm(request)).status).toBe(200);
  const before = await w.writes();
  await formRefused(await api.create({ fields: { employmentForm: 'regular' } }));
  await formRefused(await api.patch(changed.id, changed.revision, { fields: { employmentForm: 'regular' } }));
  expect(await w.writes()).toEqual(before);
  const edited = await w.ok(await api.patch(kept.id, kept.revision, { requestRemark: '保留原用工形式' }));
  expect(edited.fields).toMatchObject({ employmentForm: 'regular' });
  await w.ok(await api.act(kept.id, 'submit', edited.revision));
  await w.ok(await api.act(changed.id, 'submit', changed.revision));
  const pending = await w.instance(changed.id);
  const task = w.pending(pending)[0]!;
  const beforeEdit = await w.writes();
  await formRefused(
    await w.taskAction(task.assigneeUserId, task.id, 'edit', pending.revision, {
      fields: { employmentForm: 'regular' },
    }),
  );
  expect(await w.writes()).toEqual(beforeEdit);
  const keptView = await w.instance(kept.id);
  const keptTask = w.pending(keptView)[0]!;
  const edit = await w.taskAction(keptTask.assigneeUserId, keptTask.id, 'edit', keptView.revision, {
    fields: { requestRemark: '审批保留原引用' },
  });
  expect(edit.status, await edit.clone().text()).toBe(200);
  await w.approveAll(kept.id);
  const landed = await w.ok(await api.one(kept.id));
  expect(landed).toMatchObject({ status: 'effective', fields: { employmentForm: 'regular' } });
  const record = await request('GET', `/part-times/${landed.recordId}`);
  expect(record.status).toBe(200);
  expect(await record.json()).toMatchObject({ fields: { employmentForm: 'regular' } });
});
