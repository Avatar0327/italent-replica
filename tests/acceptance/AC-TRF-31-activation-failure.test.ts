/**
 * AC-TRF-31（DEC-052）：定时生效失败记 failed / 次数 / 原因并生成 HR 待办；修正后重试按原调动日期落地，
 * 联动（向后更新）照常执行、待办关闭，重复重试不重复生效。自动生效主路径不变（AC-TRF-06）。
 * 编制是否足够由编制模块判定：编制↔任职的人员桥属 R1-T09（Q-M0-15），此处经生效校验端口注入替身；
 * 目标组织 / 职位停用走真实引用校验。
 * TODO(需取证 Q-M0-48)：原站到期是否再校验、失败如何表现待 10-10 回查，结论只影响失败判定一处。
 */
import { randomUUID } from 'node:crypto';
import { registerEmploymentActivationChecks } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { errorCode, tenantApi } from './support/tenant-api.js';
import { activationWorld, type ActivationBusiness } from './AC-TRF-activation-support.js';

const testDb = useTestDb();

let fullDepartments = new Set<string>();
registerEmploymentActivationChecks({
  establishmentExceeded: async (_tx, _ctx, target) => fullDepartments.has(target.departmentId ?? ''),
});
afterEach(() => {
  fullDepartments = new Set();
});

describe('AC-TRF-31 DEC-052 定时生效失败、HR 待办与重试', () => {
  it('编制不足：仍为审批通过、failed 1 次、原因编制不足、HR 待办；修正后重试按原日期生效并向后更新', async () => {
    const w = await activationWorld(testDb().db, 'trf31-establishment');
    const { employee, hire } = await w.hired();
    const approved = await w.approve(
      await w.apply(employee.id, '2026-10-05', { departmentId: w.to.id, place: '新地点' }),
      '2026-10-02T02:00:00Z',
    );
    // 更晚的直接业务（10-20）在调动生效前已存在：生效时调动后的部门须向后更新到它。
    const later = await w.session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-20', fields: { remarks: '后续直接调动' } },
      (await w.session.getEmployee(employee.id)).revision,
    );
    expect(later.record!.fields.departmentId).toBe(w.from.id);

    fullDepartments.add(w.to.id);
    const run = await w.runScheduler('2026-10-04T17:15:00Z');
    expect(run).toMatchObject({ businessDate: '2026-10-05', activated: [], failed: [approved.id] });
    const failed = await w.business(approved.id);
    expect(failed).toMatchObject({
      status: 'approved',
      record: null,
      activation: { status: 'failed', failureCount: 1, failureReason: 'ESTABLISHMENT_EXCEEDED' },
    });
    expect(await w.session.records(employee.id, '2026-10-05')).toHaveLength(2);
    expect(await w.todos()).toEqual([
      expect.objectContaining({
        businessId: approved.id,
        employeeId: employee.id,
        failureCount: 1,
        failureReason: 'ESTABLISHMENT_EXCEEDED',
        effectiveDate: '2026-10-05',
      }),
    ]);
    // 失败与业务同事务留痕：审计 + outbox（通知消费者据此推送“生效失败”待办）。
    const failureAudit = (await w.auditEvents(approved.id)).find(
      (event) => event.action === 'employment.activation.failed',
    );
    expect(failureAudit).toMatchObject({ actorUserId: null, after: { reason: 'ESTABLISHMENT_EXCEEDED', attempt: 1 } });
    expect((await w.outboxEvents(approved.id)).map((event) => event.eventType)).toContain(
      'employment.activation.failed',
    );

    // 同日再次运行（多实例、补跑）：不自动重试，失败次数不增加；失败时联动一律不执行。
    expect(await w.runScheduler('2026-10-04T17:30:00Z')).toMatchObject({ activated: [], failed: [] });
    expect((await w.business(approved.id)).activation).toMatchObject({ failureCount: 1 });
    expect((await w.session.record(later.id, '2026-10-20')).fields.departmentId).toBe(w.from.id);

    // 未修正就重试：再次失败，次数 + 1。
    const again = await w.retry(approved, '2026-10-05T02:00:00Z');
    expect(again.status).toBe(200);
    expect(((await again.json()) as ActivationBusiness).activation).toMatchObject({
      status: 'failed',
      failureCount: 2,
    });

    // HR 调整编制后重试：按原调动日期 10-05 生效，前一条止于 10-04，后续记录部门被向后更新，待办关闭。
    fullDepartments.delete(w.to.id);
    const key = randomUUID();
    const beforeRetry = await w.business(approved.id);
    const retried = await w.retry(approved, '2026-10-06T02:00:00Z', key);
    expect(retried.status).toBe(200);
    const effective = (await retried.json()) as ActivationBusiness;
    expect(effective).toMatchObject({
      status: 'effective',
      record: { effectiveDate: '2026-10-05', previousRecordId: hire.record!.id, fields: { departmentId: w.to.id } },
      activation: { status: 'effective', failureCount: 2, failureReason: null },
    });
    expect((await w.session.record(hire.record!.id, '2026-10-06')).stopDate).toBe('2026-10-04');
    expect((await w.session.record(later.id, '2026-10-20')).fields.departmentId).toBe(w.to.id);
    expect(await w.todos()).toEqual([]);
    expect(
      (await w.auditEvents(approved.id)).find((event) => event.action === 'employment.record.create'),
    ).toMatchObject({ actorUserId: w.session.user.id });

    // 重复点击重试：同一命令 ID 重放首次结果；新命令按状态拒绝，均不重复生效。
    const replay = await w.session.request('POST', `/businesses/${approved.id}/activation/retry`, {
      ifMatch: beforeRetry.revision,
      body: {},
      idempotencyKey: key,
    });
    expect(replay.status).toBe(200);
    const duplicate = await w.retry(approved, '2026-10-06T03:00:00Z');
    expect(duplicate.status).toBe(409);
    expect(await w.session.records(employee.id, '2026-10-20')).toHaveLength(3);
  });

  it('目标组织在生效日已停用：failed 原因为目标组织停用；重新启用后重试生效', async () => {
    const w = await activationWorld(testDb().db, 'trf31-org-disabled');
    const { employee } = await w.hired();
    const approved = await w.approve(
      await w.apply(employee.id, '2026-10-05', { departmentId: w.to.id }),
      '2026-10-02T02:00:00Z',
    );
    const raw = tenantApi(w.db);
    const orgRequest = (revision: number, body: Record<string, unknown>) =>
      raw.request('PATCH', `/api/tenant/org/organizations/${w.to.id}`, {
        user: w.session.user.id,
        tenant: w.session.tenant.id,
        ifMatch: revision,
        body,
      });
    const disabled = await orgRequest(w.to.revision, { enabled: false, effectiveDate: '2026-10-05' });
    expect(disabled.status).toBe(200);

    const run = await w.runScheduler('2026-10-04T17:15:00Z');
    expect(run.failed).toEqual([approved.id]);
    expect((await w.business(approved.id)).activation).toMatchObject({
      status: 'failed',
      failureReason: 'TARGET_ORG_DISABLED',
    });

    const enabled = await orgRequest(((await disabled.json()) as { revision: number }).revision, {
      enabled: true,
      effectiveDate: '2026-10-05',
    });
    expect(enabled.status).toBe(200);
    const retried = await w.retry(approved, '2026-10-05T03:00:00Z');
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ status: 'effective', record: { fields: { departmentId: w.to.id } } });
  });

  it('重试只适用于生效失败或被挂起的申请：待生效、未到期的申请拒绝重试', async () => {
    const w = await activationWorld(testDb().db, 'trf31-retry-guard');
    const { employee } = await w.hired();
    const approved = await w.approve(
      await w.apply(employee.id, '2026-10-05', { departmentId: w.to.id }),
      '2026-10-02T02:00:00Z',
    );
    const early = await w.retry(approved, '2026-10-03T02:00:00Z');
    expect(early.status).toBe(409);
    expect(await errorCode(early)).toBe('CONFLICT');
    expect((await w.business(approved.id)).status).toBe('approved');
  });
});
