/**
 * AC-EN-04（16a-2c）：新增入职取消后的采集撤回（设计 §4.1 第 7 条、§5 撤回授权）。
 * 撤回只有受信内部端口，生产公开执行路由保持未注册；候选人身份复核用合成桩。
 */
import {
  attachmentFiles,
  eq,
  onboardingCollectionSubmissions,
  onboardingCollectionTasks,
  onboardingEntryCases,
  sql,
  upsertSystemSetting,
  withTenant,
} from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { Authorizer } from '../../apps/api/src/authorization.js';
import { AppError } from '../../apps/api/src/errors.js';
import { SUBSET_PURPOSE } from '../../apps/api/src/modules/attachments/subset-read.js';
import { saveDraft, submit } from '../../apps/api/src/modules/onboarding/collection-submit.js';
import { startCollection } from '../../apps/api/src/modules/onboarding/collection-tasks.js';
import {
  withdrawCollection,
  type CandidateIdentityPort,
} from '../../apps/api/src/modules/onboarding/collection-withdraw.js';
import { entryInfoCollectionAdapter } from '../../apps/api/src/modules/onboarding/approval-contract.js';
import { appendEmployee, employeeSnapshot } from '../../apps/api/src/modules/personnel/employee-write.js';
import { syncEmploymentHistory } from '../../apps/api/src/modules/personnel/employment-sync.js';
import { registerSubsetPolicy } from '../../apps/api/src/modules/personnel/subset-policy.js';
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
import { uniqueSuffix } from './support/unique.js';
import { seedTenantWithMember, tenantApi } from './support/tenant-api.js';

const useDb = useTestDb();
const profile = 'TenantBase.EmployeeInformation';
const education = 'TenantBase.Education';
const verified: CandidateIdentityPort = { verify: async () => true };
const stranger: CandidateIdentityPort = { verify: async () => false };
let syncSwitchOn = false;

async function world(kind: 'hire' | 'rehire' = 'hire') {
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
      { ...hireBody(w.org.id, '2026-10-08', { pendingEntry: true }), kind: 'rehire', formId: 'campus-hire' },
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
    requiresApproval: false,
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
  const state = () =>
    tenant(async (tx) => {
      const [task] = await tx.select().from(onboardingCollectionTasks).where(eq(onboardingCollectionTasks.id, taskId));
      const submissions = await tx
        .select()
        .from(onboardingCollectionSubmissions)
        .orderBy(onboardingCollectionSubmissions.version);
      return { task: task! as Record<string, unknown> & typeof task, submissions };
    });
  const query = (text: ReturnType<typeof sql>) => tenant(async (tx) => rows(await tx.execute(text)));
  /** 取消后的目标版本：业务头、阶段 revision 都已变化。 */
  const target = async () => {
    const [latest] = await tenant((tx) =>
      tx.select().from(onboardingEntryCases).where(eq(onboardingEntryCases.id, stage.id)),
    );
    return { ...ref, taskId, businessRevision: await businessRevision(w, recordId), caseRevision: latest!.revision };
  };
  const cancel = async () => {
    const response = await entryAction(w, recordId, 'cancel', {});
    expect(response.status, await response.clone().text()).toBe(200);
  };
  const withdraw = async (identity = verified, remark = 'ZZ_BE16_REMARK') => {
    const { task } = await state();
    const where = await target();
    return tenant((tx) => withdrawCollection(tx, expected(task.revision), where, { remark }, identity));
  };
  return {
    w,
    ctx,
    employee,
    recordId,
    taskId,
    tenant,
    expected,
    person,
    state,
    query,
    target,
    cancel,
    withdraw,
    ref,
    email,
  };
}
type World = Awaited<ReturnType<typeof world>>;

/** 候选人提交后落地一个采集学历，再由 HR 加一条带附件的学历，并为待入职记录生成本单位经历投影。 */
async function submitted(x: World) {
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

const liveCount = (x: World, table: string) =>
  x
    .query(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE NOT deleted`)
    .then(([row]) => Number(row!.n));

it('AC-EN-04 新增入职取消后撤回：保留姓名与邮箱，清空资料、删除全部子集与本单位经历、解绑附件、撤下提交值', async () => {
  const x = await world();
  const { fileId } = await submitted(x);
  const landed = await x.person();
  expect(landed).toMatchObject({ mobilePhone: 'ZZ_BE16_SUBMITTED_PHONE', email: x.email });
  expect(await liveCount(x, 'personnel_education')).toBe(2);
  expect(await liveCount(x, 'personnel_job_history')).toBe(1);
  await x.cancel();
  const receipt = await x.withdraw();
  expect(receipt).toMatchObject({ status: 'withdrawn', notificationStatus: 'unavailable' });
  const after = await x.person();
  expect(after).toMatchObject({ name: landed!.name, email: x.email, mobilePhone: null });
  expect(Number(after!.revision)).toBe(Number(landed!.revision) + 1);
  expect(await liveCount(x, 'personnel_education')).toBe(0);
  expect(await liveCount(x, 'personnel_job_history')).toBe(0);
  const [file] = await x.tenant((tx) => tx.select().from(attachmentFiles).where(eq(attachmentFiles.id, fileId)));
  expect(file).toMatchObject({ status: 'pending_cleanup' });
  const { task, submissions } = await x.state();
  expect(task).toMatchObject({ status: 'withdrawn', withdrawRemark: 'ZZ_BE16_REMARK' });
  expect(submissions.length).toBeGreaterThan(0);
  expect(JSON.stringify(submissions.map((row) => row.values))).not.toContain('ZZ_BE16_SCHOOL');
  expect(JSON.stringify(submissions.map((row) => row.values))).not.toContain('ZZ_BE16_COLLECTED');
  // DEC-019：版本链保留，撤回前的值仍在历史版本里（受控审计读取），不原地覆盖
  const versions = await x.query(sql`SELECT mobile_phone FROM personnel_employee_versions
    WHERE tenant_id=${x.ctx.tenantId} AND employee_id=${x.employee.id}::uuid ORDER BY revision`);
  expect(versions.map((row) => row.mobile_phone)).toContain('ZZ_BE16_SUBMITTED_PHONE');
  const audits = await x.query(sql`SELECT action FROM audit_logs WHERE tenant_id=${x.ctx.tenantId}
    AND action LIKE 'onboarding.collection_task.withdraw%'`);
  expect(audits).toHaveLength(1);
});

it('AC-EN-04 撤回后旧会话与迟到审批停止可用，且授权单次消费', async () => {
  const x = await world();
  await submitted(x);
  await x.cancel();
  await x.withdraw();
  const before = await x.person();
  const target = { ...x.ref, taskId: x.taskId };
  const { task } = await x.state();
  const draft = { profileRevision: Number(before!.revision), profile: {}, subsets: [] };
  await expect(x.tenant((tx) => saveDraft(tx, x.expected(task.revision), target, draft))).rejects.toBeInstanceOf(
    AppError,
  );
  await expect(
    x.tenant((tx) =>
      entryInfoCollectionAdapter.approved(tx, { ...x.ctx, handlingAuthorize: x.ctx.authorize }, x.taskId),
    ),
  ).rejects.toBeInstanceOf(AppError);
  await expect(x.withdraw()).rejects.toMatchObject({
    code: 'CONFLICT',
    details: { reason: 'COLLECTION_ALREADY_WITHDRAWN' },
  });
  expect(await x.person()).toEqual(before);
});

it('AC-EN-04 重聘入职不能撤回，也不改动任何数据', async () => {
  const x = await world('rehire');
  const profileRevision = Number((await x.person())!.revision);
  await x.tenant((tx) =>
    saveDraft(
      tx,
      x.expected(1),
      { ...x.ref, taskId: x.taskId },
      { profileRevision, profile: { name: 'ZZ_BE16_REHIRE' }, subsets: [] },
    ),
  );
  await x.cancel();
  const before = await x.person();
  await expect(x.withdraw()).rejects.toMatchObject({
    code: 'CONFLICT',
    details: { reason: 'COLLECTION_WITHDRAW_REHIRE' },
  });
  expect(await x.person()).toEqual(before);
  expect((await x.state()).task.status).not.toBe('withdrawn');
});

it('AC-EN-04 未取消、无采集记录、候选人身份未通过都不能撤回', async () => {
  const x = await world();
  await submitted(x);
  const before = await x.person();
  await expect(x.withdraw()).rejects.toMatchObject({ details: { reason: 'ENTRY_NOT_CANCELLED' } });
  await x.cancel();
  await expect(x.withdraw(stranger)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(await x.person()).toEqual(before);
  expect((await x.state()).task.status).not.toBe('withdrawn');
  const empty = await world();
  await empty.cancel();
  await expect(empty.withdraw()).rejects.toMatchObject({ details: { reason: 'COLLECTION_NOTHING_TO_WITHDRAW' } });
});

it('AC-EN-04 恢复待入职后旧撤回授权失效', async () => {
  const x = await world();
  await submitted(x);
  await x.cancel();
  const stale = await x.target();
  const restored = await entryAction(x.w, x.recordId, 'postpone', { effectiveDate: '2026-10-20' });
  expect(restored.status, await restored.clone().text()).toBe(200);
  const before = await x.person();
  const { task } = await x.state();
  await expect(
    x.tenant((tx) => withdrawCollection(tx, x.expected(task.revision), stale, { remark: 'ZZ_BE16_REMARK' }, verified)),
  ).rejects.toSatisfy(
    (error) =>
      error instanceof AppError &&
      (error.details as { reason?: string } | undefined)?.reason !== 'COLLECTION_WITHDRAW_UNAVAILABLE',
  );
  expect(await x.person()).toEqual(before);
  expect((await x.state()).task.status).not.toBe('withdrawn');
});

it('AC-EN-04 任一步失败整体回滚：人员策略拒绝删除子集时，资料、子集、附件、任务都不变', async () => {
  const x = await world();
  const { fileId } = await submitted(x);
  await x.cancel();
  const before = await x.person();
  const unregister = registerSubsetPolicy('education', {
    beforeSave: async (_tx, _ctx, input) => {
      if (input.deleted) throw new AppError('CONFLICT', 'ZZ_BE16_POLICY_BLOCK');
    },
  });
  try {
    await expect(x.withdraw()).rejects.toMatchObject({ message: 'ZZ_BE16_POLICY_BLOCK' });
  } finally {
    unregister();
  }
  expect(await x.person()).toEqual(before);
  expect(await liveCount(x, 'personnel_education')).toBe(2);
  expect(await liveCount(x, 'personnel_job_history')).toBe(1);
  const [file] = await x.tenant((tx) => tx.select().from(attachmentFiles).where(eq(attachmentFiles.id, fileId)));
  expect(file).toMatchObject({ status: 'bound' });
  expect((await x.state()).task.status).not.toBe('withdrawn');
});

it('AC-EN-04 租户隔离：其他租户拿不到、也撤不了本租户的采集任务', async () => {
  const x = await world();
  await submitted(x);
  await x.cancel();
  const other = await seedTenantWithMember(useDb().db, 'ZZ_BE16_OTHER');
  const { task } = await x.state();
  const where = await x.target();
  const foreign = { ...x.expected(task.revision), tenantId: other.tenant.id, userId: other.user.id };
  await expect(
    withTenant(useDb().db, other.tenant.id, (tx) =>
      withdrawCollection(tx, foreign, where, { remark: 'ZZ_BE16_REMARK' }, verified),
    ),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect((await x.state()).task.status).not.toBe('withdrawn');
});
