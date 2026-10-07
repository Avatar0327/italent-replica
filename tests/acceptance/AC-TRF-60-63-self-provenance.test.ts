import { randomUUID } from 'node:crypto';
import { runEmploymentActivations } from '@italent/api';
import { permissionUserPersonLinks, sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { approvalWorld, permissionAdmin, type InstanceView, type Person } from './AC-APV-support.js';
import { createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { allowAll, tenantApi } from './support/tenant-api.js';
import { rowsOf } from '../../apps/api/src/modules/employment/record-store.js';
import { createEmploymentBusiness } from '../../apps/api/src/modules/employment/write-service.js';
import { runSequenceSyncJobs } from '../../apps/api/src/modules/job/sequence-worker.js';
import { resolveTransferForm } from '../../apps/api/src/modules/transfer/configuration.js';

// PR #99 第 4 轮：只读字段逐字段判定来源（AC-TRF-60）、职位单独延迟继承（AC-TRF-61）、审批节点编辑 × 职位来源（AC-TRF-62）、
// 落地后 HR 经页面 / 导入 / 批量编辑补职位（AC-TRF-63）。
const database = useTestDb();
const BASE = '/api/tenant/employment';
const FORM = 'TenantBase.TransferMultiFormView';
const date = '2026-10-19';
let w: Awaited<ReturnType<typeof approvalWorld>>;
let api: ReturnType<typeof tenantApi>;
let admin: Awaited<ReturnType<typeof permissionAdmin>>;
let source: string;
let target: string;
let postId: string;
let violationPost: string;
let violationPosition: string;
let levelId: string;
let otherLevel: string;
let sequenceId: string;
let originalPosition: string;
let otherPosition: string;
let targetPosition: string;

interface Business {
  id: string;
  revision: number;
  status: string;
  fields: Record<string, unknown>;
  record: { fields: Record<string, unknown> } | null;
}
interface Job {
  postId: string;
  positionId: string;
  next: string;
}
async function job(kind: string, body: Record<string, unknown>) {
  const created = await w.json<{ id: string }>(
    await w.request(w.hr.id, 'POST', `/api/tenant/job/${kind}`, {
      ifMatch: 0,
      body: { code: `J-${randomUUID()}`, name: `合成-${randomUUID()}`, startDate: '2020-01-01', ...body },
    }),
    201,
  );
  return created.id;
}
/** 序列同步用例各用一个独立职务，避免共享职务的序列在用例之间串改。 */
async function syncedJob(): Promise<Job> {
  const post = await job('posts', { sequenceId });
  return {
    postId: post,
    positionId: await job('positions', { orgId: source, postId: post }),
    next: await job('sequences', {}),
  };
}
async function bind(person: Person) {
  const profile = await createProfile(admin, `provenance-${randomUUID()}`);
  const def = MODULE_OBJECTS.employmentRecord;
  await w.json(
    await setObjectPermission(
      admin,
      profile,
      {
        dataOperations: { create: true, update: true, delete: false },
        fields: def.fields.map((field) => ({ fieldCode: field.code, view: true, edit: !field.system })),
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
      body: { kind: 'org_range', orgRanges: [source, target].map((orgId) => ({ orgId, includeDescendants: false })) },
    }),
  );
  return person;
}
function hireFields(synced?: Job) {
  return {
    departmentId: source,
    positionId: synced?.positionId ?? originalPosition,
    postId: synced?.postId ?? postId,
    levelId,
    sequenceId,
  };
}
async function actor(label: string, synced?: Job) {
  return bind(await w.person(label, source, hireFields(synced)));
}
/** 试用期员工：试用状态只能经可信入职端口写入（无 HTTP 入口），用于触发转正的人员状态传播。 */
async function probationer(label: string) {
  const userId = await w.member(label);
  const employee = await w.employee(label);
  await withTenant(database().db, w.tenant.id, async (tx) => {
    await tx.insert(permissionUserPersonLinks).values({ tenantId: w.tenant.id, userId, employeeId: employee.id });
    await createEmploymentBusiness(
      tx,
      {
        tenantId: w.tenant.id,
        userId: w.hr.id,
        timezone: w.tenant.timezone,
        now: w.clock(),
        commandId: randomUUID(),
        expectedRevision: employee.revision,
      },
      employee.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { employType: 'internal', ...hireFields() },
      },
      { entry: { probation: true } },
    );
  });
  return bind({ userId, employeeId: employee.id, name: label });
}
async function revision(person: Person) {
  const profile = await w.json<{ employee: { revision: number } }>(
    await api.request('GET', '/api/tenant/self-service/profile', w.as(person.userId)),
  );
  return profile.employee.revision;
}
async function profile(person: Person) {
  return w.json(await api.request('GET', '/api/tenant/self-service/profile', w.as(person.userId)));
}
async function payload(id: string) {
  return (await w.business(id)) as unknown as Business;
}
async function latestVersion(id: string) {
  return withTenant(database().db, w.tenant.id, async (tx) => {
    const [row] = rowsOf<{
      triggerBusinessId: string | null;
      explicit: string[];
      deferred: string[];
      sequenceId: string | null;
      employeeStatus: number;
    }>(
      await tx.execute(sql`
        SELECT trigger_business_id AS "triggerBusinessId", explicit_field_codes AS explicit,
          deferred_field_codes AS deferred, sequence_id AS "sequenceId", employee_status AS "employeeStatus"
        FROM employment_payload_versions WHERE tenant_id=${w.tenant.id} AND business_id=${id}::uuid
        ORDER BY version_no DESC LIMIT 1`),
    );
    return row!;
  });
}
/** 升级前的员工草稿：经 HR 端口写入旧式快照，再由可信夹具补入口来源，不关闭生产校验。 */
/** submit=true 时先由员工本人送审再补来源，模拟升级前已在途的单据（序列同步只处理审批中 / 已批申请）。 */
async function legacyDraft(person: Person, fields: Record<string, unknown>, submit = false) {
  const created = await w.application(person.employeeId, { departmentId: source, ...fields }, { effectiveDate: date });
  if (submit) await w.json(await w.submitRaw(created, person.userId));
  await withTenant(database().db, w.tenant.id, (tx) =>
    tx.execute(sql`
    INSERT INTO transfer_requests(tenant_id,business_id,employee_id,initiator,transfer_type_code,process_code)
    VALUES(${w.tenant.id},${created.id}::uuid,${person.employeeId}::uuid,
      'employee','in_department','TransferProcessNew')
  `),
  );
  return created;
}
async function currentRecord(person: Person) {
  const records = await w.json<{ items: { id: string; revision: number }[] }>(
    await w.request(w.hr.id, 'GET', `${BASE}/employees/${person.employeeId}/records`),
  );
  return records.items.at(-1)!;
}
async function editCurrent(person: Person, fields: Record<string, unknown>) {
  const current = await currentRecord(person);
  await w.json(
    await w.request(w.hr.id, 'PATCH', `${BASE}/records/${current.id}`, { ifMatch: current.revision, body: { fields } }),
  );
}
/** HR 经任职导入（编辑模式）修改任职记录；导入编辑始终向后更新（07 A7.1）。 */
function importEdit(person: Person, record: { id: string; revision: number }, fields: Record<string, unknown>) {
  return revision(person).then((ifMatch) =>
    w.request(w.hr.id, 'POST', `${BASE}/employees/${person.employeeId}/import`, {
      ifMatch,
      body: { items: [{ operation: 'edit', id: record.id, revision: record.revision, patch: { fields } }] },
    }),
  );
}
/** 未分组（group:null）自定义调动表单：未带出的字段全部留待生效时继承。 */
async function ungroupedForm() {
  const formId = `self-position-deferred-${randomUUID()}`;
  const form = await withTenant(database().db, w.tenant.id, (tx) => resolveTransferForm(tx, w.tenant.id, FORM));
  await w.json(
    await w.request(w.hr.id, 'PUT', `${BASE}/transfers/forms/${formId}`, {
      ifMatch: 0,
      body: { name: '合成未分组本人调动', group: null, fieldModes: form.fieldModes },
    }),
  );
  return formId;
}
async function adjust(person: Person, effectiveDate: string) {
  return w.json<{ id: string }>(
    await w.request(w.hr.id, 'POST', `${BASE}/employees/${person.employeeId}/businesses`, {
      ifMatch: await revision(person),
      body: {
        kind: 'org_adjustment',
        mode: 'direct',
        effectiveDate,
        fields: { departmentId: source, positionId: otherPosition },
      },
    }),
    201,
  );
}
async function syncSequence(synced: Job) {
  const post = await w.json<{ revision: number }>(
    await w.request(w.hr.id, 'GET', `/api/tenant/job/posts/${synced.postId}`),
  );
  await w.json(
    await w.request(w.hr.id, 'PATCH', `/api/tenant/job/posts/${synced.postId}`, {
      ifMatch: post.revision,
      body: { sequenceId: synced.next, effectiveDate: '2026-10-01', syncSequenceToAssignments: true },
    }),
  );
  // 与 AC-JOB-08～11 一致，用放行授权器执行异步任务；本用例只关心版本链来源。
  await runSequenceSyncJobs(database().db, w.tenant.id, { clock: w.clock, authorize: allowAll });
}
async function regularize(person: Person) {
  await w.json(
    await w.request(w.hr.id, 'POST', `${BASE}/employees/${person.employeeId}/businesses`, {
      ifMatch: await revision(person),
      body: { kind: 'regularization', mode: 'direct', effectiveDate: '2026-10-10', fields: {} },
    }),
    201,
  );
}
/** 员工只改日期或直接提交：旧违规字段仍须 403，单据与档案前后一致。 */
async function expectDenied(person: Person, id: string, action: 'PATCH' | 'submit') {
  const before = await payload(id);
  const beforePerson = await profile(person);
  const response = await api.request(
    action === 'PATCH' ? 'PATCH' : 'POST',
    `${BASE}/businesses/${id}${action === 'submit' ? '/submit' : ''}`,
    {
      ...w.as(person.userId),
      ifMatch: before.revision,
      idempotencyKey: randomUUID(),
      body: action === 'PATCH' ? { effectiveDate: '2026-10-21' } : {},
    },
  );
  expect(response.status, await response.clone().text()).toBe(403);
  expect(await payload(id)).toEqual(before);
  expect(await profile(person)).toEqual(beforePerson);
}
/** 员工命令（PATCH / 提交）成功且同键重放结果一致。 */
async function command(person: Person, id: string, action: 'PATCH' | 'submit', body: object = {}) {
  const before = await payload(id);
  const options = { ...w.as(person.userId), ifMatch: before.revision, idempotencyKey: randomUUID(), body };
  const path = `${BASE}/businesses/${id}${action === 'submit' ? '/submit' : ''}`;
  const method = action === 'PATCH' ? 'PATCH' : 'POST';
  const saved = await w.json<Business>(await api.request(method, path, options));
  expect(await w.json(await api.request(method, path, options))).toEqual(saved);
  return saved;
}
async function selfCreate(person: Person, fields: Record<string, unknown>, submit: boolean, formId = FORM) {
  return w.json<Business>(
    await api.request('POST', `${BASE}/transfers/employees/${person.employeeId}`, {
      ...w.as(person.userId),
      ifMatch: await revision(person),
      body: {
        initiator: 'employee',
        transferTypeCode: 'in_department',
        formId,
        effectiveDate: date,
        mode: 'application',
        submit,
        fields,
      },
    }),
    201,
  );
}
async function sendBack(person: Person, id: string, back: 'reject' | 'withdraw') {
  const view = await w.instanceOf(id, person.userId);
  if (back === 'withdraw') {
    await w.json(await w.instanceAction(person.userId, view.id, 'withdraw', view.revision));
    return;
  }
  const task = w.pending(view)[0]!;
  await w.json(await w.taskAction(task.assigneeUserId!, task.id, 'reject', view.revision));
}
async function nodeEdit(person: Person, id: string, fields: Record<string, unknown>) {
  const view = await w.instanceOf(id, person.userId);
  const task = w.pending(view)[0]!;
  return w.taskAction(task.assigneeUserId!, task.id, 'edit', view.revision, { fields });
}
async function approve(person: Person, id: string) {
  const view = await w.instanceOf(id, person.userId);
  const task = w.pending(view)[0]!;
  return w.json<InstanceView>(await w.taskAction(task.assigneeUserId!, task.id, 'approve', view.revision));
}
async function activate(at: string) {
  w.setNow(`${at}T01:00:00Z`);
  try {
    await runEmploymentActivations(
      database().db,
      { commandId: randomUUID(), actorUserId: w.hr.id },
      { tenantId: w.tenant.id },
      { clock: w.clock },
    );
  } finally {
    w.setNow('2026-10-01T01:00:00Z');
  }
}
async function withSharedForm<T>(fieldModes: Record<string, string>, run: () => Promise<T>) {
  const form = () => withTenant(database().db, w.tenant.id, (tx) => resolveTransferForm(tx, w.tenant.id, FORM));
  const original = await form();
  const configure = async (modes: Record<string, string>) =>
    w.json(
      await w.request(w.hr.id, 'PUT', `${BASE}/transfers/forms/${FORM}`, {
        ifMatch: (await form()).revision,
        body: { name: original.name, group: 'transfer', fieldModes: modes },
      }),
    );
  await configure({ ...original.fieldModes, ...fieldModes });
  try {
    return await run();
  } finally {
    await configure(original.fieldModes);
  }
}

beforeAll(async () => {
  w = await approvalWorld(database().db, 'self-provenance');
  api = tenantApi(database().db, { authorize: undefined, clock: w.clock });
  admin = await permissionAdmin(w);
  source = await w.org('合成来源原部门');
  target = await w.org('合成来源新部门');
  sequenceId = await job('sequences', {});
  postId = await job('posts', { sequenceId });
  violationPost = await job('posts', { sequenceId });
  const levelTypeId = await job('level-types', {});
  levelId = await job('levels', { level: 3, levelTypeId });
  otherLevel = await job('levels', { level: 4, levelTypeId });
  originalPosition = await job('positions', { orgId: source, postId });
  otherPosition = await job('positions', { orgId: source, postId });
  targetPosition = await job('positions', { orgId: target, postId });
  violationPosition = await job('positions', { orgId: source, postId: violationPost });
  const editable = ['positionId', 'levelId', 'remarks'];
  await w.publishedProcess({
    nodes: [
      {
        key: 'review',
        approver: 'owner',
        formFields: ['departmentId', ...editable],
        editableFields: editable,
        editMode: 'separate',
      },
    ],
  });
});

describe('AC-TRF-60 旧违规职务 / 职级 / 序列逐字段判定来源，无关传播不得放行', () => {
  const VIOLATIONS: Record<'postId' | 'levelId' | 'sequenceId', () => Record<string, unknown>> = {
    // 旧草稿另配职务下的职位，避免被“职位与所选职务不一致”拦在建单阶段。
    postId: () => ({ postId: violationPost, positionId: violationPosition }),
    levelId: () => ({ levelId: null }),
    sequenceId: () => ({ sequenceId: null }),
  };
  it.each(
    (['postId', 'levelId', 'sequenceId'] as const).flatMap((field) =>
      (['PATCH', 'submit'] as const).map((action) => ({ field, action })),
    ),
  )('AC-TRF-60 任职其他字段向后更新后旧违规 $field 仍拒绝：$action', async ({ field, action }) => {
    const person = await actor(`合成旧违规-${field}-${action}`);
    const created = await legacyDraft(person, VIOLATIONS[field]());
    // 审查原文第 2 步：传播之前即 403。
    await expectDenied(person, created.id, action);
    // HR 改当前任职的工作地点，向后更新只写入地点；旧违规字段未被本次传播覆盖。
    await editCurrent(person, { place: `合成地点-${field}` });
    const latest = await latestVersion(created.id);
    expect(latest.triggerBusinessId).toEqual(expect.any(String));
    expect(latest.explicit).toEqual(expect.arrayContaining([`preset:${field}`, 'preset:place']));
    await expectDenied(person, created.id, action);
  });

  it.each(['postId', 'levelId'] as const)('AC-TRF-60 职务序列同步只覆盖序列，旧违规 %s 仍拒绝', async (field) => {
    const synced = await syncedJob();
    // 同步按职务引用找目标：违规职务直接指向被同步职务；违规职级的员工本就任该职务。
    const person = await actor(`合成旧违规-序列同步-${field}`, field === 'levelId' ? synced : undefined);
    const violation = field === 'postId' ? { postId: synced.postId, positionId: synced.positionId } : { levelId: null };
    const created = await legacyDraft(person, violation, true);
    await syncSequence(synced);
    expect(await latestVersion(created.id)).toMatchObject({
      triggerBusinessId: expect.any(String),
      sequenceId: synced.next,
    });
    await sendBack(person, created.id, 'reject');
    await expectDenied(person, created.id, 'PATCH');
    await expectDenied(person, created.id, 'submit');
  });

  it.each(['postId', 'levelId', 'sequenceId'] as const)(
    'AC-TRF-60 人员状态传播不改任职字段，旧违规 %s 仍拒绝',
    async (field) => {
      const person = await probationer(`合成旧违规-状态传播-${field}`);
      const created = await legacyDraft(person, VIOLATIONS[field]());
      await regularize(person);
      expect(await latestVersion(created.id)).toMatchObject({
        triggerBusinessId: expect.any(String),
        employeeStatus: 3,
      });
      await expectDenied(person, created.id, 'submit');
      await expectDenied(person, created.id, 'PATCH');
    },
  );

  it('AC-TRF-60 第 3 轮式 employeeTransfer 标记不把旧违规字段延续为可信', async () => {
    const person = await actor('合成旧违规-标记延续');
    const created = await legacyDraft(person, { levelId: null });
    // 可信夹具：模拟第 3 轮代码放行一次员工 PATCH 后留下的版本——冻结快照被标成本人入口、旧违规值原样沿用。
    await withTenant(database().db, w.tenant.id, async (tx) => {
      await tx.execute(sql`
        INSERT INTO employment_payload_versions
        SELECT (jsonb_populate_record(NULL::employment_payload_versions, to_jsonb(p) || jsonb_build_object(
          'id', gen_random_uuid(), 'version_no', p.version_no + 1, 'previous_version_id', p.id,
          'form_snapshot', p.form_snapshot || '{"employeeTransfer":true}'::jsonb))).*
        FROM employment_payload_versions p
        WHERE p.tenant_id=${w.tenant.id} AND p.business_id=${created.id}::uuid
        ORDER BY p.version_no DESC LIMIT 1`);
      await tx.execute(sql`UPDATE employment_business_objects SET revision=revision+1
        WHERE tenant_id=${w.tenant.id} AND id=${created.id}::uuid`);
    });
    await expectDenied(person, created.id, 'PATCH');
    await expectDenied(person, created.id, 'submit');
  });

  it('AC-TRF-60 序列同步实际覆盖的旧违规序列转为可信，改期重提成功', async () => {
    const synced = await syncedJob();
    const person = await actor('合成旧违规-序列被覆盖', synced);
    const created = await legacyDraft(person, { sequenceId: null }, true);
    await syncSequence(synced);
    expect(await latestVersion(created.id)).toMatchObject({ sequenceId: synced.next });
    await sendBack(person, created.id, 'withdraw');
    await command(person, created.id, 'PATCH', { effectiveDate: '2026-10-21' });
    await command(person, created.id, 'submit');
    expect(await payload(created.id)).toMatchObject({ status: 'in_review', fields: { sequenceId: synced.next } });
  });

  it('AC-TRF-60 导入编辑触发的向后更新：旧违规职务仍拒绝，传播写入的职位可信', async () => {
    const legacy = await actor('合成导入传播-旧违规');
    const violating = await legacyDraft(legacy, VIOLATIONS.postId());
    await w.json(await importEdit(legacy, await currentRecord(legacy), { place: '合成导入地点' }));
    expect(await latestVersion(violating.id)).toMatchObject({ triggerBusinessId: expect.any(String) });
    await expectDenied(legacy, violating.id, 'submit');
    const person = await actor('合成导入传播-合法');
    const created = await selfCreate(person, { departmentId: source }, false);
    await w.json(await importEdit(person, await currentRecord(person), { positionId: otherPosition }));
    expect(await payload(created.id)).toMatchObject({ fields: { positionId: otherPosition } });
    await command(person, created.id, 'PATCH', { effectiveDate: '2026-10-21' });
    await command(person, created.id, 'submit');
    expect(await payload(created.id)).toMatchObject({ status: 'in_review', fields: { positionId: otherPosition } });
  });

  it('AC-TRF-60 审批节点也不能为本人调动写入职务 / 职级 / 序列，不存在非传播的可信写入者', async () => {
    const person = await actor('合成节点编辑职级');
    const created = await selfCreate(person, { departmentId: source }, true);
    const before = await payload(created.id);
    const denied = await nodeEdit(person, created.id, { levelId: otherLevel.toUpperCase() });
    expect(denied.status).toBe(403);
    expect(await payload(created.id)).toEqual(before);
  });

  it.each(
    (['sequence', 'status'] as const).flatMap((propagation) =>
      (['reject', 'withdraw'] as const).map((back) => ({ propagation, back })),
    ),
  )(
    'AC-TRF-60 序列同步 / 状态传播后合法本人申请修改重提，职位与传播值保留：传播=$propagation，退回=$back',
    async ({ propagation, back }) => {
      const synced = propagation === 'sequence' ? await syncedJob() : undefined;
      const person =
        propagation === 'status'
          ? await probationer(`合成合法传播-${back}`)
          : await actor(`合成合法同步-${back}`, synced);
      const position = synced?.positionId ?? originalPosition;
      const created = await selfCreate(person, { departmentId: source }, true);
      // 状态传播改动审批表单可见的载荷后实例冻结（APPROVAL_BUSINESS_CHANGED），审批人不能再驳回，故先驳回再传播；
      // 状态传播同样处理已驳回单据。序列不在节点表单字段内，同步后仍可驳回；序列同步只处理在途单据，故先同步。
      const rejectFirst = !synced && back === 'reject';
      if (rejectFirst) await sendBack(person, created.id, 'reject');
      if (synced) await syncSequence(synced);
      else await regularize(person);
      const propagated = synced ? { sequenceId: synced.next } : { employeeStatus: 3 };
      expect(await latestVersion(created.id)).toMatchObject({ triggerBusinessId: expect.any(String), ...propagated });
      if (!rejectFirst) await sendBack(person, created.id, back);
      await command(person, created.id, 'PATCH', { effectiveDate: '2026-10-21' });
      await command(person, created.id, 'submit');
      expect(await payload(created.id)).toMatchObject({ status: 'in_review', fields: { positionId: position } });
      expect(await latestVersion(created.id)).toMatchObject(propagated);
      await approve(person, created.id);
      await activate('2026-10-21');
      expect(await payload(created.id)).toMatchObject({
        status: 'effective',
        record: { fields: { departmentId: source, positionId: position, ...(synced ? propagated : {}) } },
      });
    },
  );
});

describe('AC-TRF-61 部门明确、职位单独延迟继承：生效时按前驱继承再判断', () => {
  it.each([
    // 审查原文路径：建草稿 → HR 删除较早调整 → 直接提交、审批、落地，不经草稿修改。
    { scenario: 'deleted', patch: false },
    // 草稿改期发生在删除调整之前：改期时前驱仍是 A/P2，不能借改期把职位提前固定。
    { scenario: 'deleted', patch: true },
    { scenario: 'kept', patch: true },
    { scenario: 'cross', patch: true },
  ] as const)(
    'AC-TRF-61 未分组本人表单显式部门、不填职位，较早组织调整=$scenario，草稿改期=$patch',
    async ({ scenario, patch }) => {
      const formId = await ungroupedForm();
      const person = await actor(`合成职位单独延迟-${scenario}-${patch}`);
      // 审查原文路径用今日已生效的调整；其余用未来日期的已批直接调整，覆盖两种前驱。
      const adjustment = scenario === 'cross' ? null : await adjust(person, patch ? '2026-10-18' : '2026-10-01');
      const departmentId = scenario === 'cross' ? target : source;
      const created = await selfCreate(person, { departmentId }, false, formId);
      const deferred = async () => {
        const latest = await latestVersion(created.id);
        expect(latest.deferred).toContain('preset:positionId');
        expect(latest.deferred).not.toContain('preset:departmentId');
      };
      await deferred();
      if (patch) {
        await command(person, created.id, 'PATCH', { effectiveDate: '2026-10-20' });
        await deferred();
      }
      if (scenario === 'deleted') {
        const removed = await w.business(adjustment!.id);
        await w.json(
          await w.request(w.hr.id, 'DELETE', `${BASE}/businesses/${adjustment!.id}`, {
            ifMatch: removed.revision,
            body: {},
          }),
        );
      }
      await command(person, created.id, 'submit');
      await approve(person, created.id);
      await activate(patch ? '2026-10-20' : date);
      const expected = { deleted: originalPosition, kept: otherPosition, cross: null }[scenario];
      expect(await payload(created.id)).toMatchObject({
        status: 'effective',
        record: { fields: { departmentId, positionId: expected } },
      });
    },
  );
});

describe('AC-TRF-62 审批节点编辑 × 职位来源', () => {
  it.each(['inherit', 'deferred', 'position-deferred', 'hr-record', 'propagated', 'sequence', 'status'] as const)(
    'AC-TRF-62 审批节点编辑非职位字段不改变职位来源：来源=%s',
    async (origin) => {
      const synced = origin === 'sequence' ? await syncedJob() : undefined;
      const person =
        origin === 'status' ? await probationer(`合成节点-${origin}`) : await actor(`合成节点-${origin}`, synced);
      if (origin === 'hr-record') await editCurrent(person, { positionId: otherPosition });
      const formId = origin === 'position-deferred' ? await ungroupedForm() : FORM;
      const create = () => selfCreate(person, origin === 'deferred' ? {} : { departmentId: source }, true, formId);
      const created =
        origin === 'deferred' ? await withSharedForm({ 'preset:departmentId': 'absent' }, create) : await create();
      if (origin === 'propagated') await editCurrent(person, { positionId: otherPosition });
      if (synced) await syncSequence(synced);
      if (origin === 'status') await regularize(person);
      const position = ['hr-record', 'propagated'].includes(origin)
        ? otherPosition
        : (synced?.positionId ?? originalPosition);
      expect(await payload(created.id)).toMatchObject({ status: 'in_review', fields: { positionId: position } });
      if (['propagated', 'status'].includes(origin)) {
        // 传播改动了审批表单可见的在途载荷，旧实例冻结：节点编辑 409 且不写入；发起人撤回后重提，节点再编辑。
        // 序列不在节点表单字段内，同步后节点可直接编辑（来源=sequence）。
        const frozen = await payload(created.id);
        const conflict = await nodeEdit(person, created.id, { remarks: '合成冻结备注' });
        expect(conflict.status).toBe(409);
        expect(await payload(created.id)).toEqual(frozen);
        await sendBack(person, created.id, 'withdraw');
        await command(person, created.id, 'submit');
      }
      await w.json(await nodeEdit(person, created.id, { remarks: `合成节点备注-${origin}` }));
      expect(await payload(created.id)).toMatchObject({
        fields: { positionId: position, remarks: `合成节点备注-${origin}` },
      });
      if (origin === 'position-deferred')
        expect((await latestVersion(created.id)).deferred).toContain('preset:positionId');
      await approve(person, created.id);
      // 职位单独延迟：节点编辑后、落地前前驱变为 A/P2，落地按当时前驱继承。
      if (origin === 'position-deferred') await adjust(person, '2026-10-18');
      await activate(date);
      expect(await payload(created.id)).toMatchObject({
        status: 'effective',
        record: {
          fields: { departmentId: source, positionId: origin === 'position-deferred' ? otherPosition : position },
        },
      });
    },
  );
});

describe('AC-TRF-63 落地后 HR 补职位：页面、导入、批量编辑同一引用校验', () => {
  it.each(['page', 'import', 'batch'] as const)('AC-TRF-63 本人跨部门调动落地后 HR 经 %s 补职位', async (entry) => {
    const person = await actor(`合成落地补职位-${entry}`);
    const created = await selfCreate(person, { departmentId: target }, true);
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
        record: { fields: { departmentId: target, positionId: null } },
      });
      const fill = async (positionId: string) => {
        const record = await payload(created.id);
        if (entry === 'page')
          return w.request(w.hr.id, 'PATCH', `${BASE}/records/${created.id}`, {
            ifMatch: record.revision,
            body: { fields: { positionId } },
          });
        if (entry === 'import') return importEdit(person, record, { positionId });
        return w.request(w.hr.id, 'POST', `${BASE}/records/batch-edit`, {
          body: { items: [{ id: created.id, revision: record.revision }], patch: { fields: { positionId } } },
        });
      };
      const before = await payload(created.id);
      const beforePerson = await profile(person);
      expect((await fill(originalPosition.toUpperCase())).status).toBe(400);
      expect(await payload(created.id)).toEqual(before);
      expect(await profile(person)).toEqual(beforePerson);
      await w.json(await fill(targetPosition.toUpperCase()));
      expect(await payload(created.id)).toMatchObject({
        record: { fields: { departmentId: target, positionId: targetPosition } },
      });
    } finally {
      w.setNow('2026-10-01T01:00:00Z');
    }
  });
});
