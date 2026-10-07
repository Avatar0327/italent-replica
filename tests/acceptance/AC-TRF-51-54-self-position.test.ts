import { randomUUID } from 'node:crypto';
import { runEmploymentActivations } from '@italent/api';
import { sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { approvalWorld, permissionAdmin, type InstanceView, type Person } from './AC-APV-support.js';
import { createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';
import { rowsOf } from '../../apps/api/src/modules/employment/record-store.js';
import { resolveTransferForm } from '../../apps/api/src/modules/transfer/configuration.js';

const database = useTestDb();
const BASE = '/api/tenant/employment';
const SELF = '/api/tenant/self-service/transfer';
const date = '2026-10-19';
let w: Awaited<ReturnType<typeof approvalWorld>>;
let api: ReturnType<typeof tenantApi>;
let admin: Awaited<ReturnType<typeof permissionAdmin>>;
let source: string;
let target: string;
let third: string;
let postId: string;
let originalPosition: string;
let targetPosition: string;
let propagatedPosition: string;

interface Business {
  id: string;
  revision: number;
  status: string;
  fields: { positionId: string | null; departmentId: string };
}
async function actor(label: string, positionEditable = false, positionId: string | null = originalPosition) {
  const person = await w.person(label, source, { positionId, postId });
  const profile = await createProfile(admin, `position-${randomUUID()}`);
  const def = MODULE_OBJECTS.employmentRecord;
  await w.json(
    await setObjectPermission(
      admin,
      profile,
      {
        dataOperations: { create: true, update: true, delete: false },
        fields: def.fields.map((field) => ({
          fieldCode: field.code,
          view: true,
          edit: !field.system && (field.code !== 'positionId' || positionEditable),
        })),
        buttons: def.buttons
          .filter(
            (button) =>
              (!button.code.startsWith('Transfer.') || button.code === 'Transfer.Self') &&
              !['Employment.Revoke', 'Employment.Delete'].includes(button.code),
          )
          .map((button) => ({ buttonCode: button.code, level: button.level })),
      },
      def.code,
    ),
  );
  await makeGrantable(admin, [profile.id]);
  await w.json(await grant(admin, person.userId, profile.id), 201);
  await w.json(
    await admin.api.request('PUT', `/api/tenant/permission/scopes/${person.userId}/TenantBase`, {
      ...admin.asAdmin,
      ifMatch: 0,
      body: {
        kind: 'org_range',
        orgRanges: [source, target, third].map((orgId) => ({ orgId, includeDescendants: false })),
      },
    }),
  );
  return { ...person, permissionProfile: profile };
}
async function profile(person: Person) {
  return w.json<{ employee: { revision: number; [key: string]: unknown }; record: unknown }>(
    await api.request('GET', '/api/tenant/self-service/profile', w.as(person.userId)),
  );
}
async function revision(person: Person) {
  const profile = await w.json<{ employee: { revision: number } }>(
    await api.request('GET', '/api/tenant/self-service/profile', w.as(person.userId)),
  );
  return profile.employee.revision;
}
function legacyBody(departmentId: string, submit = false, fields: object = {}) {
  return {
    initiator: 'employee',
    transferTypeCode: 'in_department',
    formId: 'TenantBase.TransferMultiFormView',
    effectiveDate: date,
    mode: 'application',
    submit,
    fields: { departmentId, ...fields },
  };
}
async function draft(person: Person, departmentId = source) {
  return w.json<Business>(
    await api.request('POST', `${BASE}/transfers/employees/${person.employeeId.toUpperCase()}`, {
      ...w.as(person.userId),
      ifMatch: await revision(person),
      body: legacyBody(departmentId.toUpperCase()),
    }),
    201,
  );
}
async function payload(id: string) {
  return w.business(id);
}
async function approve(person: Person, id: string) {
  const view = await w.instanceOf(id, person.userId);
  const task = w.pending(view)[0]!;
  return w.json<InstanceView>(await w.taskAction(task.assigneeUserId!, task.id, 'approve', view.revision));
}

beforeAll(async () => {
  w = await approvalWorld(database().db, 'self-position');
  api = tenantApi(database().db, { authorize: undefined, clock: w.clock });
  admin = await permissionAdmin(w);
  source = await w.org('合成职位原部门');
  target = await w.org('合成职位新部门');
  third = await w.org('合成第三部门');
  postId = (
    await w.json<{ id: string }>(
      await w.request(w.hr.id, 'POST', '/api/tenant/job/posts', {
        ifMatch: 0,
        body: { code: 'SELF_POST', name: '合成职务', startDate: '2020-01-01' },
      }),
      201,
    )
  ).id;
  async function position(orgId: string) {
    return (
      await w.json<{ id: string }>(
        await w.request(w.hr.id, 'POST', '/api/tenant/job/positions', {
          ifMatch: 0,
          body: { code: `P-${randomUUID()}`, name: `合成职位-${randomUUID()}`, startDate: '2020-01-01', orgId, postId },
        }),
        201,
      )
    ).id;
  }
  originalPosition = await position(source);
  targetPosition = await position(target);
  propagatedPosition = await position(source);
  await w.publishedProcess({
    nodes: [
      {
        key: 'review',
        approver: 'owner',
        formFields: ['departmentId', 'positionId'],
        editableFields: ['positionId'],
        editMode: 'separate',
      },
    ],
  });
});

describe('AC-TRF-51 / 52 / 53 / 54 DEC-232 本人调动职位置空', () => {
  it.each(['legacy', 'self-service'])('AC-TRF-51 占职位员工跨部门预览、提交及到期生效：%s', async (entry) => {
    const person = await actor(`合成跨部门-${entry}`);
    const body =
      entry === 'legacy'
        ? legacyBody(target.toUpperCase(), true)
        : { effectiveDate: date, fields: { departmentId: target.toUpperCase() } };
    const path = entry === 'legacy' ? `${BASE}/transfers/employees/${person.employeeId.toUpperCase()}` : SELF;
    const preview = await w.json<{ fields: object; form: { fieldModes: Record<string, string> } }>(
      await api.request('POST', `${path}/preview`, { ...w.as(person.userId), body }),
    );
    expect(preview.form.fieldModes['preset:positionId']).not.toBe('editable');
    expect(preview.fields).not.toHaveProperty('positionId');
    expect(preview.fields).toMatchObject({ departmentId: target });
    const options = { ...w.as(person.userId), ifMatch: await revision(person), idempotencyKey: randomUUID(), body };
    const created = await w.json<Business>(await api.request('POST', path, options), 201);
    expect(await payload(created.id)).toMatchObject({
      status: 'in_review',
      fields: { departmentId: target, positionId: null },
    });
    expect(await w.json(await api.request('POST', path, options), 201)).toEqual(created);
    await approve(person, created.id);
    expect(await payload(created.id)).toMatchObject({ status: 'approved', record: null });
    w.setNow(`${date}T01:00:00Z`);
    await runEmploymentActivations(
      database().db,
      { commandId: randomUUID(), actorUserId: w.hr.id },
      { tenantId: w.tenant.id },
      { clock: w.clock },
    );
    expect(await payload(created.id)).toMatchObject({ status: 'effective', record: { fields: { positionId: null } } });
    const effective = await payload(created.id);
    expect(
      (
        await w.request(w.hr.id, 'PATCH', `${BASE}/records/${created.id}`, {
          ifMatch: effective.revision,
          body: { fields: { positionId: originalPosition } },
        })
      ).status,
    ).toBe(400);
    expect(await payload(created.id)).toEqual(effective);
    await w.json(
      await w.request(w.hr.id, 'PATCH', `${BASE}/records/${created.id}`, {
        ifMatch: effective.revision,
        body: { fields: { positionId: targetPosition.toUpperCase() } },
      }),
    );
    expect(await payload(created.id)).toMatchObject({ record: { fields: { positionId: targetPosition } } });
    w.setNow('2026-10-01T01:00:00Z');
  });

  it('AC-TRF-51 同部门保留；草稿换部门、改期、换回原部门、提交与重放一致', async () => {
    const person = await actor('合成草稿位置');
    let saved = await draft(person);
    expect(await payload(saved.id)).toMatchObject({ fields: { positionId: originalPosition, postId } });
    const patch = async (body: object) => {
      const options = { ...w.as(person.userId), ifMatch: saved.revision, idempotencyKey: randomUUID(), body };
      const path = `${BASE}/businesses/${saved.id.toUpperCase()}`;
      saved = await w.json<Business>(await api.request('PATCH', path, options));
      expect(await w.json(await api.request('PATCH', path, options))).toEqual(saved);
    };
    await patch({ fields: { departmentId: target.toUpperCase() } });
    expect(await payload(saved.id)).toMatchObject({ fields: { positionId: null, departmentId: target } });
    await patch({ effectiveDate: '2026-10-20' });
    expect(await payload(saved.id)).toMatchObject({ fields: { positionId: null } });
    await patch({ fields: { departmentId: source.toUpperCase() } });
    expect(await payload(saved.id)).toMatchObject({ fields: { positionId: originalPosition, postId } });
    const options = { ...w.as(person.userId), ifMatch: saved.revision, idempotencyKey: randomUUID(), body: {} };
    const path = `${BASE}/businesses/${saved.id}/submit`;
    const submitted = await w.json<Business>(await api.request('POST', path, options));
    expect(await w.json(await api.request('POST', path, options))).toEqual(submitted);
    expect(await payload(saved.id)).toMatchObject({
      fields: { positionId: originalPosition, postId },
      status: 'in_review',
    });
  });

  it.each([null, 'original', 'target'])('AC-TRF-52 本人显式 positionId=%s 即使有编辑权也拒绝', async (value) => {
    const person = await actor(`合成显式-${value}`, true);
    const fields = {
      positionId: value === null ? null : (value === 'original' ? originalPosition : targetPosition).toUpperCase(),
    };
    const beforeCreate = await profile(person);
    for (const preview of [false, true]) {
      expect(
        (
          await api.request('POST', `${SELF}${preview ? '/preview' : ''}`, {
            ...w.as(person.userId),
            ifMatch: await revision(person),
            body: { effectiveDate: date, fields: { departmentId: target, ...fields } },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await api.request('POST', `${BASE}/transfers/employees/${person.employeeId}${preview ? '/preview' : ''}`, {
            ...w.as(person.userId),
            ifMatch: await revision(person),
            body: legacyBody(target, false, fields),
          })
        ).status,
      ).toBe(403);
    }
    expect(await profile(person)).toEqual(beforeCreate);
    const saved = await draft(person);
    const beforeSubmit = await payload(saved.id);
    expect(
      (
        await api.request('POST', `${BASE}/businesses/${saved.id}/submit`, {
          ...w.as(person.userId),
          ifMatch: saved.revision,
          body: { fields },
        })
      ).status,
    ).toBe(400);
    expect(await payload(saved.id)).toEqual(beforeSubmit);
    const beforePatch = await payload(saved.id);
    const beforePatchPerson = await profile(person);
    const options = { ...w.as(person.userId), ifMatch: saved.revision, idempotencyKey: randomUUID(), body: { fields } };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await api.request('PATCH', `${BASE}/businesses/${saved.id}`, options)).status).toBe(403);
      expect(await payload(saved.id)).toEqual(beforePatch);
      expect(await profile(person)).toEqual(beforePatchPerson);
    }
  });

  it('AC-TRF-53 HR 审批中补目标部门职位，错误部门拒绝，正确值通过后保留', async () => {
    const person = await actor('合成HR补职位');
    const created = await w.json<Business>(
      await api.request('POST', SELF, {
        ...w.as(person.userId),
        ifMatch: await revision(person),
        body: { effectiveDate: date, fields: { departmentId: target } },
      }),
      201,
    );
    let view = await w.instanceOf(created.id, person.userId);
    const task = w.pending(view)[0]!;
    const edit = (positionId: string) =>
      w.taskAction(task.assigneeUserId!, task.id, 'edit', view.revision, {
        fields: { positionId: positionId.toUpperCase() },
      });
    const beforeEdit = await payload(created.id);
    expect((await edit(originalPosition)).status).toBe(400);
    expect(await payload(created.id)).toEqual(beforeEdit);
    view = await w.json<InstanceView>(await edit(targetPosition));
    expect(await payload(created.id)).toMatchObject({ fields: { positionId: targetPosition } });
    await w.json(await w.taskAction(task.assigneeUserId!, task.id, 'approve', view.revision));
    expect(await payload(created.id)).toMatchObject({ fields: { positionId: targetPosition }, status: 'approved' });
    w.setNow(`${date}T01:00:00Z`);
    await runEmploymentActivations(
      database().db,
      { commandId: randomUUID(), actorUserId: w.hr.id },
      { tenantId: w.tenant.id },
      { clock: w.clock },
    );
    expect(await payload(created.id)).toMatchObject({
      status: 'effective',
      record: { fields: { positionId: targetPosition } },
    });
    w.setNow('2026-10-01T01:00:00Z');
  });

  it.each([
    { action: 'reject' as const, change: 'date' },
    { action: 'withdraw' as const, change: 'date' },
    { action: 'reject' as const, change: 'department' },
    { action: 'withdraw' as const, change: 'department' },
  ])('AC-TRF-53 HR 补职位后 $action，员工修改 $change 保留或清空可信职位', async ({ action, change }) => {
    const person = await actor(`合成HR补后修改-${action}-${change}`, true);
    const created = await w.json<Business>(
      await api.request('POST', SELF, {
        ...w.as(person.userId),
        ifMatch: await revision(person),
        body: { effectiveDate: date, fields: { departmentId: target } },
      }),
      201,
    );
    let view = await w.instanceOf(created.id, person.userId);
    const task = w.pending(view)[0]!;
    view = await w.json<InstanceView>(
      await w.taskAction(task.assigneeUserId!, task.id, 'edit', view.revision, {
        fields: { positionId: targetPosition.toUpperCase() },
      }),
    );
    if (action === 'reject') await w.json(await w.taskAction(task.assigneeUserId!, task.id, 'reject', view.revision));
    else await w.json(await w.instanceAction(person.userId, view.id, 'withdraw', view.revision));
    let saved: Pick<Business, 'revision'> = await payload(created.id);
    expect(saved).toMatchObject({
      status: action === 'reject' ? 'rejected' : 'draft',
      fields: { departmentId: target, positionId: targetPosition },
    });
    for (const positionId of [null, targetPosition.toUpperCase(), originalPosition]) {
      const beforeBusiness = await payload(created.id);
      const beforeProfile = await profile(person);
      const denied = await api.request('PATCH', `${BASE}/businesses/${created.id}`, {
        ...w.as(person.userId),
        ifMatch: saved.revision,
        body: { fields: { positionId } },
      });
      expect(denied.status).toBe(403);
      expect(await payload(created.id)).toEqual(beforeBusiness);
      expect(await profile(person)).toEqual(beforeProfile);
    }
    const patch = async (body: object) => {
      const options = { ...w.as(person.userId), ifMatch: saved.revision, idempotencyKey: randomUUID(), body };
      const path = `${BASE}/businesses/${created.id.toUpperCase()}`;
      saved = await w.json<Business>(await api.request('PATCH', path, options), 200);
      expect(await w.json(await api.request('PATCH', path, options), 200)).toEqual(saved);
    };
    if (change === 'date') {
      await patch({ effectiveDate: '2026-10-20' });
      expect(await payload(created.id)).toMatchObject({ fields: { departmentId: target, positionId: targetPosition } });
      await patch({ fields: { remarks: '合成驳回或撤回后修改' } });
      expect(await payload(created.id)).toMatchObject({
        fields: { positionId: targetPosition, remarks: '合成驳回或撤回后修改' },
      });
      await patch({ fields: { departmentId: target.toUpperCase() } });
      expect(await payload(created.id)).toMatchObject({ fields: { positionId: targetPosition } });
    }
    if (change === 'department') {
      await patch({ fields: { departmentId: third.toUpperCase() } });
      expect(await payload(created.id)).toMatchObject({ fields: { departmentId: third, positionId: null } });
    }
    // 保留或自动清空后继续改期、重提、审批及到期落地，不能丢掉或还原上一版的 HR 职位。
    await patch({ effectiveDate: '2026-10-21' });
    const options = { ...w.as(person.userId), ifMatch: saved.revision, idempotencyKey: randomUUID(), body: {} };
    const submitted = await w.json<Business>(
      await api.request('POST', `${BASE}/businesses/${created.id}/submit`, options),
    );
    expect(await w.json(await api.request('POST', `${BASE}/businesses/${created.id}/submit`, options))).toEqual(
      submitted,
    );
    await approve(person, created.id);
    w.setNow('2026-10-21T01:00:00Z');
    await runEmploymentActivations(
      database().db,
      { commandId: randomUUID(), actorUserId: w.hr.id },
      { tenantId: w.tenant.id },
      { clock: w.clock },
    );
    expect(await payload(created.id)).toMatchObject({
      status: 'effective',
      record: {
        fields: {
          departmentId: change === 'department' ? third : target,
          positionId: change === 'department' ? null : targetPosition,
        },
      },
    });
    w.setNow('2026-10-01T01:00:00Z');
  });

  it('AC-TRF-54 他人越界与解除本人绑定后重放均拒绝，不泄漏原职位', async () => {
    const person = await actor('合成撤权重放');
    const other = await actor('合成范围外员工');
    const beforeOther = await profile(other);
    expect(
      (
        await api.request('POST', `${BASE}/transfers/employees/${other.employeeId}/preview`, {
          ...w.as(person.userId),
          body: legacyBody(target),
        })
      ).status,
    ).toBe(403);
    expect(await profile(other)).toEqual(beforeOther);
    const options = {
      ...w.as(person.userId),
      ifMatch: await revision(person),
      idempotencyKey: randomUUID(),
      body: { effectiveDate: date, fields: { departmentId: target.toUpperCase() } },
    };
    const saved = await w.json<Business>(await api.request('POST', SELF, options), 201);
    const beforeReplay = await payload(saved.id);
    await withTenant(database().db, w.tenant.id, (tx) =>
      tx.execute(sql`
      DELETE FROM permission_user_person_links WHERE tenant_id=${w.tenant.id} AND user_id=${person.userId}::uuid
    `),
    );
    const denied = await api.request('POST', SELF, options);
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain(originalPosition);
    expect(await payload(saved.id)).toEqual(beforeReplay);
    expect(await payload(saved.id)).toMatchObject({ fields: { positionId: null } });
  });

  it.each(['legacy', 'self-service'])('AC-TRF-55 提示只披露本人职位确实被清空的结果：%s', async (entry) => {
    for (const original of [originalPosition, null]) {
      const person = await actor(`合成提示-${entry}-${original !== null}`, false, original);
      for (const destination of [source, target]) {
        const path =
          entry === 'legacy' ? `${BASE}/transfers/employees/${person.employeeId}/preview` : `${SELF}/preview`;
        const body =
          entry === 'legacy' ? legacyBody(destination) : { effectiveDate: date, fields: { departmentId: destination } };
        const preview = await w.json<{ positionCleared?: boolean; fields: object; before: { fields: object } }>(
          await api.request('POST', path, { ...w.as(person.userId), body }),
        );
        expect(preview.positionCleared).toBe(original !== null && destination !== source);
        expect(preview.fields).not.toHaveProperty('positionId');
        expect(preview.before.fields).not.toHaveProperty('positionId');
        expect(JSON.stringify(preview)).not.toContain(originalPosition);
        expect(JSON.stringify(preview)).not.toContain(targetPosition);
      }
      // 部门隐藏时提示元数据也不出现，不能绕过表单及字段裁剪泄漏新旧任职关系。
      const def = MODULE_OBJECTS.employmentRecord;
      await w.json(
        await setObjectPermission(
          admin,
          person.permissionProfile,
          {
            dataOperations: { create: true, update: true, delete: false },
            fields: def.fields.map((field) => ({
              fieldCode: field.code,
              view: field.code !== 'departmentId',
              edit: !field.system && field.code !== 'departmentId' && field.code !== 'positionId',
            })),
            buttons: def.buttons
              .filter((button) => button.code === 'Transfer.Self')
              .map((button) => ({ buttonCode: button.code, level: button.level })),
          },
          def.code,
        ),
      );
      const path = entry === 'legacy' ? `${BASE}/transfers/employees/${person.employeeId}/preview` : `${SELF}/preview`;
      const body = entry === 'legacy' ? { ...legacyBody(source), fields: {} } : { effectiveDate: date, fields: {} };
      const hidden = await w.json(await api.request('POST', path, { ...w.as(person.userId), body }));
      expect(hidden).not.toHaveProperty('positionCleared');
    }
  });

  it.each([false, true])('AC-TRF-56 部门延迟继承完成后保留或清空原职位：部门后来变化=%s', async (changed) => {
    const formId = 'TenantBase.TransferMultiFormView';
    const form = () => withTenant(database().db, w.tenant.id, (tx) => resolveTransferForm(tx, w.tenant.id, formId));
    const original = await form();
    const configure = async (fieldModes: Record<string, string>) => {
      const current = await form();
      await w.json(
        await w.request(w.hr.id, 'PUT', `${BASE}/transfers/forms/${formId}`, {
          ifMatch: current.revision,
          body: { name: original.name, group: 'transfer', fieldModes },
        }),
      );
    };
    await configure({ ...original.fieldModes, 'preset:departmentId': 'absent' });
    try {
      const person = await actor(`合成延迟部门-${changed}`);
      const created = await w.json<Business>(
        await api.request('POST', SELF, {
          ...w.as(person.userId),
          ifMatch: await revision(person),
          body: { effectiveDate: date, fields: {} },
        }),
        201,
      );
      await approve(person, created.id);
      if (changed) {
        // 在创建与落地之间追加更早的任职；部门到期才解析，不按新部门的职位自动匹配。
        await w.json(
          await w.request(w.hr.id, 'POST', `${BASE}/employees/${person.employeeId}/businesses`, {
            ifMatch: await revision(person),
            body: {
              kind: 'org_adjustment',
              mode: 'direct',
              effectiveDate: '2026-10-18',
              fields: { departmentId: target, positionId: targetPosition },
            },
          }),
          201,
        );
      }
      w.setNow(`${date}T01:00:00Z`);
      await runEmploymentActivations(
        database().db,
        { commandId: randomUUID(), actorUserId: w.hr.id },
        { tenantId: w.tenant.id },
        { clock: w.clock },
      );
      expect(await payload(created.id)).toMatchObject({
        status: 'effective',
        record: { fields: { departmentId: changed ? target : source, positionId: changed ? null : originalPosition } },
      });
    } finally {
      w.setNow('2026-10-01T01:00:00Z');
      await configure(original.fieldModes);
    }
  });

  it.each(['PATCH', 'submit'])('AC-TRF-57 HR 向后同步职位后，员工仅 %s 不被当成显式职位输入', async (action) => {
    const person = await actor(`合成传播职位-${action}`, true);
    const current = await w.json<{ items: { id: string; revision: number }[] }>(
      await w.request(w.hr.id, 'GET', `${BASE}/employees/${person.employeeId}/records`),
    );
    expect(current.items).toHaveLength(1);
    const hire = current.items[0]!;
    const created = await draft(person);
    await w.json(
      await w.request(w.hr.id, 'PATCH', `${BASE}/records/${hire.id}`, {
        ifMatch: hire.revision,
        body: { fields: { positionId: propagatedPosition.toUpperCase() } },
      }),
    );
    const saved = await payload(created.id);
    expect(saved).toMatchObject({ fields: { departmentId: source, positionId: propagatedPosition } });
    for (const positionId of [null, originalPosition, propagatedPosition.toUpperCase()]) {
      const beforeBusiness = await payload(created.id);
      const beforeProfile = await profile(person);
      const denied = await api.request('PATCH', `${BASE}/businesses/${created.id}`, {
        ...w.as(person.userId),
        ifMatch: saved.revision,
        body: { fields: { positionId } },
      });
      expect(denied.status).toBe(403);
      expect(await payload(created.id)).toEqual(beforeBusiness);
      expect(await profile(person)).toEqual(beforeProfile);
    }
    const options = {
      ...w.as(person.userId),
      ifMatch: saved.revision,
      idempotencyKey: randomUUID(),
      body: action === 'PATCH' ? { effectiveDate: '2026-10-20' } : {},
    };
    const path = `${BASE}/businesses/${created.id}${action === 'submit' ? '/submit' : ''}`;
    const method = action === 'PATCH' ? 'PATCH' : 'POST';
    const updated = await w.json<Business>(await api.request(method, path, options), 200);
    expect(await w.json(await api.request(method, path, options), 200)).toEqual(updated);
    expect(await payload(created.id)).toMatchObject({ fields: { positionId: propagatedPosition } });
  });
  it.each(
    ['inherit', 'deferred', 'hr-record', 'propagated', 'approval-edit'].flatMap((source) =>
      ['activate', 'revoke', 'delete', 'delete-effective'].map((end) => ({ source, end })),
    ),
  )('AC-TRF-58 可信职位完整生命周期：来源=$source，终点=$end', async ({ source: origin, end }) => {
    const person = await actor(`合成生命周期-${origin}-${end}`, true);
    const currentStatuses = await w.json<{ items: { employeeStatus: number; entryStatus: number | null }[] }>(
      await w.request(w.hr.id, 'GET', `${BASE}/employees/${person.employeeId}/records`),
    );
    const inheritedStatus = {
      employeeStatus: currentStatuses.items[0]!.employeeStatus,
      entryStatus: currentStatuses.items[0]!.entryStatus,
    };
    expect(typeof inheritedStatus.employeeStatus).toBe('number');
    const expectedPosition = ['hr-record', 'propagated'].includes(origin)
      ? propagatedPosition
      : origin === 'approval-edit'
        ? targetPosition
        : originalPosition;
    const departmentId = origin === 'approval-edit' ? target : source;
    const updateCurrent = async () => {
      const records = await w.json<{ items: { id: string; revision: number }[] }>(
        await w.request(w.hr.id, 'GET', `${BASE}/employees/${person.employeeId}/records`),
      );
      const hire = records.items[0]!;
      await w.json(
        await w.request(w.hr.id, 'PATCH', `${BASE}/records/${hire.id}`, {
          ifMatch: hire.revision,
          body: { fields: { positionId: propagatedPosition.toUpperCase() } },
        }),
      );
    };
    if (origin === 'hr-record') await updateCurrent();
    const formId = 'TenantBase.TransferMultiFormView';
    const form = () => withTenant(database().db, w.tenant.id, (tx) => resolveTransferForm(tx, w.tenant.id, formId));
    const original = await form();
    const configure = async (fieldModes: Record<string, string>) => {
      const current = await form();
      await w.json(
        await w.request(w.hr.id, 'PUT', `${BASE}/transfers/forms/${formId}`, {
          ifMatch: current.revision,
          body: { name: original.name, group: 'transfer', fieldModes },
        }),
      );
    };
    if (origin === 'deferred') await configure({ ...original.fieldModes, 'preset:departmentId': 'absent' });
    let saved: Business;
    const replays: Partial<Record<'create' | 'PATCH' | 'submit', () => Promise<Response>>> = {};
    try {
      const options = {
        ...w.as(person.userId),
        ifMatch: await revision(person),
        idempotencyKey: randomUUID(),
        body: { ...legacyBody(departmentId), ...(origin === 'deferred' ? { fields: {} } : {}) },
      };
      const path = `${BASE}/transfers/employees/${person.employeeId.toUpperCase()}`;
      saved = await w.json<Business>(await api.request('POST', path, options), 201);
      replays.create = () => api.request('POST', path, options);
      expect(await w.json(await replays.create(), 201)).toEqual(saved);
    } finally {
      if (origin === 'deferred') await configure(original.fieldModes);
    }
    if (origin === 'propagated') await updateCurrent();
    const command = async (action: 'PATCH' | 'submit', body: object = {}) => {
      const before = await payload(saved.id);
      const options = { ...w.as(person.userId), ifMatch: before.revision, idempotencyKey: randomUUID(), body };
      const path = `${BASE}/businesses/${saved.id.toUpperCase()}${action === 'submit' ? '/submit' : ''}`;
      const method = action === 'PATCH' ? 'PATCH' : 'POST';
      saved = await w.json<Business>(await api.request(method, path, options), 200);
      const replay = () => api.request(method, path, options);
      replays[action] = replay;
      expect(await w.json(await replay(), 200)).toEqual(saved);
    };
    if (origin === 'approval-edit') {
      await command('submit');
      let view = await w.instanceOf(saved.id, person.userId);
      const task = w.pending(view)[0]!;
      view = await w.json<InstanceView>(
        await w.taskAction(task.assigneeUserId!, task.id, 'edit', view.revision, {
          fields: { positionId: targetPosition.toUpperCase() },
        }),
      );
      await w.json(await w.instanceAction(person.userId, view.id, 'withdraw', view.revision));
    }
    // 来源均可在草稿、驳回、撤回三个状态修改与重提；字段权限只约束本次请求体。
    // 每个状态都真正再次改期（21 / 22 / 23 日），证明驳回、撤回后的改期同样不把可信职位当员工输入。
    const reschedule = { draft: '2026-10-21', reject: '2026-10-22', withdraw: '2026-10-23' } as const;
    for (const state of ['draft', 'reject', 'withdraw'] as const) {
      if (state !== 'draft') {
        const view = await w.instanceOf(saved.id, person.userId);
        const task = w.pending(view)[0]!;
        if (state === 'reject')
          await w.json(await w.taskAction(task.assigneeUserId!, task.id, 'reject', view.revision));
        else await w.json(await w.instanceAction(person.userId, view.id, 'withdraw', view.revision));
      }
      for (const positionId of [null, expectedPosition.toUpperCase()]) {
        const before = await payload(saved.id);
        const beforePerson = await profile(person);
        expect(
          (
            await api.request('PATCH', `${BASE}/businesses/${saved.id}`, {
              ...w.as(person.userId),
              ifMatch: before.revision,
              body: { fields: { positionId } },
            })
          ).status,
        ).toBe(403);
        expect(await payload(saved.id)).toEqual(before);
        expect(await profile(person)).toEqual(beforePerson);
      }
      await command('PATCH', { effectiveDate: reschedule[state], fields: { remarks: `合成-${state}` } });
      expect(await payload(saved.id)).toMatchObject({
        effectiveDate: reschedule[state],
        fields: { positionId: expectedPosition },
        ...inheritedStatus,
      });
      await command('submit');
      expect(await payload(saved.id)).toMatchObject({
        status: 'in_review',
        fields: { positionId: expectedPosition },
        ...inheritedStatus,
      });
    }
    if (end === 'activate' || end === 'delete-effective') {
      await approve(person, saved.id);
      // 计划 23 日，实际 24 日执行：迟到改期追加版本也不能把可信职位误认作员工输入。
      w.setNow('2026-10-24T01:00:00Z');
      try {
        for (let attempt = 0; attempt < 2; attempt++)
          await runEmploymentActivations(
            database().db,
            { commandId: randomUUID(), actorUserId: w.hr.id },
            { tenantId: w.tenant.id },
            { clock: w.clock },
          );
        expect(await payload(saved.id)).toMatchObject({
          status: 'effective',
          record: { ...inheritedStatus, fields: { departmentId, positionId: expectedPosition } },
        });
      } finally {
        w.setNow('2026-10-01T01:00:00Z');
      }
    }
    if (end !== 'activate') {
      if (end === 'delete') {
        const view = await w.instanceOf(saved.id, person.userId);
        await w.json(await w.instanceAction(person.userId, view.id, 'withdraw', view.revision));
      }
      const before = await payload(saved.id);
      const beforePerson = await profile(person);
      const path = `${BASE}/businesses/${saved.id}${end === 'revoke' ? '/revoke' : ''}`;
      const method = end === 'revoke' ? 'POST' : 'DELETE';
      expect(
        (await api.request(method, path, { ...w.as(person.userId), ifMatch: before.revision, body: {} })).status,
      ).toBe(403);
      expect(await payload(saved.id)).toEqual(before);
      expect(await profile(person)).toEqual(beforePerson);
      const options = { ifMatch: before.revision, idempotencyKey: randomUUID(), body: {} };
      const removed = await w.json(await w.request(w.hr.id, method, path, options), 200);
      expect(await w.json(await w.request(w.hr.id, method, path, options), 200)).toEqual(removed);
      expect(await payload(saved.id)).toMatchObject({ status: end === 'revoke' ? 'voided' : 'deleted', record: null });
      const records = await w.json<{ items: { fields: { positionId: string | null } }[] }>(
        await w.request(w.hr.id, 'GET', `${BASE}/employees/${person.employeeId}/records`),
      );
      expect(records.items).toHaveLength(1);
      if (end === 'delete-effective') {
        // 删除已生效调动：当前任职回到前一条（入职或 HR 改过的原任职），不残留调动带来的职位。
        const original = ['hr-record', 'propagated'].includes(origin) ? propagatedPosition : originalPosition;
        expect(records.items[0]!.fields.positionId).toBe(original);
      } else {
        expect(await profile(person)).toMatchObject({
          employee: { ...beforePerson.employee, revision: beforePerson.employee.revision + 1 },
          record: beforePerson.record,
        });
      }
    }
    const beforeReplay = await payload(saved.id);
    await withTenant(database().db, w.tenant.id, (tx) =>
      tx.execute(
        sql`DELETE FROM permission_user_person_links WHERE tenant_id=${w.tenant.id} AND user_id=${person.userId}::uuid`,
      ),
    );
    // 创建、PATCH、提交三条命令分别重放：解除绑定后都按当前绑定拒绝，不返回缓存结果、不泄漏职位。
    for (const replay of [replays.create!, replays.PATCH!, replays.submit!]) {
      const deniedReplay = await replay();
      expect(deniedReplay.status).toBe(403);
      expect(await deniedReplay.text()).not.toContain(expectedPosition);
      expect(await payload(saved.id)).toEqual(beforeReplay);
    }
  });
  it('AC-TRF-57 传播职位后换部门清空，后续改期重提与落地不还原', async () => {
    const person = await actor('合成传播换部门');
    const records = await w.json<{ items: { id: string; revision: number }[] }>(
      await w.request(w.hr.id, 'GET', `${BASE}/employees/${person.employeeId}/records`),
    );
    const hire = records.items[0]!;
    let saved = await draft(person);
    await w.json(
      await w.request(w.hr.id, 'PATCH', `${BASE}/records/${hire.id}`, {
        ifMatch: hire.revision,
        body: { fields: { positionId: propagatedPosition } },
      }),
    );
    for (const body of [{ fields: { departmentId: target.toUpperCase() } }, { effectiveDate: '2026-10-21' }]) {
      const current = await payload(saved.id);
      saved = await w.json<Business>(
        await api.request('PATCH', `${BASE}/businesses/${saved.id}`, {
          ...w.as(person.userId),
          ifMatch: current.revision,
          body,
        }),
      );
      expect(await payload(saved.id)).toMatchObject({ fields: { positionId: null, departmentId: target } });
    }
    await w.json(
      await api.request('POST', `${BASE}/businesses/${saved.id}/submit`, {
        ...w.as(person.userId),
        ifMatch: saved.revision,
        body: {},
      }),
    );
    await approve(person, saved.id);
    w.setNow('2026-10-21T01:00:00Z');
    try {
      await runEmploymentActivations(
        database().db,
        { commandId: randomUUID(), actorUserId: w.hr.id },
        { tenantId: w.tenant.id },
        { clock: w.clock },
      );
      expect(await payload(saved.id)).toMatchObject({
        status: 'effective',
        record: { fields: { positionId: null, departmentId: target } },
      });
    } finally {
      w.setNow('2026-10-01T01:00:00Z');
    }
  });

  it('AC-TRF-59 旧显式职位草稿按可信保存值修改提交，员工新增输入仍拒绝', async () => {
    const person = await actor('合成旧显式草稿', true);
    // 升级前的员工草稿：实际 HR 任职端口创建 editable 职位快照，再由可信夹具补入口来源。
    // 没有本人 / HR 标记、没有传播 triggerBusinessId；不关闭生产校验或改写历史任职版本。
    const created = await w.application(person.employeeId, { departmentId: source, positionId: originalPosition });
    await withTenant(database().db, w.tenant.id, (tx) =>
      tx.execute(sql`
      INSERT INTO transfer_requests(tenant_id,business_id,employee_id,initiator,transfer_type_code,process_code)
      VALUES(${w.tenant.id},${created.id}::uuid,${person.employeeId}::uuid,
        'employee','in_department','TransferProcessNew')
    `),
    );
    let saved: Pick<Business, 'revision'> = await payload(created.id);
    for (const positionId of [null, propagatedPosition.toUpperCase()]) {
      const before = await payload(created.id);
      expect(
        (
          await api.request('PATCH', `${BASE}/businesses/${created.id}`, {
            ...w.as(person.userId),
            ifMatch: saved.revision,
            body: { fields: { positionId } },
          })
        ).status,
      ).toBe(403);
      expect(await payload(created.id)).toEqual(before);
    }
    saved = await w.json<Business>(
      await api.request('PATCH', `${BASE}/businesses/${created.id}`, {
        ...w.as(person.userId),
        ifMatch: saved.revision,
        body: { effectiveDate: '2026-10-20' },
      }),
    );
    expect(await payload(created.id)).toMatchObject({ fields: { positionId: originalPosition } });
    await w.json(
      await api.request('POST', `${BASE}/businesses/${created.id}/submit`, {
        ...w.as(person.userId),
        ifMatch: saved.revision,
        body: {},
      }),
    );
    expect(await payload(created.id)).toMatchObject({ status: 'in_review', fields: { positionId: originalPosition } });
  });

  it.each([false, true])('AC-TRF-56 传播职位与部门延迟继承组合：实际跨部门=%s', async (changed) => {
    const formId = 'TenantBase.TransferMultiFormView';
    const form = () => withTenant(database().db, w.tenant.id, (tx) => resolveTransferForm(tx, w.tenant.id, formId));
    const original = await form();
    const configure = async (fieldModes: Record<string, string>) => {
      const current = await form();
      await w.json(
        await w.request(w.hr.id, 'PUT', `${BASE}/transfers/forms/${formId}`, {
          ifMatch: current.revision,
          body: { name: original.name, group: 'transfer', fieldModes },
        }),
      );
    };
    await configure({ ...original.fieldModes, 'preset:departmentId': 'absent' });
    try {
      const person = await actor(`合成传播延迟部门-${changed}`);
      const records = await w.json<{ items: { id: string; revision: number }[] }>(
        await w.request(w.hr.id, 'GET', `${BASE}/employees/${person.employeeId}/records`),
      );
      const hire = records.items[0]!;
      let saved = await w.json<Business>(
        await api.request('POST', `${BASE}/transfers/employees/${person.employeeId}`, {
          ...w.as(person.userId),
          ifMatch: await revision(person),
          body: { ...legacyBody(source), fields: {} },
        }),
        201,
      );
      await w.json(
        await w.request(w.hr.id, 'PATCH', `${BASE}/records/${hire.id}`, {
          ifMatch: hire.revision,
          body: { fields: { positionId: propagatedPosition } },
        }),
      );
      const propagated = await payload(saved.id);
      expect(propagated).toMatchObject({ fields: { positionId: propagatedPosition, departmentId: null } });
      saved = await w.json<Business>(
        await api.request('PATCH', `${BASE}/businesses/${saved.id}`, {
          ...w.as(person.userId),
          ifMatch: propagated.revision,
          body: { effectiveDate: '2026-10-21' },
        }),
      );
      await w.json(
        await api.request('POST', `${BASE}/businesses/${saved.id}/submit`, {
          ...w.as(person.userId),
          ifMatch: saved.revision,
          body: {},
        }),
      );
      await approve(person, saved.id);
      if (changed)
        await w.json(
          await w.request(w.hr.id, 'POST', `${BASE}/employees/${person.employeeId}/businesses`, {
            ifMatch: await revision(person),
            body: {
              kind: 'org_adjustment',
              mode: 'direct',
              effectiveDate: '2026-10-20',
              fields: { departmentId: target, positionId: targetPosition },
            },
          }),
          201,
        );
      w.setNow('2026-10-21T01:00:00Z');
      await runEmploymentActivations(
        database().db,
        { commandId: randomUUID(), actorUserId: w.hr.id },
        { tenantId: w.tenant.id },
        { clock: w.clock },
      );
      expect(await payload(saved.id)).toMatchObject({
        status: 'effective',
        record: {
          fields: { departmentId: changed ? target : source, positionId: changed ? null : propagatedPosition },
        },
      });
    } finally {
      w.setNow('2026-10-01T01:00:00Z');
      await configure(original.fieldModes);
    }
  });

  it('AC-TRF-56 未分组本人表单同时延迟继承部门与职位，保留两者标记到生效解析', async () => {
    const formId = `self-deferred-${randomUUID()}`;
    const form = await withTenant(database().db, w.tenant.id, (tx) =>
      resolveTransferForm(tx, w.tenant.id, 'TenantBase.TransferMultiFormView'),
    );
    await w.json(
      await w.request(w.hr.id, 'PUT', `${BASE}/transfers/forms/${formId}`, {
        ifMatch: 0,
        body: { name: '合成未分组本人调动', group: null, fieldModes: form.fieldModes },
      }),
    );
    const person = await actor('合成未分组延迟职位');
    const created = await w.json<Business>(
      await api.request('POST', `${BASE}/transfers/employees/${person.employeeId}`, {
        ...w.as(person.userId),
        ifMatch: await revision(person),
        body: { ...legacyBody(source, true), formId, fields: {} },
      }),
      201,
    );
    const stored = await withTenant(database().db, w.tenant.id, async (tx) => {
      const result = await tx.execute(
        sql`SELECT deferred_field_codes FROM employment_payload_versions
          WHERE tenant_id=${w.tenant.id} AND business_id=${created.id}::uuid
          ORDER BY version_no DESC LIMIT 1`,
      );
      return rowsOf<{ deferred_field_codes: string[] }>(result)[0]!;
    });
    expect(stored.deferred_field_codes).toEqual(expect.arrayContaining(['preset:departmentId', 'preset:positionId']));
    await approve(person, created.id);
    w.setNow(`${date}T01:00:00Z`);
    try {
      await runEmploymentActivations(
        database().db,
        { commandId: randomUUID(), actorUserId: w.hr.id },
        { tenantId: w.tenant.id },
        { clock: w.clock },
      );
      expect(await payload(created.id)).toMatchObject({
        status: 'effective',
        record: { fields: { departmentId: source, positionId: originalPosition } },
      });
    } finally {
      w.setNow('2026-10-01T01:00:00Z');
    }
  });
});
