/** AC-DM-05 × DM-R14：F-140b 替代、F-261 账号恢复与 BE-8b 交接发起的相交回归。 */
import './support/exit-gate-enforced.js';
import { getUser, setUserStatus, grantMembership, revokeMembership, sql, withPlatform } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it, vi } from 'vitest';
import * as accounts from '../../apps/api/src/modules/employment/exit-account-worker.js';
import * as handovers from '../../apps/api/src/modules/employment/exit-handover.js';
import { downstreamWorld } from './AC-EXIT-downstream-support.js';
import { leaveBody } from './AC-EXIT-gate-support.js';
import { handoverWorld } from './AC-EXIT-handover-support.js';
import { cmd } from './support/tenant-api.js';

const database = useTestDb();
const accountAudits = (userId: string) =>
  withPlatform(database().db, async (tx) => {
    const result = await tx.execute(sql`SELECT id FROM platform_audit_events
    WHERE object_id=${userId} AND action='user.set_status'`);
    return Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
  });
async function setup(label: string, lastWorkDate = '2026-10-05') {
  const x = await handoverWorld(database().db, `f261-handover-${label}`);
  await x.addSettingItems();
  await x.publishHandoverProcess();
  await x.setTrigger({ enabled: true, includePastLastWorkDate: true });
  const draft = await x.createdExit(x.employee.id, lastWorkDate, 'application', {
    exitTypeCode: 'voluntary',
    handoverEmployeeId: x.workOwner.employeeId,
  });
  const sent = await x.session.request('POST', `/businesses/${draft.id}/submit`, {
    ifMatch: draft.revision,
    body: {},
  });
  expect(sent.status, await sent.clone().text()).toBe(200);
  await x.approveInReview(draft.id);
  const old = await x.requestRows(draft.id);
  expect(old).toHaveLength(1);
  expect(old[0]!.state).toBe('in_progress');
  const patch = {
    ifMatch: (await x.business(draft.id)).revision,
    idempotencyKey: crypto.randomUUID(),
    body: { lastWorkDate: '2026-10-20' },
  };
  const replace = async () => {
    const response = await x.session.request('PATCH', `/exits/${draft.id}`, patch);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as { successor: { id: string; status: string; effectiveDate: string } };
  };
  const user = async () => (await getUser(database().db, x.leaverUserId))!;
  return { x, draft, old: old[0]!, replace, user };
}

it('AC-DM-05 × DM-R14：未生效改期保留原交接，账号保持 active', async () => {
  const { x, draft, old, replace, user } = await setup('approved', '2026-10-10');
  await replace();
  expect(await x.requestRows(draft.id)).toEqual([old]);
  expect((await user()).status).toBe('active');
});

it('AC-DM-05 × DM-R14：已生效改到未来，恢复账号并发起唯一后继交接；命令重放和调度均不多发', async () => {
  const { x, draft, replace, user } = await setup('replacement');
  expect((await x.business(draft.id)).status).toBe('effective');
  const disabled = await user();
  expect(disabled.status).toBe('disabled');
  const auditBefore = await accountAudits(disabled.id);
  const result = await replace();
  expect(await accountAudits(disabled.id)).toHaveLength(auditBefore.length + 1);
  expect(result.successor).toMatchObject({ status: 'approved', effectiveDate: '2026-10-21' });
  expect((await x.requestRows(draft.id))[0]).toMatchObject({ state: 'terminated', endReason: 'exit_cancelled' });
  const restored = await user();
  expect(restored.status).toBe('active');
  expect(restored.revision).toBe(disabled.revision + 1);
  const next = await x.requestRows(result.successor.id);
  expect(next).toHaveLength(1);
  expect(next[0]).toMatchObject({ state: 'in_progress', initiatorUserId: x.leaverUserId });
  expect((await x.statusOf(result.successor.id)).status).toBe('in_progress');
  expect(await replace()).toEqual(result);
  await x.runScheduler('2026-10-06T02:05:00Z');
  await x.runScheduler('2026-10-06T02:10:00Z');
  expect(await x.requestRows(result.successor.id)).toEqual(next);
  expect(await x.auditActions(next[0]!.id, 'exit_handover.launch')).toHaveLength(1);
  expect(await user()).toEqual(restored);
  expect(await accountAudits(disabled.id)).toHaveLength(auditBefore.length + 1);
});

it('AC-DM-05 × DM-R14：提交后消费者未运行，后续调度恢复账号并补发，重复调度不多发', async () => {
  const { x, replace, user } = await setup('recovery');
  const pause = vi.spyOn(accounts, 'drainExitAccounts').mockResolvedValue();
  let result: Awaited<ReturnType<typeof replace>>;
  try {
    result = await replace();
    expect((await user()).status).toBe('disabled');
    expect(await x.requestRows(result.successor.id)).toEqual([]);
  } finally {
    pause.mockRestore();
  }
  await x.runScheduler('2026-10-06T02:05:00Z');
  const restored = await user();
  expect(restored.status).toBe('active');
  const next = await x.requestRows(result.successor.id);
  expect(next).toHaveLength(1);
  expect(next[0]!.state).toBe('in_progress');
  await x.runScheduler('2026-10-06T02:10:00Z');
  expect(await x.requestRows(result.successor.id)).toEqual(next);
  expect(await user()).toEqual(restored);
  expect(await x.auditActions(next[0]!.id, 'exit_handover.launch')).toHaveLength(1);
});

it('AC-DM-05 × DM-R14：因果对照，替代前账号已恢复时正常发起后继交接', async () => {
  const { x, draft, replace, user } = await setup('control');
  const disabled = await user();
  expect(disabled.status).toBe('disabled');
  await setUserStatus(
    database().db,
    { userId: disabled.id, status: 'active', expectedRevision: disabled.revision },
    cmd(),
  );
  const result = await replace();
  expect((await x.requestRows(draft.id))[0]!.state).toBe('terminated');
  const next = await x.requestRows(result.successor.id);
  expect(next).toHaveLength(1);
  expect(next[0]!.state).toBe('in_progress');
});

it.each(['cancelled', 'trigger-off', 'membership-revoked', 'manual-disable'] as const)(
  'AC-DM-05 × DM-R14：补发前重新校验 %s，不复活或越权发起',
  async (change) => {
    const { x, replace, user } = await setup(change);
    const pause = vi.spyOn(accounts, 'drainExitAccounts').mockResolvedValue();
    let result: Awaited<ReturnType<typeof replace>>;
    try {
      result = await replace();
      if (change === 'cancelled') await x.cancelExit(result.successor.id);
      if (change === 'trigger-off') await x.setTrigger({ enabled: false });
      if (change === 'membership-revoked')
        await revokeMembership(
          database().db,
          {
            tenantId: x.tenantId,
            userId: x.leaverUserId,
            expectedRevision: 1,
          },
          cmd(),
        );
      if (change === 'manual-disable') {
        const current = await user();
        await setUserStatus(
          database().db,
          {
            userId: current.id,
            status: 'disabled',
            expectedRevision: current.revision,
          },
          cmd(),
        );
      }
    } finally {
      pause.mockRestore();
    }
    await x.runScheduler('2026-10-06T02:05:00Z');
    await x.runScheduler('2026-10-06T02:10:00Z');
    expect(await x.requestRows(result.successor.id)).toEqual([]);
    if (change === 'manual-disable') expect((await user()).status).toBe('disabled');
  },
);

it.each(['rollback', 'unavailable'] as const)(
  'AC-DM-05 × DM-R14：补发故障 %s 保留待办，账号不重复恢复',
  async (fault) => {
    const { x, replace, user } = await setup(fault);
    const launch = handovers.launchExitHandover;
    const broken = vi.spyOn(handovers, 'launchExitHandover').mockImplementation(async (...args) => {
      if (fault === 'unavailable') return { outcome: 'failed', reason: 'SERVICE_UNAVAILABLE' };
      await launch(...args);
      throw new Error('合成补发回执前故障');
    });
    let result: Awaited<ReturnType<typeof replace>>;
    try {
      result = await replace();
      expect((await user()).status).toBe('active');
      expect(await x.requestRows(result.successor.id)).toEqual([]);
      const attempts = await x.sqlRows<{ state: string }>(sql`SELECT a.state FROM employment_outbox_attempts a
      JOIN employment_outbox o ON o.tenant_id=a.tenant_id AND o.id=a.outbox_id
      WHERE o.tenant_id=${x.tenantId} AND o.business_id=${result.successor.id}::uuid
        AND o.event_type='employment.exit_handover.retry'`);
      expect(attempts.length).toBeGreaterThan(0);
      expect(attempts.every((a) => a.state === 'failed')).toBe(true);
    } finally {
      broken.mockRestore();
    }
    const restored = await user();
    const audits = await accountAudits(restored.id);
    await x.runScheduler('2026-10-06T02:05:00Z');
    const next = await x.requestRows(result.successor.id);
    expect(next).toHaveLength(1);
    expect(next[0]!.state).toBe('in_progress');
    expect(await x.auditActions(next[0]!.id, 'exit_handover.launch')).toHaveLength(1);
    expect(await user()).toEqual(restored);
    expect(await accountAudits(restored.id)).toEqual(audits);
  },
);

it.runIf(Boolean(process.env.TEST_DATABASE_URL))(
  'AC-DM-05 × DM-R14：两个真实 PG 调度并发补发只建一单和一个审批实例',
  async () => {
    const { x, replace } = await setup('concurrent');
    const pause = vi.spyOn(accounts, 'drainExitAccounts').mockResolvedValue();
    let result: Awaited<ReturnType<typeof replace>>;
    try {
      result = await replace();
    } finally {
      pause.mockRestore();
    }
    await Promise.all([x.runScheduler('2026-10-06T02:05:00Z'), x.runScheduler('2026-10-06T02:10:00Z')]);
    const next = await x.requestRows(result.successor.id);
    expect(next).toHaveLength(1);
    expect(next[0]!.state).toBe('in_progress');
    expect(await x.auditActions(next[0]!.id, 'exit_handover.launch')).toHaveLength(1);
    const instances = await x.sqlRows(sql`SELECT id FROM approval_instances
      WHERE tenant_id=${x.tenantId} AND business_type='exit_handover' AND business_id=${next[0]!.id}::uuid`);
    expect(instances).toHaveLength(1);
  },
);

it('AC-DM-05 × DM-R14：补发沿用原批准日判定包含过去日期，不误用调度日', async () => {
  const { x, replace, user } = await setup('approval-date');
  await x.setTrigger({ includePastLastWorkDate: false });
  const pause = vi.spyOn(accounts, 'drainExitAccounts').mockResolvedValue();
  let result: Awaited<ReturnType<typeof replace>>;
  try {
    result = await replace();
  } finally {
    pause.mockRestore();
  }
  // 模拟账号分钟调度先于任职落地调度：原单批准日 10-06，后继 L=10-20，重试日已是 10-22。
  await accounts.drainExitAccounts(database().db, x.tenantId, new Date('2026-10-22T02:00:00Z'));
  expect((await user()).status).toBe('active');
  const next = await x.requestRows(result.successor.id);
  expect(next).toHaveLength(1);
  expect(next[0]!.state).toBe('in_progress');
});

it('AC-DM-05 × DM-R14：另一租户调度不消费本租户待办', async () => {
  const { x, replace, user } = await setup('isolation');
  const other = await handoverWorld(database().db, 'f261-handover-other-tenant');
  const pause = vi.spyOn(accounts, 'drainExitAccounts').mockResolvedValue();
  let result: Awaited<ReturnType<typeof replace>>;
  try {
    result = await replace();
  } finally {
    pause.mockRestore();
  }
  await accounts.drainExitAccounts(database().db, other.tenantId, new Date('2026-10-06T02:05:00Z'));
  expect((await user()).status).toBe('disabled');
  expect(await x.requestRows(result.successor.id)).toEqual([]);
  await x.runScheduler('2026-10-06T02:10:00Z');
  expect((await user()).status).toBe('active');
  expect(await x.requestRows(result.successor.id)).toHaveLength(1);
});

it('AC-DM-05 × DM-R14：自动停用凭据归另一租户的离职单，恢复后仍补发本单交接', async () => {
  const { x, draft, user } = await setup('shared-credential', '2026-10-10');
  const y = await downstreamWorld(database().db, 'f261-handover-shared-owner');
  await grantMembership(
    database().db,
    { tenantId: y.session.tenant.id, userId: x.leaverUserId, expectedRevision: 0 },
    cmd(),
  );
  // 业务发生前将两个合成员工绑定到同一全局账号，沿用 F-261 多租户夹具。
  await y.sqlRows(sql`DELETE FROM permission_user_person_links
    WHERE tenant_id=${y.session.tenant.id} AND employee_id=${y.employee.id}::uuid`);
  await y.sqlRows(sql`INSERT INTO permission_user_person_links (tenant_id,user_id,employee_id)
    VALUES (${y.session.tenant.id},${x.leaverUserId}::uuid,${y.employee.id}::uuid)`);
  const other = await y.createdLeave(y.employee.id, leaveBody('2026-10-05', 'direct', { exitTypeCode: 'voluntary' }));
  expect((await user()).status).toBe('disabled');
  await x.runScheduler('2026-10-11T02:00:00Z');
  expect((await x.business(draft.id)).status).toBe('effective');
  const [task] = await x.sqlRows<{ auto: number | null }>(sql`SELECT auto_revision AS auto FROM exit_account_tasks
    WHERE tenant_id=${x.tenantId} AND business_id=${draft.id}::uuid`);
  expect(task!.auto).toBeNull();
  x.setNow('2026-10-11T02:01:00Z');
  const response = await x.session.request('PATCH', `/exits/${draft.id}`, {
    ifMatch: (await x.business(draft.id)).revision,
    body: { lastWorkDate: '2026-10-20' },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const result = (await response.json()) as { successor: { id: string } };
  expect((await user()).status).toBe('disabled');
  expect(await x.requestRows(result.successor.id)).toEqual([]);
  y.setNow('2026-10-11T02:02:00Z');
  const cancelled = await y.session.request('POST', `/exits/${other.id}/cancel`, {
    ifMatch: (await y.business(other.id)).revision,
    body: { reason: '合成多租户撤销' },
  });
  expect(cancelled.status, await cancelled.clone().text()).toBe(200);
  expect((await user()).status).toBe('active');
  await x.runScheduler('2026-10-11T02:05:00Z');
  const next = await x.requestRows(result.successor.id);
  expect(next).toHaveLength(1);
  expect(next[0]!.state).toBe('in_progress');
  await x.runScheduler('2026-10-11T02:10:00Z');
  expect(await x.requestRows(result.successor.id)).toEqual(next);
});
