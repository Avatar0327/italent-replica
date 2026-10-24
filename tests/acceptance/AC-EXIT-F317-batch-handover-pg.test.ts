/** F-317：真实员工锁强制交错，证明逐项独立提交和同批并发重放。 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { handoverWorld } from './AC-EXIT-handover-support.js';
import { waitForBlocked } from './support/pg-interleave.js';

const database = useTestDb();
const itPg = process.env.TEST_DATABASE_URL ? it : it.skip;
const path = '/exits/handover/batch-submit';
async function world(label: string) {
  const x = await handoverWorld(database().db, `f317-pg-${label}`);
  await x.addSettingItems();
  await x.publishHandoverProcess();
  const targets = [];
  for (const index of [1, 2]) {
    const employee = await x.colleague(`合成批量并发员工${index}`);
    await x.applicantAccount(employee.id);
    const exit = await x.createdExit(employee.id, '2026-10-21', 'direct', {
      exitTypeCode: 'voluntary',
      handoverEmployeeId: x.workOwner.employeeId,
    });
    targets.push({ employeeId: employee.id, exitRequestId: exit.id, revision: exit.revision });
  }
  return { ...x, targets };
}

describe('AC-DM-09 / F-317 真 PG 单 worker 强制交错', () => {
  itPg('第二项等员工锁时第一项已独立提交；同键并发最终回执相同且每项仅一个流程 / 审计', async () => {
    const x = await world('independent');
    const [a, b] = x.targets;
    let acquired!: () => void;
    let release!: () => void;
    const held = new Promise<void>((r) => {
      acquired = r;
    });
    const released = new Promise<void>((r) => {
      release = r;
    });
    const holder = withTenant(x.db, x.tenantId, async (tx) => {
      await tx.execute(sql`SELECT id FROM employment_employees WHERE tenant_id=${x.tenantId}
        AND id=${b!.employeeId}::uuid FOR NO KEY UPDATE`);
      acquired();
      await released;
    });
    await held;
    const init = {
      idempotencyKey: randomUUID(),
      body: { items: x.targets.map(({ exitRequestId, revision }) => ({ exitRequestId, revision })) },
    };
    const requests = [x.session.request('POST', path, init)];
    try {
      await waitForBlocked(x.db, 1);
      expect(await x.requestRows(a!.exitRequestId)).toHaveLength(1);
      expect(await x.requestRows(b!.exitRequestId)).toHaveLength(0);
      requests.push(x.session.request('POST', path, init));
      await waitForBlocked(x.db, 2);
    } finally {
      release();
      await holder;
    }
    const responses = await Promise.all(requests);
    for (const r of responses) expect(r.status, await r.clone().text()).toBe(200);
    expect(await responses[0]!.json()).toEqual(await responses[1]!.json());
    for (const target of x.targets) {
      const rows = await x.requestRows(target.exitRequestId);
      expect(rows).toHaveLength(1);
      expect(await x.auditActions(rows[0]!.id, 'exit_handover.launch')).toHaveLength(1);
    }
    expect(await x.handoverInstanceCount()).toBe(2);
  });
});
