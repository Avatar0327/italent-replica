/**
 * AC-EN-04（16a-2c）：新增入职取消后的采集撤回（设计 §4.1 第 7 条、§5 撤回授权）。
 * 撤回只有受信内部端口，生产公开执行路由保持未注册；候选人身份复核用合成桩。
 */
import { attachmentFiles, eq, sql, withTenant } from '@italent/db';
import { expect, it } from 'vitest';
import { AppError } from '../../apps/api/src/errors.js';
import { appendEmployee } from '../../apps/api/src/modules/personnel/employee-write.js';
import { saveDraft } from '../../apps/api/src/modules/onboarding/collection-submit.js';
import { withdrawCollection } from '../../apps/api/src/modules/onboarding/collection-withdraw.js';
import { entryInfoCollectionAdapter } from '../../apps/api/src/modules/onboarding/approval-contract.js';
import { registerSubsetPolicy } from '../../apps/api/src/modules/personnel/subset-policy.js';
import { entryAction } from './AC-EN-BE2a-support.js';
import { identityAt, liveCount, stranger, submitted, useDb, world } from './AC-EN-BE16-08-support.js';
import { seedTenantWithMember } from './support/tenant-api.js';

it('AC-EN-04 新增入职取消后撤回：保留姓名与邮箱，清空资料、删除全部子集与本单位经历、解绑附件、撤下提交值', async () => {
  const x = await world();
  const { fileId } = await submitted(x);
  const landed = await x.person();
  expect(landed).toMatchObject({ mobilePhone: 'ZZ_BE16_SUBMITTED_PHONE', email: x.email });
  expect(await liveCount(x, 'personnel_education')).toBe(2);
  expect(await liveCount(x, 'personnel_job_history')).toBe(1);
  // 账号 / 重聘标记同属可编辑资料，撤回后也要清空（设计只保留姓名与个人邮箱）
  // 重聘关联用户须是本租户已绑定人员的用户：取夹具里已有的人员绑定
  const [link] = await x.query(
    sql`SELECT user_id FROM permission_user_person_links WHERE tenant_id=${x.ctx.tenantId} LIMIT 1`,
  );
  const flags = {
    allowToLoginIn: true,
    isRehire: false,
    rehireType: 'new_person',
    confirmRehireUserId: String(link!.user_id),
  };
  const current = await x.person();
  await x.tenant((tx) => appendEmployee(tx, x.expected(Number(current?.revision ?? 0)), x.employee.id, flags));
  expect(await x.person()).toMatchObject(flags);
  await x.cancel();
  const receipt = await x.withdraw();
  expect(receipt).toMatchObject({ status: 'withdrawn', notificationStatus: 'unavailable' });
  const after = await x.person();
  expect(after).toMatchObject({ name: landed!.name, email: x.email, mobilePhone: null });
  for (const code of Object.keys(flags)) expect(after![code], code).toBeNull();
  expect(Number(after!.revision)).toBe(Number(landed!.revision) + 2);
  expect(await liveCount(x, 'personnel_education')).toBe(0);
  expect(await liveCount(x, 'personnel_job_history')).toBe(0);
  const [file] = await x.tenant((tx) => tx.select().from(attachmentFiles).where(eq(attachmentFiles.id, fileId)));
  expect(file).toMatchObject({ status: 'pending_cleanup' });
  const { task, submissions } = await x.state();
  expect(task).toMatchObject({ status: 'withdrawn', withdrawRemark: 'ZZ_BE16_REMARK' });
  expect(submissions.length).toBeGreaterThan(0);
  // 提交版本不原地覆盖：原值仍在版本行里（受控历史），普通读由撤回状态控制（审批披露见 r2 验收）
  expect(JSON.stringify(submissions.map((row) => row.values))).toContain('ZZ_BE16_SCHOOL');
  expect(JSON.stringify(submissions.map((row) => row.values))).toContain('ZZ_BE16_COLLECTED');
  // DEC-019：版本链保留，撤回前的值仍在历史版本里（受控审计读取），不原地覆盖
  const versions = await x.query(sql`SELECT mobile_phone FROM personnel_employee_versions
    WHERE tenant_id=${x.ctx.tenantId} AND employee_id=${x.employee.id}::uuid ORDER BY revision`);
  expect(versions.map((row) => row.mobile_phone)).toContain('ZZ_BE16_SUBMITTED_PHONE');
  const audits = await x.query(sql`SELECT action FROM audit_events WHERE tenant_id=${x.ctx.tenantId}
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
    x.tenant((tx) =>
      withdrawCollection(
        tx,
        x.expected(task.revision),
        stale,
        { remark: 'ZZ_BE16_REMARK' },
        identityAt(stale.businessId, stale.businessRevision),
      ),
    ),
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
      withdrawCollection(
        tx,
        foreign,
        where,
        { remark: 'ZZ_BE16_REMARK' },
        identityAt(where.businessId, where.businessRevision),
      ),
    ),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect((await x.state()).task.status).not.toBe('withdrawn');
});
