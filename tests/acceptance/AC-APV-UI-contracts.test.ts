/** DEC-233：审批中心只读契约；不改变审批参与人的详情权限或既有写入口。 */
import { randomUUID } from 'node:crypto';
import { revokeMembership, sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  approvalWorld,
  grantFieldAccess,
  permissionAdmin,
  transferScene,
  type ApprovalWorld,
  type InstanceView,
} from './AC-APV-support.js';
import { createProfile, setObjectPermission, type PermissionWorld, type ProfileBody } from './AC-PRM-support.js';
import { MANAGER_PROFILE_CODE } from '../../apps/api/src/modules/permission/manager-identity.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const BASE = '/api/tenant/approval';
const FIELDS = ['id', 'departmentId', 'effectiveDate', 'place', 'remarks'];

interface EditableView extends InstanceView {
  readonly taskId: string | null;
  readonly retrieveTaskId: string | null;
  readonly form: InstanceView['form'] & {
    readonly editMode: 'none' | 'separate' | 'with_approve';
    readonly editableFields: string[];
  };
}

function pending(view: InstanceView) {
  const task = view.tasks.find((item) => item.status === 'pending');
  expect(task).toBeDefined();
  return task!;
}

async function scope(world: PermissionWorld, userId: string, orgIds: readonly string[], revision = 0) {
  const response = await world.api.request('PUT', `/api/tenant/permission/scopes/${userId}/TenantBase`, {
    ...world.asAdmin,
    ifMatch: revision,
    body: { kind: 'org_range', orgRanges: orgIds.map((orgId) => ({ orgId, includeDescendants: false })) },
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

async function rights(world: PermissionWorld, profile: ProfileBody, edit: readonly string[]) {
  const definition = MODULE_OBJECTS.employmentRecord;
  const response = await setObjectPermission(
    world,
    profile,
    {
      dataOperations: { create: false, update: edit.length > 0, delete: false },
      fields: definition.fields.map((field) => ({
        fieldCode: field.code,
        view: FIELDS.includes(field.code),
        edit: edit.includes(field.code),
      })),
      buttons: [],
    },
    definition.code,
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

async function editableScene(mode: 'separate' | 'with_approve' = 'separate') {
  const w = await approvalWorld(database().db, `apv-ui-${mode}`);
  const s = await transferScene(w);
  const world = await permissionAdmin(w);
  // 显式经理身份取代默认后备权限，使本夹具的字段授权可以收窄（DEC-042 多身份并集仍不变）。
  await createProfile(world, MANAGER_PROFILE_CODE);
  const profile = await grantFieldAccess(world, s.outHead.userId, { view: FIELDS, edit: ['place'] });
  await scope(world, s.outHead.userId, [s.from, s.to]);
  await w.publishedProcess({
    nodes: [
      {
        key: 'out_head',
        approver: 'latest_record_department_head',
        formFields: ['departmentId', 'effectiveDate', 'place'],
        editableFields: ['place', 'departmentId'],
        editMode: mode,
        actions: { transfer: true, addSign: true },
      },
    ],
  });
  const instance = await w.submit(
    await w.application(s.subject.employeeId, {
      departmentId: s.to,
      place: '当前地点',
    }),
  );
  const api = tenantApi(w.db, { authorize: undefined, clock: w.clock });
  const detail = async (userId = s.outHead.userId): Promise<EditableView> =>
    w.json(await api.request('GET', `${BASE}/instances/${instance.id}`, w.as(userId)));
  return { w, s, world, profile, instance, api, detail };
}

async function processed(w: ApprovalWorld, userId: string, query = '', api = w.api) {
  return w.json<{ items: { id: string; title: string; status: string }[]; page: number; pageSize: number }>(
    await api.request('GET', `${BASE}/instances?role=processed${query}`, w.as(userId)),
  );
}

describe('AC-APV-UI-01 / DEC-233：全身份已处理分页', () => {
  it('员工、经理、HR 本人 approve / transfer 算已处理，当前待办与抄送不算', async () => {
    const w = await approvalWorld(database().db, 'apv-ui-processed');
    const s = await transferScene(w);
    const employeeApprover = await w.member('普通员工审批人');
    const ccUser = await w.member('被抄送员工');
    await w.publishedProcess({
      nodes: [
        { key: 'manager', approver: 'latest_record_department_head', actions: { transfer: true, copySend: true } },
        { key: 'hr', approver: 'record_department_hrbp' },
        { key: 'pending', approver: 'record_department_head' },
      ],
    });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    view = await w.json(
      await w.request(s.outHead.userId, 'POST', `${BASE}/tasks/${pending(view).id}/cc`, {
        ifMatch: view.revision,
        body: { userIds: [ccUser] },
      }),
    );
    view = await w.json(
      await w.taskAction(s.outHead.userId, pending(view).id, 'transfer', view.revision, {
        toUserId: employeeApprover,
      }),
    );
    view = await w.json(await w.taskAction(employeeApprover, pending(view).id, 'approve', view.revision));
    view = await w.json(await w.taskAction(s.inHrbp.userId, pending(view).id, 'approve', view.revision));
    for (const userId of [employeeApprover, s.outHead.userId, s.inHrbp.userId]) {
      expect((await processed(w, userId)).items).toEqual([
        expect.objectContaining({
          id: view.id,
          title: '调动申请',
          status: 'running',
        }),
      ]);
    }
    for (const userId of [s.inHead.userId, ccUser, w.hr.id]) expect((await processed(w, userId)).items).toEqual([]);
  });

  it('范围过滤先于分页；撤销范围后历史不再出现，业务单与实例不变', async () => {
    const w = await approvalWorld(database().db, 'apv-ui-range');
    const s = await transferScene(w);
    const outside = await w.org('范围外部门');
    await w.setOrgRoles(outside, { head: s.outHead.employeeId });
    await w.publishedProcess({ nodes: [{ key: 'manager', approver: 'latest_record_department_head' }] });
    const ids: string[] = [];
    const businesses: string[] = [];
    for (const [index, departmentId] of [s.from, s.from, outside].entries()) {
      const person = await w.person(`分页员工${index}`, departmentId);
      const draft = await w.application(
        person.employeeId,
        { departmentId, place: `地点${index}` },
        {
          effectiveDate: '2026-11-01',
        },
      );
      let view = await w.submit(draft);
      view = await w.json(await w.taskAction(s.outHead.userId, pending(view).id, 'approve', view.revision));
      ids.push(view.id);
      businesses.push(draft.id);
      await withTenant(w.db, w.tenant.id, (tx) =>
        tx.execute(sql`UPDATE approval_instances
        SET created_at=${`2026-10-01T0${index}:00:00Z`}::timestamptz
        WHERE tenant_id=${w.tenant.id} AND id=${view.id}::uuid`),
      );
    }
    const world = await permissionAdmin(w);
    await grantFieldAccess(world, s.outHead.userId, { view: FIELDS });
    await scope(world, s.outHead.userId, [s.from]);
    const api = tenantApi(w.db, { authorize: undefined, clock: w.clock });
    expect(await processed(w, s.outHead.userId, '&page=1&pageSize=1', api)).toMatchObject({
      items: [expect.objectContaining({ id: ids[1], title: '调动申请' })],
      page: 1,
      pageSize: 1,
    });
    expect((await processed(w, s.outHead.userId, '&page=2&pageSize=1', api)).items).toEqual([
      expect.objectContaining({ id: ids[0], title: '调动申请' }),
    ]);
    const before = await w.business(businesses[0]!);
    const beforeInstance = await w.detail(ids[0]!);
    await scope(world, s.outHead.userId, [], 1);
    expect((await processed(w, s.outHead.userId, '', api)).items).toEqual([]);
    expect(await w.business(businesses[0]!)).toEqual(before);
    expect(await w.detail(ids[0]!)).toEqual(beforeInstance);
  });

  it('DEC-115 已办列表不带历史意见；被隐藏方的本人已办日志仍不可读', async () => {
    const w = await approvalWorld(database().db, 'apv-ui-hidden');
    const s = await transferScene(w);
    await w.publishedProcess({
      nodes: [
        { key: 'hidden', approver: 'latest_record_department_head', hideRecords: true },
        { key: 'next', approver: 'record_department_hrbp' },
      ],
    });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    view = await w.json(
      await w.taskAction(s.outHead.userId, pending(view).id, 'approve', view.revision, {
        comment: '仅供本用例检查隐藏的历史意见',
      }),
    );
    const list = await processed(w, s.outHead.userId);
    expect(list.items).toEqual([expect.objectContaining({ id: view.id, title: '调动申请' })]);
    expect(JSON.stringify(list)).not.toContain('历史意见');
    const hidden = await w.detail(view.id, s.outHead.userId);
    expect(hidden).toMatchObject({ recordsHidden: true, logs: [] });
    expect(hidden.tasks.every((task) => task.status === 'pending')).toBe(true);
  });
});

describe('AC-APV-UI-04 / DEC-233：实例节点编辑元数据与写校验一致', () => {
  it('节点配置中的业务抬头与当前业务不支持的字段不宣称可编辑；既有写入口400且数据不变', async () => {
    const w = await approvalWorld(database().db, 'apv-ui-edit-supported');
    const s = await transferScene(w);
    const unsupported = ['kind', 'mode', 'employType', 'lastWorkDate'];
    await w.publishedProcess({
      nodes: [
        {
          key: 'manager',
          approver: 'latest_record_department_head',
          formFields: ['departmentId', 'effectiveDate', 'place', ...unsupported],
          editableFields: ['place', ...unsupported],
          editMode: 'separate',
        },
      ],
    });
    const instance = await w.submit(
      await w.application(s.subject.employeeId, {
        departmentId: s.to,
        place: '当前地点',
      }),
    );
    const before = (await w.detail(instance.id, s.outHead.userId)) as EditableView;
    expect(before.form).toMatchObject({ editMode: 'separate', editableFields: ['place'] });
    const business = await w.business(instance.businessId);
    const response = await w.taskAction(s.outHead.userId, pending(instance).id, 'edit', instance.revision, {
      fields: { kind: 'leave' },
    });
    expect(response.status).toBe(400);
    expect(await w.detail(instance.id, s.outHead.userId)).toEqual(before);
    expect(await w.business(instance.businessId)).toEqual(business);
  });

  it.each(['separate', 'with_approve'] as const)(
    '%s 只返回已披露且当前可写字段；null 清空沿用同一权限',
    async (mode) => {
      const { w, s, api, detail, instance } = await editableScene(mode);
      const before = await detail();
      expect(before).toMatchObject({ taskId: pending(instance).id, retrieveTaskId: null });
      expect(before.form).toMatchObject({
        editMode: mode,
        editableFields: ['place'],
        values: { place: '当前地点', departmentId: s.to },
      });
      expect(before.form.values).not.toHaveProperty('remarks');
      expect(before).not.toHaveProperty('nodes');
      expect(before).not.toHaveProperty('definition');
      const denied = await api.request(
        'POST',
        `${BASE}/tasks/${before.taskId}/${mode === 'separate' ? 'edit' : 'approve'}`,
        {
          ...w.as(s.outHead.userId),
          ifMatch: before.revision,
          body: { fields: { departmentId: null } },
        },
      );
      expect(denied.status).toBe(403);
      expect(await detail()).toEqual(before);
      const response = await api.request(
        'POST',
        `${BASE}/tasks/${before.taskId}/${mode === 'separate' ? 'edit' : 'approve'}`,
        {
          ...w.as(s.outHead.userId),
          ifMatch: before.revision,
          body: { fields: { place: null } },
        },
      );
      expect(response.status, await response.clone().text()).toBe(200);
      expect((await w.business(instance.businessId)).fields.place).toBeNull();
    },
  );

  it('撤销编辑权立即收回元数据；旧编辑表单显式清空返回403且前后数据相同', async () => {
    const { w, s, world, profile, api, instance, detail } = await editableScene();
    const before = await detail();
    expect(before.form.editableFields).toEqual(['place']);
    const business = await w.business(instance.businessId);
    await rights(world, profile, []);
    const read = await detail();
    expect(read.form).toMatchObject({ editMode: 'none', editableFields: [], values: { place: '当前地点' } });
    const response = await api.request('POST', `${BASE}/tasks/${before.taskId}/edit`, {
      ...w.as(s.outHead.userId),
      ifMatch: before.revision,
      body: { fields: { place: null } },
    });
    expect(response.status).toBe(403);
    expect(await detail()).toEqual(read);
    expect(await w.business(instance.businessId)).toEqual(business);
  });

  it('范围撤回不剥夺本单最小披露，但不再公布可编辑元数据；发起人没有他人的任务目标', async () => {
    const { w, s, world, instance, detail } = await editableScene();
    expect((await detail()).form.editableFields).toEqual(['place']);
    const before = await w.business(instance.businessId);
    await scope(world, s.outHead.userId, [], 1);
    const read = await detail();
    expect(read.form).toMatchObject({ editMode: 'none', editableFields: [], values: { place: '当前地点' } });
    expect(read.taskId).toBe(pending(instance).id);
    expect(await w.business(instance.businessId)).toEqual(before);
    const initiator = await detail(w.hr.id);
    expect(initiator).toMatchObject({ taskId: null, retrieveTaskId: null });
    expect(initiator.form).toMatchObject({ editMode: 'none', editableFields: [] });
  });

  it('加签人只能审批，不获得原审批人的编辑配置；跨租户/非参与人404且业务未变', async () => {
    const { w, s, instance, detail, api } = await editableScene();
    const signer = await w.member('前加签员工');
    const other = await approvalWorld(database().db, 'apv-ui-foreign');
    const stranger = await w.member('未参与员工');
    const before = await w.business(instance.businessId);
    for (const options of [w.as(stranger), other.as(other.hr.id)]) {
      const response = await api.request('GET', `${BASE}/instances/${instance.id}`, options);
      expect(response.status).toBe(404);
      expect(await w.business(instance.businessId)).toEqual(before);
    }
    const transferred = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, pending(instance).id, 'add-sign', instance.revision, {
        type: 'before',
        userIds: [signer],
      }),
    );
    const signed = await w.json<EditableView>(await w.request(signer, 'GET', `${BASE}/instances/${instance.id}`));
    expect(signed.taskId).toBe(pending(transferred).id);
    expect(signed.form).toMatchObject({ editMode: 'none', editableFields: [] });
    expect((await detail()).form).toMatchObject({ editMode: 'none', editableFields: [] });
    expect((await processed(other, other.hr.id, `&businessId=${instance.businessId}`)).items).toEqual([]);
  });

  it('成员资格撤销后详情与已处理列表403，不泄露节点配置且业务未变', async () => {
    const { w, s, api, detail, instance } = await editableScene();
    const before = await w.business(instance.businessId);
    expect((await detail()).form).toMatchObject({ editMode: 'separate', editableFields: ['place'] });
    await revokeMembership(w.db, { tenantId: w.tenant.id, userId: s.outHead.userId, expectedRevision: 1 }, cmd());
    for (const path of [`${BASE}/instances/${instance.id}`, `${BASE}/instances?role=processed`]) {
      const response = await api.request('GET', path, w.as(s.outHead.userId));
      expect(response.status).toBe(403);
      expect(await response.json()).not.toHaveProperty('form');
      expect(await w.business(instance.businessId)).toEqual(before);
    }
  });

  it('盲审隐藏字段不进入编辑元数据；嵌套字段与清空不能绕过顶层写校验', async () => {
    const { w, s, world, profile, api, instance, detail } = await editableScene();
    // 只保留 place 查看/编辑权限，departmentId/effectiveDate 的变化因无查看权而形成盲审。
    const definition = MODULE_OBJECTS.employmentRecord;
    const response = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: false, update: true, delete: false },
        fields: definition.fields.map((field) => ({
          fieldCode: field.code,
          view: field.code === 'place',
          edit: field.code === 'place',
        })),
        buttons: [],
      },
      definition.code,
    );
    expect(response.status).toBe(200);
    const before = await detail();
    expect(before.form).toMatchObject({ editMode: 'none', editableFields: [], values: { place: '当前地点' } });
    expect(before.form.values).not.toHaveProperty('departmentId');
    expect(before.form.values).not.toHaveProperty('effectiveDate');
    const business = await w.business(instance.businessId);
    for (const fields of [{ 'contractChange.endDate': null }, { contractChange: { endDate: null } }]) {
      const denied = await api.request('POST', `${BASE}/tasks/${before.taskId}/edit`, {
        ...w.as(s.outHead.userId),
        ifMatch: before.revision,
        body: { fields },
      });
      expect(denied.status).toBe(403);
      expect(await detail()).toEqual(before);
      expect(await w.business(instance.businessId)).toEqual(business);
    }
  });

  it('隐藏历史时 retrieveTaskId 仍只给可撤回本人；已处理任务没有编辑元数据', async () => {
    const w = await approvalWorld(database().db, 'apv-ui-retrieve');
    const s = await transferScene(w);
    await w.publishedProcess({
      nodes: [
        { key: 'first', approver: 'latest_record_department_head', hideRecords: true, actions: { retrieve: true } },
        { key: 'next', approver: 'record_department_hrbp' },
      ],
    });
    let instance = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const approvedTask = pending(instance).id;
    instance = await w.json(await w.taskAction(s.outHead.userId, approvedTask, 'approve', instance.revision));
    const mine = await w.json<EditableView>(
      await w.request(s.outHead.userId, 'GET', `${BASE}/instances/${instance.id}`),
    );
    expect(mine).toMatchObject({ taskId: null, retrieveTaskId: approvedTask, recordsHidden: true, logs: [] });
    expect(mine.form).toMatchObject({ editMode: 'none', editableFields: [] });
    expect(mine.tasks).not.toContainEqual(expect.objectContaining({ id: approvedTask }));
    const next = await w.json<EditableView>(
      await w.request(s.inHrbp.userId, 'GET', `${BASE}/instances/${instance.id}`),
    );
    expect(next).toMatchObject({ taskId: pending(instance).id, retrieveTaskId: null });
  });

  it('真实嵌套合同清空按合同字段权限披露：可见值正确，隐藏null字段缺席，容器不变成可编辑字段', async () => {
    const w = await approvalWorld(database().db, 'apv-ui-nested');
    const s = await transferScene(w);
    const world = await permissionAdmin(w);
    await grantFieldAccess(world, s.outHead.userId, {
      view: [...FIELDS, 'isChangeContract', 'contractChange'],
      edit: ['place', 'contractChange'],
    });
    await grantFieldAccess(
      world,
      s.outHead.userId,
      {
        view: ['id', 'endDate'],
      },
      MODULE_OBJECTS.contract,
    );
    await scope(world, s.outHead.userId, [s.from, s.to]);
    await w.publishedProcess({
      nodes: [
        {
          key: 'manager',
          approver: 'latest_record_department_head',
          formFields: ['departmentId', 'effectiveDate', 'place', 'isChangeContract', 'contractChange'],
          editableFields: ['place', 'contractChange'],
          editMode: 'separate',
        },
      ],
    });
    const master = async (kind: string) =>
      w.json<{ id: string }>(
        await w.request(w.hr.id, 'POST', `/api/tenant/contracts/master-data/${kind}`, {
          ifMatch: 0,
          body: { code: randomUUID(), name: `合成${kind}` },
        }),
        201,
      );
    const type = await master('types');
    const company = await master('companies');
    const contract = await w.json<{ id: string }>(
      await w.request(w.hr.id, 'POST', '/api/tenant/contracts/commands', {
        ifMatch: 0,
        body: {
          operation: 'create',
          mode: 'direct',
          employeeId: s.subject.employeeId,
          fields: {
            typeId: type.id,
            companyId: company.id,
            effectiveDate: '2026-01-01',
            endDate: '2027-12-31',
            termType: 'fixed',
            termMonths: 24,
            probationSalary: '50000.00',
          },
        },
      }),
      201,
    );
    const draft = await w.json<{ id: string; revision: number }>(
      await w.request(w.hr.id, 'POST', `/api/tenant/employment/transfers/employees/${s.subject.employeeId}`, {
        ifMatch: await w
          .json<{ revision: number }>(
            await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${s.subject.employeeId}`),
          )
          .then((employee) => employee.revision),
        body: {
          initiator: 'hr',
          transferTypeCode: 'cross_department',
          mode: 'application',
          effectiveDate: '2026-10-10',
          fields: { departmentId: s.to, place: '新地点' },
          linkage: { contract: { targetId: contract.id, fields: { endDate: '2028-12-31', probationSalary: null } } },
        },
      }),
      201,
    );
    const instance = await w.submit(draft);
    const api = tenantApi(w.db, { authorize: undefined, clock: w.clock });
    const view = await w.json<EditableView>(
      await api.request('GET', `${BASE}/instances/${instance.id}`, w.as(s.outHead.userId)),
    );
    expect(view.form.values).toMatchObject({
      place: '新地点',
      'contractChange.targetId': contract.id,
      'contractChange.endDate': '2028-12-31',
    });
    expect(view.form.values).not.toHaveProperty('contractChange.probationSalary');
    expect(view.form.values).not.toHaveProperty('contractChange');
    expect(view.form).toMatchObject({ editMode: 'none', editableFields: [] });
    expect(view.actions).not.toContain('approve');
    expect(await w.business(draft.id)).toMatchObject({ status: 'in_review', fields: { place: '新地点' } });
  });
});
