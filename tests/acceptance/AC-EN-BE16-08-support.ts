/**
 * AC-EN-04（16a-2c）撤回验收夹具：合成待入职、采集模板与规则、候选人身份桩（撤回授权，设计 §5）。
 * 候选人身份端口无生产实现，这里的桩按“签发时的取消版本”出授权；全部数据 ZZ_BE16_* 合成，邮箱 example.com。
 */
import {
  approvalInstances,
  approvalTasks,
  attachmentFiles,
  createUser,
  eq,
  grantMembership,
  onboardingCollectionSubmissions,
  onboardingCollectionTasks,
  onboardingEntryCases,
  sql,
  upsertSystemSetting,
  withTenant,
} from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { Authorizer } from '../../apps/api/src/authorization.js';
import { SUBSET_PURPOSE } from '../../apps/api/src/modules/attachments/subset-read.js';
import { submit } from '../../apps/api/src/modules/onboarding/collection-submit.js';
import { startCollection } from '../../apps/api/src/modules/onboarding/collection-tasks.js';
import {
  withdrawCollection,
  type CandidateIdentityPort,
  type CollectionWithdrawGrant,
} from '../../apps/api/src/modules/onboarding/collection-withdraw.js';
import { appendEmployee, employeeSnapshot } from '../../apps/api/src/modules/personnel/employee-write.js';
import { syncEmploymentHistory } from '../../apps/api/src/modules/personnel/employment-sync.js';
import { rows } from '../../apps/api/src/modules/personnel/store.js';
import { saveSubset } from '../../apps/api/src/modules/personnel/subsets.js';
import {
  addHire,
  addPending,
  businessRevision,
  entryAction,
  entryWorld,
  hireBody,
  portContext,
} from './AC-EN-BE2a-support.js';
import { loginEmailOf } from './AC-EMP-support.js';
import { uniqueSuffix } from './support/unique.js';
import { cmd, tenantApi } from './support/tenant-api.js';

export const useDb = useTestDb();
export const profile = 'TenantBase.EmployeeInformation';
export const education = 'TenantBase.Education';
/** 候选人身份桩：复核通过，并按签发时的取消版本出撤回授权（设计 §5）。 */
export const identityAt = (
  cancelledBusinessId: string,
  cancelledBusinessRevision: number,
  override: Partial<CollectionWithdrawGrant> = {},
): CandidateIdentityPort => ({
  verify: async (_tx, subject) => ({
    purpose: 'collection_withdraw',
    employeeId: subject.employeeId,
    taskId: subject.taskId,
    cancelledBusinessId,
    cancelledBusinessRevision,
    ...override,
  }),
});
export const stranger: CandidateIdentityPort = { verify: async () => null };
let syncSwitchOn = false;

/** hire：新人；rehire：离职后以 rehire 回来；hireAgain：离职后仍以 kind=hire 开新周期（任职入口允许）。 */
export async function world(kind: 'hire' | 'rehire' | 'hireAgain' = 'hire', requiresApproval = false) {
  const { db } = useDb();
  const w = await entryWorld(db, 'ZZ_BE16_WITHDRAW');
  const email = `zz_be16_${uniqueSuffix()}@example.com`;
  let employee: { id: string; revision: number };
  let recordId: string;
  if (kind === 'hire') {
    const pending = await addPending(w, '2026-10-08', 'ZZ_BE16_CANDIDATE');
    employee = pending.employee;
    recordId = pending.recordId;
  } else {
    const former = await w.session.employee('ZZ_BE16_FORMER');
    const hired = await w.session.business(former.id, hireBody(w.org.id, '2026-01-05'), former.revision);
    const left = await w.session.business(
      former.id,
      { kind: 'leave', mode: 'direct', lastWorkDate: '2026-03-31', fields: {} },
      hired.employeeRevision,
    );
    const response = await addHire(
      w.session,
      { id: former.id, revision: left.employeeRevision },
      {
        ...hireBody(w.org.id, '2026-10-08', { pendingEntry: true }),
        ...(kind === 'rehire' ? { kind: 'rehire', formId: 'campus-hire' } : {}),
      },
    );
    expect(response.status, await response.clone().text()).toBe(201);
    employee = former;
    recordId = ((await response.json()) as { record: { id: string } }).record.id;
  }
  const authorize: Authorizer = () => true;
  const ctx = { ...portContext(w, 0), authorize };
  const tenant = <T>(run: Parameters<typeof withTenant<T>>[2]) => withTenant(db, ctx.tenantId, run);
  const expected = (revision: number) => ({ ...ctx, expectedRevision: revision, commandId: uniqueSuffix() });
  const api = tenantApi(db, { authorize, clock: () => ctx.now });
  const request = (method: string, path: string, options?: { user?: string; ifMatch?: number; body?: object }) =>
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
      { objectCode: profile, fieldCode: 'mobilePhone' },
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
  const person = () => tenant((tx) => employeeSnapshot(tx, ctx, employee.id));
  const current = await person();
  await tenant((tx) =>
    appendEmployee(tx, expected(Number(current?.revision ?? 0)), employee.id, {
      email,
      mobilePhone: 'ZZ_BE16_PHONE_OLD',
    }),
  );
  const stage = await tenant(async (tx) => {
    const [row] = await tx
      .select()
      .from(onboardingEntryCases)
      .where(eq(onboardingEntryCases.currentBusinessId, recordId));
    return row!;
  });
  const ref = {
    employeeId: employee.id,
    caseId: stage.id,
    businessId: recordId,
    businessRevision: await businessRevision(w, recordId),
    caseRevision: stage.revision,
  };
  const started = await tenant((tx) => startCollection(tx, ctx, ref, 'manual'));
  if (started.status !== 'created') throw new Error('ZZ_BE16_TASK_NOT_CREATED');
  const taskId = started.task.id;
  /** 改期恢复会产生新的业务头（待入职记录换 id），之后所有动作都跟着当前这一条。 */
  let currentId = recordId;
  const restore = async (effectiveDate = '2026-10-20') => {
    const response = await entryAction(w, currentId, 'postpone', { effectiveDate });
    expect(response.status, await response.clone().text()).toBe(200);
    currentId = ((await response.json()) as { id: string }).id;
  };
  const state = () =>
    tenant(async (tx) => {
      const [task] = await tx.select().from(onboardingCollectionTasks).where(eq(onboardingCollectionTasks.id, taskId));
      const submissions = await tx
        .select()
        .from(onboardingCollectionSubmissions)
        .orderBy(onboardingCollectionSubmissions.version);
      const instances = await tx.select().from(approvalInstances).where(eq(approvalInstances.businessId, taskId));
      const approvalWork = await tx.select().from(approvalTasks);
      return { task: task! as Record<string, unknown> & typeof task, submissions, instances, approvalWork };
    });
  const query = (text: ReturnType<typeof sql>) => tenant(async (tx) => rows(await tx.execute(text)));
  /** 取消后的目标版本：业务头、阶段 revision 都已变化。 */
  const target = async () => {
    const [latest] = await tenant((tx) =>
      tx.select().from(onboardingEntryCases).where(eq(onboardingEntryCases.id, stage.id)),
    );
    return {
      ...ref,
      businessId: currentId,
      taskId,
      businessRevision: await businessRevision(w, currentId),
      caseRevision: latest!.revision,
    };
  };
  /** 候选人侧在取消后拿到授权：绑定当时的业务头 revision；之后恢复、再取消会让它失效。 */
  const issue = async () => identityAt(currentId, await businessRevision(w, currentId));
  let issued: CandidateIdentityPort | undefined;
  const cancel = async () => {
    const response = await entryAction(w, currentId, 'cancel', {});
    expect(response.status, await response.clone().text()).toBe(200);
    issued = await issue();
  };
  const withdraw = async (identity?: CandidateIdentityPort, remark = 'ZZ_BE16_REMARK') => {
    const { task } = await state();
    const where = await target();
    const port = identity ?? issued ?? (await issue());
    return tenant((tx) => withdrawCollection(tx, expected(task.revision), where, { remark }, port));
  };
  return {
    w,
    ctx,
    employee,
    get recordId() {
      return currentId;
    },
    restore,
    taskId,
    tenant,
    expected,
    person,
    state,
    query,
    target,
    cancel,
    issue,
    request,
    withdraw,
    ref,
    email,
  };
}
export type World = Awaited<ReturnType<typeof world>>;

/** 候选人提交后落地一个采集学历，再由 HR 加一条带附件的学历，并为待入职记录生成本单位经历投影。 */
export async function submitted(x: World) {
  const before = await x.person();
  await x.tenant((tx) =>
    submit(
      tx,
      x.expected(1),
      { ...x.ref, taskId: x.taskId },
      {
        profileRevision: Number(before?.revision ?? 0),
        profile: { name: 'ZZ_BE16_COLLECTED', mobilePhone: 'ZZ_BE16_SUBMITTED_PHONE' },
        subsets: [{ kind: 'education', revision: 0, values: { school: 'ZZ_BE16_SCHOOL' } }],
      },
    ),
  );
  const fileId = randomUUID();
  await x.tenant(async (tx) => {
    await tx.insert(attachmentFiles).values({
      id: fileId,
      tenantId: x.ctx.tenantId,
      purpose: SUBSET_PURPOSE,
      ownerUserId: x.ctx.userId,
      ownerEmployeeId: x.employee.id,
      status: 'uploaded',
      filename: 'ZZ_BE16_CERT.png',
      declaredType: 'image/png',
      byteSize: 8,
      sha256: 'a'.repeat(64),
    });
    await saveSubset(tx, x.expected(0), x.employee.id, 'education', {
      school: 'ZZ_BE16_HR_SCHOOL',
      educationCertificate: fileId,
    });
  });
  // 系统设置按库全局，只在本文件的库里开一次
  if (!syncSwitchOn) {
    await upsertSystemSetting(
      useDb().db,
      { key: 'EntrySyncJobHistory', value: true, description: 'ZZ_BE16', overridable: true, expectedVersion: 0 },
      { actorUserId: null, commandId: randomUUID() },
    );
    syncSwitchOn = true;
  }
  await x.tenant((tx) => syncEmploymentHistory(tx, x.ctx, x.employee.id, x.recordId, 'hire', '2026-10-08'));
  return { fileId };
}

export const liveCount = (x: World, table: string) =>
  x
    .query(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE NOT deleted`)
    .then(([row]) => Number(row!.n));

const approval = '/api/tenant/approval';
const json = async (res: Response, status = 200) => {
  expect(res.status, await res.clone().text()).toBe(status);
  return res.json();
};

/** 16a-2b 同款真实审批：发布采集审批流程并建一个审批人（驳回、办理、读详情）。 */
export async function publishApproval(x: World) {
  const employee = await x.w.session.employee('ZZ_BE16_REVIEWER');
  const reviewer = await createUser(
    x.w.db,
    { email: loginEmailOf(employee.id), displayName: 'ZZ_BE16_REVIEWER' },
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
