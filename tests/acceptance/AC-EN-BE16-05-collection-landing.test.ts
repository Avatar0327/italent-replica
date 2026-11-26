import {
  approvalInstances,
  approvalTasks,
  createUser,
  eq,
  grantMembership,
  onboardingCollectionSubmissions,
  onboardingCollectionTasks,
  onboardingEntryCases,
  sql,
  withTenant,
} from '@italent/db';
import { uniqueSuffix } from './support/unique.js';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { entryInfoCollectionAdapter } from '../../apps/api/src/modules/onboarding/approval-contract.js';
import type { Authorizer } from '../../apps/api/src/authorization.js';
import { AppError } from '../../apps/api/src/errors.js';
import {
  saveDraft,
  submit,
  readCollectionRehireTodo,
} from '../../apps/api/src/modules/onboarding/collection-submit.js';
import { employeeSnapshot, appendEmployee } from '../../apps/api/src/modules/personnel/employee-write.js';
import { loadSubset, saveSubset } from '../../apps/api/src/modules/personnel/subsets.js';
import { registerSubsetPolicy } from '../../apps/api/src/modules/personnel/subset-policy.js';
import { rows } from '../../apps/api/src/modules/personnel/store.js';
import { startCollection } from '../../apps/api/src/modules/onboarding/collection-tasks.js';
import { addPending, entryAction, entryWorld, portContext } from './AC-EN-BE2a-support.js';
import { loginEmailOf } from './AC-EMP-support.js';
import { cmd, seedTenantWithMember, tenantApi, type RequestOptions } from './support/tenant-api.js';

const useDb = useTestDb();
const profile = 'TenantBase.EmployeeInformation';
const education = 'TenantBase.Education';
const approval = '/api/tenant/approval';
const values = { school: 'ZZ_BE16_SCHOOL' };
const newEducation = { kind: 'education', revision: 0, values };

async function json(res: Response, status = 200) {
  expect(res.status, await res.clone().text()).toBe(status);
  return res.json();
}

async function collectionWorld(requiresApproval = false) {
  const { db } = useDb();
  const w = await entryWorld(db, 'ZZ_BE16_LANDING');
  const { employee, recordId, business } = await addPending(w, '2026-10-08', 'ZZ_BE16_CANDIDATE');
  const rights = { scope: true, rehire: true, educationWrite: true, educationView: true };
  const authorize: Authorizer = (request) => {
    if (request.action === 'data.scope.all') return rights.scope;
    if (request.action === 'object.button' && request.resource?.includes('CollectionConfirmRehire'))
      return rights.rehire;
    if (request.resource === education && request.action === 'object.create') return rights.educationWrite;
    if (request.resource === education && request.action === 'object.view') return rights.educationView;
    return true;
  };
  const ctx = { ...portContext(w, 0), authorize };
  const api = tenantApi(db, { authorize, clock: () => ctx.now });
  const request = (method: string, path: string, options?: RequestOptions) =>
    api.request(method, path, { tenant: ctx.tenantId, user: ctx.userId, ...options });
  const configure = async (path: string, body: object) => {
    const response = await api.request('POST', '/api/tenant/onboarding/' + path, {
      tenant: ctx.tenantId,
      user: ctx.userId,
      ifMatch: 0,
      body,
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return response.json();
  };
  const template = await configure('collection-templates', {
    name: 'ZZ_BE16_TEMPLATE',
    noticeTitle: 'ZZ_BE16_TITLE',
    noticeBody: 'ZZ_BE16_NOTICE',
    fields: [
      { objectCode: profile, fieldCode: 'name', required: true },
      { objectCode: profile, fieldCode: 'email', editable: false },
      { objectCode: profile, fieldCode: 'idType' },
      { objectCode: profile, fieldCode: 'idNumber' },
      { objectCode: education, fieldCode: 'school', required: true },
    ],
  });
  await configure('collection-rules', {
    name: 'ZZ_BE16_RULE',
    priority: 10,
    templateId: template.id,
    orgIds: [w.org.id],
    requiresApproval,
    requiredSubsets: ['education'],
  });
  const tenant = <T>(run: Parameters<typeof withTenant<T>>[2]) => withTenant(db, ctx.tenantId, run);
  const ref = await tenant(async (tx) => {
    const [stage] = await tx
      .select()
      .from(onboardingEntryCases)
      .where(eq(onboardingEntryCases.currentBusinessId, recordId));
    return {
      employeeId: employee.id,
      caseId: stage!.id,
      businessId: recordId,
      businessRevision: business.revision,
      caseRevision: stage!.revision,
    };
  });
  const started = await tenant((tx) => startCollection(tx, ctx, ref, 'manual'));
  if (started.status !== 'created') throw new Error('ZZ_BE16_TASK_NOT_CREATED');
  const task = started.task;
  const target = { ...ref, taskId: task.id };
  const person = () => tenant((tx) => employeeSnapshot(tx, ctx, employee.id));
  const expected = (revision: number) => ({ ...ctx, expectedRevision: revision, commandId: uniqueSuffix() });
  const input = {
    profileRevision: Number((await person())?.revision ?? 0),
    profile: { name: 'ZZ_BE16_COLLECTED' },
    subsets: [newEducation],
  };
  const state = () =>
    tenant(async (tx) => {
      const [task] = await tx
        .select()
        .from(onboardingCollectionTasks)
        .where(eq(onboardingCollectionTasks.id, target.taskId));
      const submissions = await tx
        .select()
        .from(onboardingCollectionSubmissions)
        .orderBy(onboardingCollectionSubmissions.version);
      const instances = await tx
        .select()
        .from(approvalInstances)
        .where(eq(approvalInstances.businessId, target.taskId));
      const approvalWork = await tx.select().from(approvalTasks);
      return { task, submissions, instances, approvalWork };
    });
  return { w, ctx, employee, tenant, ref, task, rights, request, target, person, expected, input, state };
}

it('AC-EN-BE16-05 已发起采集任务可进入审批前置锁，任意未知任务仍须拒绝', async () => {
  const { task, ctx, tenant } = await collectionWorld();
  await expect(tenant((tx) => entryInfoCollectionAdapter.lock(tx, ctx, task.id))).resolves.toBeUndefined();
  await expect(tenant((tx) => entryInfoCollectionAdapter.lock(tx, ctx, task.caseId))).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});

it('AC-EN-BE16-05 管理员新建或修改模板时拒绝无法填写的必填派生字段', async () => {
  const x = await collectionWorld();
  const templates = '/api/tenant/onboarding/collection-templates';
  const detail = `${templates}/${x.task.templateId}`;
  const before = await json(await x.request('GET', detail));
  const school = { objectCode: education, fieldCode: 'school', editable: true, required: true };
  for (const [objectCode, fieldCode] of [
    [education, 'isHighestEducation'],
    [education, 'isFirstEducation'],
    [education, 'isHighestDegree'],
    [education, 'isMainMajor'],
    ['TenantBase.Certificate', 'learningCertificateId'],
  ] as const) {
    const fields = [school, { objectCode, fieldCode, editable: true, required: true }];
    const created = await x.request('POST', templates, {
      ifMatch: 0,
      body: { name: 'ZZ_BE16_DERIVED', noticeTitle: 'ZZ_BE16_TITLE', noticeBody: 'ZZ_BE16_NOTICE', fields },
    });
    expect(await json(created, 400)).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    const updated = await x.request('PATCH', detail, { ifMatch: before.revision, body: { fields } });
    expect(await json(updated, 400)).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  }
  expect(await json(await x.request('GET', detail))).toEqual(before);
});

it('AC-EN-BE16-05 草稿允许缺子集，提交须齐全，完成后人员版本与子集来源一致', async () => {
  const x = await collectionWorld();
  const previous = await x.person();
  const without = { ...x.input, subsets: [] };
  const draft = await x.tenant((tx) => saveDraft(tx, x.expected(1), x.target, without));
  expect(draft).toMatchObject({ status: 'draft', revision: 2 });
  await expect(x.tenant((tx) => submit(tx, x.expected(2), x.target, without))).rejects.toMatchObject({
    code: 'VALIDATION_FAILED',
    details: { reason: 'COLLECTION_REQUIRED_SUBSET' },
  });
  expect(await x.person()).toEqual(previous);
  expect((await x.state()).submissions.map(({ kind }) => kind)).toEqual(['draft']);
  const completed = await x.tenant((tx) => submit(tx, x.expected(2), x.target, x.input));
  expect(completed).toMatchObject({ status: 'completed', revision: 3 });
  expect(await x.person()).toMatchObject({ name: 'ZZ_BE16_COLLECTED', revision: x.input.profileRevision + 1 });
  const educationRows = await x.tenant((tx) =>
    tx.execute(sql`SELECT school, source_type, source_id FROM personnel_education`),
  );
  expect(rows(educationRows)).toEqual([
    { school: values.school, source_type: 'info_collection', source_id: x.task.id },
  ]);
  expect((await x.state()).submissions.map(({ kind, version }) => ({ kind, version }))).toEqual([
    { kind: 'draft', version: 2 },
    { kind: 'submit', version: 3 },
  ]);
  await expect(x.tenant((tx) => submit(tx, x.expected(2), x.target, x.input))).rejects.toMatchObject({
    code: 'REVISION_CONFLICT',
  });
});

it('AC-EN-BE16-05 附件、只读字段、撤权和过期子集版本拒绝整单', async () => {
  const x = await collectionWorld();
  const before = await x.state();
  const previous = await x.person();
  const write = (input: unknown) => x.tenant((tx) => submit(tx, x.expected(1), x.target, input));
  await expect(
    write({
      ...x.input,
      subsets: [...x.input.subsets, { kind: 'certificate', revision: 0, values: { attachmentId: uniqueSuffix() } }],
    }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(
    write({ ...x.input, profile: { ...x.input.profile, email: 'ZZ_BE16_READ_ONLY@example.com' } }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN', details: { reason: 'COLLECTION_FIELD_NOT_ALLOWED' } });
  x.rights.educationWrite = false;
  await expect(write(x.input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  x.rights.educationWrite = true;
  x.rights.scope = false;
  await expect(write(x.input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  x.rights.scope = true;
  expect(await x.state()).toEqual(before);
  expect(await x.person()).toEqual(previous);
  const original = await x.tenant((tx) =>
    saveSubset(tx, x.expected(0), x.employee.id, 'education', { school: 'ZZ_BE16_ORIGINAL' }),
  );
  const id = String(original.id);
  const changed = await x.tenant((tx) =>
    saveSubset(tx, x.expected(1), x.employee.id, 'education', { school: 'ZZ_BE16_CHANGED' }, id),
  );
  const input = { ...x.input, subsets: [{ ...newEducation, id, revision: 1 }] };
  await expect(write(input)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(await x.person()).toEqual(previous);
  expect((await x.state()).submissions).toEqual([]);
  expect(
    (await write({ ...input, subsets: [{ ...input.subsets[0]!, revision: Number(changed.revision) }] })).status,
  ).toBe('completed');
  await expect(x.tenant((tx) => loadSubset(tx, x.ctx, x.employee.id, 'education', id))).resolves.toMatchObject({
    school: values.school,
    revision: 3,
    sourceType: 'info_collection',
    sourceId: x.task.id,
  });
});

type World = Awaited<ReturnType<typeof collectionWorld>>;

it('AC-EN-BE16-05 子集策略拒绝时回滚已写人员版本、采集版本及状态', async () => {
  const x = await collectionWorld();
  const before = await x.state();
  const person = await x.person();
  const revoke = registerSubsetPolicy('education', {
    async beforeSave(tx, ctx, input) {
      expect(input.source).toEqual({ type: 'info_collection', id: x.task.id });
      expect(await employeeSnapshot(tx, ctx, x.employee.id)).toMatchObject({ name: x.input.profile.name });
      throw new AppError('FORBIDDEN', 'ZZ_BE16_SUBSET_POLICY');
    },
  });
  try {
    await expect(x.tenant((tx) => submit(tx, x.expected(1), x.target, x.input))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'ZZ_BE16_SUBSET_POLICY',
    });
  } finally {
    revoke();
  }
  expect(await x.state()).toEqual(before);
  expect(await x.person()).toEqual(person);
});

async function publishApproval(x: World) {
  const employee = await x.w.session.employee('ZZ_BE16_REVIEWER');
  const reviewer = await createUser(
    x.w.db,
    {
      email: loginEmailOf(employee.id),
      displayName: 'ZZ_BE16_REVIEWER',
    },
    cmd(),
  );
  await grantMembership(x.w.db, { tenantId: x.ctx.tenantId, userId: reviewer.id, expectedRevision: 0 }, cmd());
  await x.w.session.business(
    employee.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-01-15',
      fields: { employType: 'internal', departmentId: x.w.org.id },
    },
    employee.revision,
  );
  const process = await json(
    await x.request('POST', approval + '/processes', {
      ifMatch: 0,
      body: {
        code: 'ZZ_BE16_FLOW',
        name: 'ZZ_BE16_FLOW',
        approvalType: 'entry_info_collection',
        exceptionAdminUserId: reviewer.id,
        conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'EntryInfoCollectionProcess' }] },
        nodes: [
          {
            key: 'review',
            name: 'ZZ_BE16_REVIEW',
            approver: { type: 'specified', value: reviewer.id },
            formFields: ['collectionValues'],
            actions: { avoidSelf: true },
          },
        ],
      },
    }),
    201,
  );
  await json(await x.request('POST', approval + `/processes/${process.id}/publish`, { ifMatch: process.revision }));
  const decide = (taskId: string, revision: number, action: 'approve' | 'reject') =>
    x.request('POST', approval + `/tasks/${taskId}/${action}`, { user: reviewer.id, ifMatch: revision, body: {} });
  const detail = (instanceId: string) => x.request('GET', approval + `/instances/${instanceId}`, { user: reviewer.id });
  return { reviewer, decide, detail };
}

it('AC-EN-BE16-05 真实审批缺流程回滚，驳回后同实例重提，字段撤权时审批不落地', async () => {
  const x = await collectionWorld(true);
  const draft = await x.tenant((tx) => saveDraft(tx, x.expected(1), x.target, x.input));
  const previous = await x.person();
  const send = (revision: number, name = x.input.profile.name) =>
    x.tenant((tx) => submit(tx, x.expected(revision), x.target, { ...x.input, profile: { name } }));
  await expect(send(draft.revision)).rejects.toMatchObject({
    code: 'CONFLICT',
    details: { reason: 'APPROVAL_PROCESS_NOT_MATCHED' },
  });
  expect((await x.state()).submissions).toHaveLength(1);
  const a = await publishApproval(x);
  expect(await send(draft.revision)).toMatchObject({ status: 'in_review' });
  const first = await x.state();
  expect(first.instances).toHaveLength(1);
  const [instance] = first.instances;
  const [work] = first.approvalWork;
  expect(first.task).toMatchObject({ approvalInstanceId: instance!.id, status: 'in_review' });
  expect(await x.person()).toEqual(previous);
  expect(await (await a.detail(instance!.id)).text()).toContain(values.school);
  const own = await json(await x.request('GET', approval + `/instances/${instance!.id}`));
  expect(own.actions).not.toContain('withdraw');
  const refused = await x.request('POST', approval + `/instances/${instance!.id}/withdraw`, {
    ifMatch: instance!.revision,
    body: {},
  });
  expect(refused.status).toBe(409);
  await json(await a.decide(work!.id, instance!.revision, 'reject'));
  const returned = await x.state();
  expect(returned.task).toMatchObject({ status: 'returned' });
  expect(await send(returned.task!.revision, 'ZZ_BE16_CORRECTED')).toMatchObject({ status: 'in_review' });
  const resubmitted = await x.state();
  expect(resubmitted.instances).toMatchObject([{ id: instance!.id, round: 2, status: 'running' }]);
  const open = resubmitted.approvalWork.find(({ round }) => round === 2)!;
  const revision = resubmitted.instances[0]!.revision;
  x.rights.scope = false;
  expect(await (await a.detail(instance!.id)).text()).not.toContain(values.school);
  x.rights.scope = true;
  x.rights.educationView = false;
  expect(await (await a.detail(instance!.id)).text()).not.toContain(values.school);
  expect((await a.decide(open.id, revision, 'approve')).status).toBe(403);
  x.rights.educationView = true;
  x.rights.educationWrite = false;
  expect((await a.decide(open.id, revision, 'approve')).status).toBe(403);
  expect(await x.person()).toEqual(previous);
  expect((await x.state()).task?.status).toBe('in_review');
  x.rights.educationWrite = true;
  await json(await a.decide(open.id, revision, 'approve'));
  expect((await x.state()).task).toMatchObject({ status: 'completed' });
  expect(await x.person()).toMatchObject({ name: 'ZZ_BE16_CORRECTED', revision: x.input.profileRevision + 1 });
  x.rights.educationView = false;
  expect(await (await a.detail(instance!.id)).text()).not.toContain(values.school);
});

it.each(['postpone', 'cancel'] as const)('AC-EN-BE16-05 %s 后旧审批关闭，迟到的办理与回调均不落地', async (action) => {
  const x = await collectionWorld(true);
  const a = await publishApproval(x);
  const previous = await x.person();
  await x.tenant((tx) => submit(tx, x.expected(1), x.target, x.input));
  const active = await x.state();
  const [instance] = active.instances;
  const [work] = active.approvalWork;
  const result = await entryAction(
    x.w,
    x.ref.businessId,
    action,
    action === 'postpone' ? { effectiveDate: '2026-10-16' } : {},
  );
  await json(result);
  expect((await x.state()).task).toMatchObject({ status: 'closed' });
  expect((await x.state()).instances).toMatchObject([{ id: instance!.id, status: 'cancelled' }]);
  expect((await a.decide(work!.id, instance!.revision, 'approve')).status).toBe(409);
  await expect(
    x.tenant((tx) =>
      entryInfoCollectionAdapter.approved(
        tx,
        {
          ...x.ctx,
          userId: a.reviewer.id,
          handlingAuthorize: x.ctx.authorize,
        },
        x.task.id,
      ),
    ),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(await x.person()).toEqual(previous);
  for (const path of [
    '/api/onboarding/collection/submit',
    `/api/tenant/onboarding/entries/${x.ref.businessId}/collection/confirm-rehire`,
  ]) {
    expect((await x.request('POST', path, { body: {} })).status).toBe(404);
  }
});

it('AC-EN-BE16-05 证件命中同租户离职人员只留授权待办，跨租户不可读且不合档', async () => {
  const x = await collectionWorld(true);
  const former = await x.w.session.employee('ZZ_BE16_FORMER');
  const idNumber = `ZZ_BE16_ID_${uniqueSuffix()}`;
  const hire = await x.w.session.business(
    former.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-01-15',
      fields: { employType: 'internal', departmentId: x.w.org.id },
    },
    former.revision,
  );
  await x.w.session.business(
    former.id,
    {
      kind: 'leave',
      mode: 'direct',
      lastWorkDate: '2026-09-20',
      fields: {},
    },
    hire.employeeRevision,
  );
  await x.tenant((tx) => appendEmployee(tx, x.expected(0), former.id, { idType: 'id_card', idNumber }, false));
  const previous = await x.person();
  await expect(
    x.tenant((tx) =>
      submit(tx, x.expected(1), x.target, {
        ...x.input,
        profile: { ...x.input.profile, idType: null, idNumber },
      }),
    ),
  ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'COLLECTION_ID_TYPE_REQUIRED' } });
  const result = await x.tenant((tx) =>
    submit(tx, x.expected(1), x.target, {
      ...x.input,
      profile: { ...x.input.profile, idType: 'id_card', idNumber },
    }),
  );
  expect(result).toMatchObject({ status: 'rehire_pending' });
  expect(JSON.stringify(result)).not.toContain(former.id);
  expect((await x.state()).instances).toEqual([]);
  expect(await x.person()).toEqual(previous);
  const read = () => x.tenant((tx) => readCollectionRehireTodo(tx, x.ctx, x.task.id));
  expect(await read()).toEqual({ id: x.task.id, revision: result.revision, status: 'rehire_pending' });
  x.rights.rehire = false;
  await expect(read()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  x.rights.rehire = true;
  const other = await seedTenantWithMember(x.w.db, 'ZZ_BE16_OTHER');
  await expect(
    withTenant(x.w.db, other.tenant.id, (tx) =>
      readCollectionRehireTodo(
        tx,
        {
          ...x.ctx,
          tenantId: other.tenant.id,
          userId: other.user.id,
        },
        x.task.id,
      ),
    ),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
});
