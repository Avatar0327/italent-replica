import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { transferFixture } from './AC-EST-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

describe('AC-EST DEC-052 定时生效再次校验编制并可重试', () => {
  it('未来调动审批通过不生效，到期编制不足持久failed，修复后才执行人员联动', async () => {
    const fixture = await transferFixture(testDb().db, 'est-scheduled', {
      targetCount: 9,
      strictControl: true,
    });
    const submitted = await fixture.apply('submitted');
    const approved = await fixture.apply('approved', submitted.revision);
    expect(approved.status).toBe('approved');
    expect(fixture.port.applyTransfer).not.toHaveBeenCalled();

    fixture.advanceTo(new Date('2026-10-02T01:00:00Z'));
    fixture.counts.set(fixture.target.id, 10);
    const failed = await fixture.apply('effective', approved.revision);
    expect(failed).toMatchObject({ status: 'failed', attempts: 1, failureReason: 'ESTABLISHMENT_EXCEEDED' });
    expect(fixture.port.applyTransfer).not.toHaveBeenCalled();

    const notifications = await fixture.request('GET', '/notifications');
    expect(notifications.status).toBe(200);
    expect(((await notifications.json()) as { items: unknown[] }).items).toContainEqual(
      expect.objectContaining({ businessId: fixture.businessId, reason: 'ESTABLISHMENT_EXCEEDED' }),
    );

    fixture.counts.set(fixture.target.id, 9);
    const effective = await fixture.apply('effective', failed.revision);
    expect(effective).toMatchObject({ status: 'effective', attempts: 2, failureReason: null });
    expect(fixture.port.applyTransfer).toHaveBeenCalledTimes(1);
    expect(await fixture.stats()).toMatchObject({ inclusive: { preIncrease: 0 } });
    expect(await fixture.stats(fixture.source.id)).toMatchObject({ inclusive: { preDecrease: 0 } });
  });

  it('未接入可信人员端口时返回503，不将未知实有人数视为0', async () => {
    const { db } = testDb();
    const fixture = await transferFixture(db, 'est-personnel-missing', { targetCount: 0 });
    const service = await import('../../apps/api/src/modules/establishment/transfer-service.js');
    await expect(
      withTenant(db, fixture.tenant.id, (tx) =>
        service.applyTransferStage(tx, fixture.context(), { businessId: fixture.businessId, stage: 'submitted' }),
      ),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(await fixture.stats()).toMatchObject({ inclusive: { preIncrease: 0 } });
  });

  it('批量入口可警告继续，但到期严格不足仍持久失败并禁止执行人员联动', async () => {
    const { db } = testDb();
    const fixture = await transferFixture(db, 'est-batch-due', { targetCount: 9, strictControl: true });
    const submitted = await fixture.apply('submitted');
    const approved = await fixture.apply('approved', submitted.revision);
    fixture.advanceTo(new Date('2026-10-02T01:00:00Z'));
    fixture.counts.set(fixture.target.id, 10);
    const service = await import('../../apps/api/src/modules/establishment/transfer-service.js');
    const result = await withTenant(db, fixture.tenant.id, (tx) =>
      service.applyBatchTransfers(
        tx,
        fixture.context(approved.revision),
        { businessIds: [fixture.businessId], stage: 'effective' },
        fixture.port,
      ),
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ status: 'failed', attempts: 1, failureReason: 'ESTABLISHMENT_EXCEEDED' });
    expect(fixture.port.applyTransfer).not.toHaveBeenCalled();
  });

  it.each(['withdrawn', 'rejected'] as const)('目标已停用，%s仍使用持久化业务事实释放双方预占', async (stage) => {
    const { db } = testDb();
    const fixture = await transferFixture(db, `est-inactive-${stage}`, { targetCount: 5 });
    const submitted = await fixture.apply('submitted');
    const disabled = await tenantApi(db).request('PATCH', `/api/tenant/org/organizations/${fixture.target.id}`, {
      user: fixture.user.id,
      tenant: fixture.tenant.id,
      ifMatch: fixture.target.revision,
      body: { effectiveDate: '2026-10-02', enabled: false },
    });
    expect(disabled.status).toBe(200);
    fixture.advanceTo(new Date('2026-10-02T01:00:00Z'));
    const released = await fixture.apply(stage, submitted.revision);
    expect(released).toMatchObject({ status: stage, reserveIn: false, reserveOut: false });
    expect(await fixture.stats()).toMatchObject({ inclusive: { preIncrease: 0 } });
    expect(await fixture.stats(fixture.source.id)).toMatchObject({ inclusive: { preDecrease: 0 } });
    expect(fixture.port.applyTransfer).not.toHaveBeenCalled();
  });

  it('到期目标停用记failed与待办，目标重新启用后可重试生效', async () => {
    const { db } = testDb();
    const fixture = await transferFixture(db, 'est-inactive-due', { targetCount: 5 });
    const submitted = await fixture.apply('submitted');
    const approved = await fixture.apply('approved', submitted.revision);
    const api = tenantApi(db);
    const disable = await api.request('PATCH', `/api/tenant/org/organizations/${fixture.target.id}`, {
      user: fixture.user.id,
      tenant: fixture.tenant.id,
      ifMatch: fixture.target.revision,
      body: { effectiveDate: '2026-10-02', enabled: false },
    });
    expect(disable.status).toBe(200);
    const disabled = (await disable.json()) as { revision: number };
    fixture.advanceTo(new Date('2026-10-02T01:00:00Z'));
    const failed = await fixture.apply('effective', approved.revision);
    expect(failed).toMatchObject({ status: 'failed', attempts: 1, failureReason: 'TARGET_ORG_DISABLED' });
    expect(fixture.port.applyTransfer).not.toHaveBeenCalled();
    const notifications = await fixture.request('GET', '/notifications');
    expect(notifications.status).toBe(200);
    expect(((await notifications.json()) as { items: unknown[] }).items).toContainEqual(
      expect.objectContaining({ businessId: fixture.businessId, reason: 'TARGET_ORG_DISABLED' }),
    );
    const reenabled = await api.request('PATCH', `/api/tenant/org/organizations/${fixture.target.id}`, {
      user: fixture.user.id,
      tenant: fixture.tenant.id,
      ifMatch: disabled.revision,
      body: { effectiveDate: '2026-10-02', enabled: true },
    });
    expect(reenabled.status).toBe(200);
    const effective = await fixture.apply('effective', failed.revision);
    expect(effective).toMatchObject({ status: 'effective', attempts: 2, failureReason: null });
    expect(fixture.port.applyTransfer).toHaveBeenCalledTimes(1);
  });
});
