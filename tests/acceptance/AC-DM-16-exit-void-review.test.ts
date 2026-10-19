/**
 * R2-T03 B3-2 第 2 轮（#419 第 1 轮审查 P2-1～P2-4）：
 * 系统调度身份取消在途申请、超过查询上限整单拒绝、退休申请同样作废、审批已完成的申请被作废 / 撤回后仍发消息。
 * 只经内部编排器入口 activateExit 验证（§18.1 五个关口保持关闭）。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { createUser, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { createEmploymentBusiness } from '../../apps/api/src/modules/employment/write-service.js';
import { SYSTEM_USER_ID } from '../../apps/api/src/system-actor.js';
import { exitActivator } from './AC-EXIT-activation-support.js';
import { downstreamWorld, type DownstreamWorld } from './AC-EXIT-downstream-support.js';
import { cmd } from './support/tenant-api.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const world = (label: string) => downstreamWorld(database().db, label, TODAY);

/** 与生产调度同一身份：SYSTEM_USER_ID（不是租户成员），审计操作人记为空。 */
const asScheduler = (x: DownstreamWorld) =>
  exitActivator(x.db, { tenant: x.session.tenant, user: { id: SYSTEM_USER_ID } });

const actorsOf = (x: DownstreamWorld, objectId: string, action: string) =>
  x.sqlRows<{ actor: string | null }>(sql`SELECT actor_user_id AS actor FROM audit_events
    WHERE tenant_id=${x.session.tenant.id} AND object_id=${objectId} AND action=${action}`);

describe('P2-1 系统调度身份取消在途申请', () => {
  it('任职申请取消：SYSTEM_USER_ID 调度下离职生效，实例 cancelled，系统审计操作人为空', async () => {
    const x = await world('p21-employment');
    const leave = await x.directLeave('2026-10-05');
    const review = await x.transferIn('in_review', '2026-10-20');
    const instance = (await x.instanceOf(review.id))!;
    expect(await asScheduler(x)(leave.id, TODAY)).toMatchObject({ outcome: 'effective' });
    expect(await x.stateOfBusiness(review.id)).toBe('voided');
    expect(await x.instanceOf(review.id)).toMatchObject({ status: 'cancelled' });
    expect(await actorsOf(x, review.id, 'employment.transfer.voided_by_exit')).toEqual([{ actor: null }]);
    const [log] = await x.sqlRows<{ actor: string | null }>(sql`SELECT actor_user_id AS actor
      FROM approval_instance_logs WHERE tenant_id=${x.session.tenant.id} AND instance_id=${instance.id}::uuid
        AND event='cancel'`);
    expect(log).toEqual({ actor: null });
  });

  it('合同申请取消：SYSTEM_USER_ID 调度下离职生效，申请撤回，系统审计操作人为空', async () => {
    const x = await world('p21-contract');
    const type = await x.contractType('合同甲');
    const leave = await x.directLeave('2026-10-05');
    const request = (await x.createContract(type, { effectiveDate: '2026-10-20' }, 'application')).id;
    expect(await asScheduler(x)(leave.id, TODAY)).toMatchObject({ outcome: 'effective' });
    expect((await x.requestRows()).find((row) => row.id === request)!.status).toBe('withdrawn');
    expect(await x.instanceOf(request)).toMatchObject({ status: 'cancelled' });
    expect(await actorsOf(x, request, 'contract.request.exit_delete')).toEqual([{ actor: null }]);
  });

  it('普通用户仍做账号有效性检查：非成员身份取消失败，离职不落地且无部分写入', async () => {
    const x = await world('p21-ordinary');
    const leave = await x.directLeave('2026-10-05');
    const review = await x.transferIn('in_review', '2026-10-20');
    const before = await x.stateOf(x.employee.id);
    const outsider = await createUser(
      x.db,
      { email: `outsider-${randomUUID()}@example.com`, displayName: '非成员' },
      cmd(),
    );
    const stranger = exitActivator(x.db, { tenant: x.session.tenant, user: { id: outsider.id } });
    expect(await stranger(leave.id, TODAY)).toMatchObject({ outcome: 'failed' });
    const after = await x.stateOf(x.employee.id);
    for (const key of ['timeline', 'contracts', 'instances', 'effects', 'approvalLogs'] as const)
      expect(after[key], key).toEqual(before[key]);
    expect(await x.stateOfBusiness(review.id)).toBe('in_review');
  });
});

describe('P2-2 超过查询上限整单拒绝', () => {
  it('上限 + 1：生效前 fail-closed、机读原因、全部不变；降到上限后全部作废', async () => {
    const x = await world('p22-limit');
    const leave = await x.directLeave('2026-10-05');
    await x.bulkDrafts(1001);
    const before = await x.stateOf(x.employee.id);
    const counts = await x.stateCounts();
    const result = await x.activate(leave.id, TODAY);
    expect(result).toMatchObject({ outcome: 'failed', reason: 'EXIT_APPLICATIONS_TOO_MANY' });
    const after = await x.stateOf(x.employee.id);
    for (const key of ['timeline', 'contracts', 'instances', 'effects', 'approvalLogs'] as const)
      expect(after[key], key).toEqual(before[key]);
    expect(await x.stateCounts()).toEqual(counts);
    expect(await x.stateOfBusiness(leave.id)).toBe('approved');
    expect((await x.effects(leave.id)).filter((row) => row.kind === 'application_voided')).toEqual([]);

    // 处理掉一条后恰为上限：全部作废，没有剩余
    const [one] = await x.sqlRows<{ id: string }>(sql`SELECT business_id AS id FROM employment_state_events
      WHERE tenant_id=${x.session.tenant.id} AND command_id='bulk-draft' LIMIT 1`);
    await x.sqlRows(sql`INSERT INTO employment_state_events(tenant_id,employee_id,business_id,payload_version_id,state,
        event_no,command_id)
      SELECT tenant_id,employee_id,business_id,payload_version_id,'deleted',2,'bulk-delete'
      FROM employment_state_events WHERE tenant_id=${x.session.tenant.id} AND business_id=${one!.id}::uuid`);
    expect(await x.activate(leave.id, TODAY)).toMatchObject({ outcome: 'effective' });
    expect(await x.stateCounts()).toEqual([
      { state: 'deleted', n: 1 },
      { state: 'effective', n: expect.any(Number) },
      { state: 'voided', n: 1000 },
    ]);
  }, 600_000);
});

describe('P2-3 退休申请同样作废', () => {
  it('经通用创建入口建的退休草稿：离职后 voided，效果台账与 outbox 齐全', async () => {
    const x = await world('p23-retirement');
    const leave = await x.directLeave('2026-10-05');
    // R2-T04 §13.1 #1：离职/退休互斥后，公开入口已建不出这个组合；草稿改用可信造数（ctx.trustedExit = retirement），
    // 原断言（voided、台账、outbox）保持——离职作废“除本单外全部 kind”（DEC-496①）仍是必须保持的行为
    const employee = await x.session.getEmployee(x.employee.id);
    const draft = await withTenant(x.db, x.session.tenant.id, (tx) =>
      createEmploymentBusiness(
        tx,
        {
          tenantId: x.session.tenant.id,
          userId: x.session.user.id,
          timezone: x.session.tenant.timezone,
          now: new Date(`${TODAY}T01:00:00Z`),
          commandId: randomUUID(),
          expectedRevision: employee.revision,
          trustedExit: 'retirement',
        },
        x.employee.id,
        {
          kind: 'retirement',
          mode: 'application',
          effectiveDate: '2026-12-01',
          lastWorkDate: '2026-11-30',
          fields: {},
        },
      ),
    );
    expect(draft.status).toBe('draft');
    expect(await x.activate(leave.id, TODAY)).toMatchObject({ outcome: 'effective' });
    expect(await x.stateOfBusiness(draft.id)).toBe('voided');
    expect(
      (await x.effects(leave.id))
        .filter((row) => row.kind === 'application_voided')
        .map((row) => [row.target_id, (row.detail as { kind: string }).kind]),
    ).toEqual([[draft.id, 'retirement']]);
    expect(await x.outboxCount(draft.id, 'employment.business.voided_by_exit')).toBe(1);
  });
});

describe('P2-4 审批已完成的申请被作废 / 撤回后仍发消息', () => {
  it('任职：经审批中心同意（实例 approved）的未来调动，作废后仍给发起人发消息，实例保持 approved', async () => {
    const x = await world('p24-employment');
    const leave = await x.directLeave('2026-10-05');
    const review = await x.transferIn('in_review', '2026-10-20');
    await x.approveInReview(review.id);
    const instance = (await x.instanceOf(review.id))!;
    expect(instance.status).toBe('approved');
    expect(await x.stateOfBusiness(review.id)).toBe('approved');
    await x.activate(leave.id, TODAY);
    expect(await x.stateOfBusiness(review.id)).toBe('voided');
    expect((await x.instanceOf(review.id))!.status).toBe('approved');
    expect((await x.notices(instance.id)).map((row) => row.template)).toContain('application_voided_by_exit');
    expect((await x.effects(leave.id)).find((row) => row.kind === 'application_voided')!.detail).toMatchObject({
      instanceId: instance.id,
    });
  });

  it('合同：经审批中心同意（实例 approved）的未来合同申请，撤回后仍给发起人发消息', async () => {
    const x = await world('p24-contract');
    const type = await x.contractType('合同乙');
    const leave = await x.directLeave('2026-10-05');
    const request = (await x.createContract(type, { effectiveDate: '2026-10-20' }, 'application')).id;
    await x.approveInReview(request);
    const instance = (await x.instanceOf(request))!;
    expect(instance.status).toBe('approved');
    expect((await x.requestRows()).find((row) => row.id === request)!.status).toBe('approved');
    await x.activate(leave.id, TODAY);
    expect((await x.requestRows()).find((row) => row.id === request)!.status).toBe('withdrawn');
    expect(await x.notices(instance.id)).toEqual([
      { recipient: x.session.user.id, template: 'contract_request_voided_by_exit', kind: 'message' },
    ]);
  });
});
