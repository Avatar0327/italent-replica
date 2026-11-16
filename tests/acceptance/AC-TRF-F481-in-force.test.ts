/** S2 自带 §4.3 判据用例；S3a 只需复用，不用其路由验证本片。 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@italent/api';
import { isTransferInForce } from '../../apps/api/src/modules/esign/transfer-in-force.js';
import { runEmploymentTransition } from '../../apps/api/src/modules/employment/transitions.js';
import * as contractPort from '../../apps/api/src/modules/transfer/linkage/contract.js';
import { signWorld, SIGN_AT, rows, type SignWorld } from './AC-TRF-F481-s2-support.js';

const database = useTestDb();
function context(w: SignWorld, at = SIGN_AT) {
  return {
    tenantId: w.tenantId,
    userId: w.session.user.id,
    timezone: w.session.tenant.timezone,
    now: new Date(at),
    commandId: crypto.randomUUID(),
    expectedRevision: 1,
  };
}
const inForce = (w: SignWorld, id: string, at = SIGN_AT) =>
  withTenant(w.db, w.tenantId, (tx) => isTransferInForce(tx, context(w, at), id));

describe('F-481 S2 §4.3 实际生效判据', () => {
  it('当天无联动直接调动已生效；无执行行不影响判定；跨租户与非调动不通过', async () => {
    const w = await signWorld(database().db, 'force-empty');
    const business = await w.direct({ linkage: undefined });
    await withTenant(w.db, w.tenantId, async (tx) => {
      expect(
        rows(
          await tx.execute(sql`SELECT 1 FROM transfer_linkage_runs WHERE tenant_id=${w.tenantId}
        AND business_id=${business.id}::uuid`),
        ),
      ).toEqual([]);
    });
    expect(await inForce(w, business.id)).toBe(true);
    expect(await inForce(w, w.person.hire.id)).toBe(false);
    const other = await signWorld(database().db, 'force-other');
    expect(await inForce(other, business.id)).toBe(false);
  });

  it('未来直接调动与已批准未来申请未生效；联动完成以后为真', async () => {
    const w = await signWorld(database().db, 'force-future');
    const business = await w.saved(await w.transfer(w.person, { mode: 'direct', submit: false, linkage: w.linkage() }));
    expect(await inForce(w, business.id, '2026-10-07T01:00:00Z')).toBe(false);
    expect(await inForce(w, business.id)).toBe(false);
    await w.runScheduler(SIGN_AT);
    expect(await inForce(w, business.id)).toBe(true);
    const other = await signWorld(database().db, 'force-approved');
    const app = await other.saved(await other.transfer(other.person, { linkage: other.linkage() }));
    await other.approve(app, '2026-10-07T01:00:00Z');
    expect(await inForce(other, app.id, '2026-10-07T01:00:00Z')).toBe(false);
    expect(await inForce(other, app.id)).toBe(false);
    await other.runScheduler(SIGN_AT);
    expect(await inForce(other, app.id)).toBe(true);
  });

  it.each(['reject', 'withdraw'] as const)('06 审批中与 %s 均不生效，不发起签署', async (action) => {
    const w = await signWorld(database().db, `force-${action}`);
    const app = await w.saved(await w.transfer(w.person, { linkage: w.linkage() }));
    expect(await inForce(w, app.id)).toBe(false);
    const result = await runEmploymentTransition(
      w.db,
      { ...context(w), expectedRevision: app.revision },
      { id: app.id, action },
    );
    expect(result.status).toBe(200);
    expect(await inForce(w, app.id)).toBe(false);
    await w.runScheduler(SIGN_AT);
    expect(await w.tasks()).toEqual([]);
  });

  it('合同联动失败后保持待生效，任务不落库；修复后重试生效', async () => {
    const w = await signWorld(database().db, 'force-failed');
    const app = await w.saved(await w.transfer(w.person, { linkage: w.linkage() }));
    await w.approve(app, '2026-10-07T01:00:00Z');
    const spy = vi
      .spyOn(contractPort, 'changeContractOnActivation')
      .mockRejectedValueOnce(new AppError('CONFLICT', '合成合同变化冲突', { reason: 'SYN_CONTRACT_CHANGED' }));
    try {
      const run = await w.runScheduler(SIGN_AT);
      expect(run.failed).toEqual([app.id]);
    } finally {
      spy.mockRestore();
    }
    expect(await inForce(w, app.id)).toBe(false);
    expect(await w.tasks()).toEqual([]);
    const retry = await w.retry(app, SIGN_AT);
    expect(retry.status, await retry.clone().text()).toBe(200);
    expect(await inForce(w, app.id)).toBe(true);
    expect(await w.tasks()).toHaveLength(1);
  });
});
