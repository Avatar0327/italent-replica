/** astra R2-P2-01：两笔后补调动都传播过，迟到重建不能恢复任一已移走来源。 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { activationWorld, type ActivationWorld } from './AC-TRF-activation-support.js';
import { tenantApi } from './support/tenant-api.js';
import { versions } from './AC-JOB-sequence-support.js';
import { lockTransferParticipants } from '../../apps/api/src/modules/employment/transfer-locks.js';
import { pendingActivations } from '../../apps/api/src/modules/employment/activation-store.js';
import { activateWithJudgement } from '../../apps/api/src/modules/employment/activation-checks.js';

const database = useTestDb();
async function execute(w: ActivationWorld, employeeId: string, ids: string[]) {
  // 直接调用调度使用的同一业务端口，改变执行次序，不改生产队列排序或底表数据。
  for (const id of ids)
    await withTenant(w.db, w.session.tenant.id, async (tx) => {
      const ctx = {
        tenantId: w.session.tenant.id,
        userId: w.session.user.id,
        timezone: w.session.tenant.timezone,
        now: new Date('2026-10-10T01:00:00Z'),
        commandId: randomUUID(),
        expectedRevision: 0,
      };
      await lockTransferParticipants(tx, ctx, employeeId);
      const target = (await pendingActivations(tx, ctx, employeeId)).find((item) => item.id === id)!;
      expect(await activateWithJudgement(tx, ctx, target)).toBeNull();
    });
}
it.each(['scheduler', 'forward', 'reverse', 'first-on-time'])(
  'AC-ORG-32 按两笔传播来源的实际区间重建（执行顺序=%s）',
  async (order) => {
    const w = await activationWorld(database().db, `org32r3${order}`);
    const person = await w.hired();
    const lastOrg = await w.session.org('C 部门', { establishedOn: '2026-01-01' });
    const api = tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00Z') });
    const response = await api.request('PATCH', `/api/tenant/org/organizations/${w.from.id}`, {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
      ifMatch: w.from.revision,
      body: { name: 'A 改名', effectiveDate: '2026-10-09', addEmployment: true },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const adjustment = (await w.session.records(person.employee.id, '2026-10-09')).find((r) => r.isCurrent)!;
    const ids: string[] = [];
    for (const [date, departmentId] of [
      ['2026-10-05', w.to.id],
      ['2026-10-06', lastOrg.id],
    ]) {
      const transfer = await w.session.business(
        person.employee.id,
        {
          kind: 'transfer',
          mode: 'direct',
          effectiveDate: date,
          fields: { departmentId },
        },
        (await w.session.getEmployee(person.employee.id)).revision,
      );
      ids.push(transfer.id);
    }
    expect(
      (await w.session.records(person.employee.id, '2026-10-09')).find((r) => r.isCurrent)?.fields.departmentId,
    ).toBe(lastOrg.id);
    if (order === 'first-on-time')
      expect(await w.runScheduler('2026-10-05T01:00:00Z')).toMatchObject({ failed: [], errors: [] });
    if (order === 'scheduler' || order === 'first-on-time')
      expect(await w.runScheduler('2026-10-10T01:00:00Z')).toMatchObject({ failed: [], errors: [] });
    else await execute(w, person.employee.id, order === 'reverse' ? [...ids].reverse() : ids);
    expect
      .soft((await w.session.records(person.employee.id, '2026-10-09')).find((r) => r.isCurrent))
      .toMatchObject({ id: adjustment.id, fields: { departmentId: order === 'first-on-time' ? w.to.id : w.from.id } });
    expect((await w.session.records(person.employee.id, '2026-10-10')).find((r) => r.isCurrent)).toMatchObject({
      id: ids[1],
      fields: { departmentId: lastOrg.id },
    });
    const beforeRetry = await versions(w.db, w.session.tenant.id, person.employee.id);
    expect(await w.runScheduler('2026-10-10T02:00:00Z')).toMatchObject({ failed: [], errors: [] });
    expect(await versions(w.db, w.session.tenant.id, person.employee.id)).toEqual(beforeRetry);
  },
);
