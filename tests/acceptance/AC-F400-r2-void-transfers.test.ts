/**
 * F-400 第 2 轮（DEC-725 ③）：离职生效作废晚于最后工作日、已落地的未来调动。
 * ① 带编调动：与在途申请作废同一入口回退带编分配（源 / 目标额度与细分恢复、分配 reversed），重试不重复回退；
 *    回退不合法（超编）时整单回滚：墓碑、状态、台账、审计、通知都不留下。
 * ② 没有审批实例的未来直接调动：作废后经站内消息通道通知申请人与发起人（两人相同去重），不伪造审批实例，重试幂等。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { createUser, grantMembership, permissionUserPersonLinks, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { readCapacity } from '../../apps/api/src/modules/establishment/capacity-read.js';
import { rowsOf } from '../../apps/api/src/modules/employment/record-store.js';
import { carriedWorld } from './AC-TRF-47-EST-08-support.js';
import { exitActivator } from './AC-EXIT-activation-support.js';
import { downstreamWorld } from './AC-EXIT-downstream-support.js';
import { leaveBody } from './AC-EXIT-gate-support.js';
import { installExitSeeds } from './AC-EXIT-support.js';
import { cmd } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
type Carried = Awaited<ReturnType<typeof carriedWorld>>;

/** 回退在执行日产生新的容量版本，按执行日读额度与细分（同 AC-DM-16 B-12）。 */
const amountsAt = (w: Carried, date: string) =>
  withTenant(database().db, w.session.tenant.id, async (tx) =>
    (
      await Promise.all(
        [w.sourceCapacity, w.targetCapacity].map((id) => readCapacity(tx, w.session.tenant.id, id, date)),
      )
    ).map(({ localCapacity, reservedLocal, subdivisions }) => ({ localCapacity, reservedLocal, subdivisions })),
  );

const rows = <T>(w: Carried, statement: ReturnType<typeof sql>) =>
  withTenant(database().db, w.session.tenant.id, async (tx) => rowsOf<T>(await tx.execute(statement)));

const allocations = (w: Carried, businessId: string) =>
  rows<{ reversed: boolean }>(
    w,
    sql`SELECT reversed FROM transfer_establishment_allocations
    WHERE tenant_id=${w.session.tenant.id} AND business_id=${businessId}::uuid ORDER BY id`,
  );

/** 作废留下的痕迹：墓碑、台账、专项审计、站内消息（按模板，与是否挂审批实例无关）。 */
async function traces(w: Carried, businessId: string) {
  const t = w.session.tenant.id;
  const count = async (statement: ReturnType<typeof sql>) => Number((await rows<{ n: number }>(w, statement))[0]!.n);
  return {
    tombstones: await count(sql`SELECT count(*) AS n FROM employment_record_tombstones
      WHERE tenant_id=${t} AND record_id=${businessId}::uuid`),
    effects: await count(sql`SELECT count(*) AS n FROM exit_effects WHERE tenant_id=${t}
      AND target_id=${businessId}::uuid`),
    audits: await count(sql`SELECT count(*) AS n FROM audit_events WHERE tenant_id=${t}
      AND object_id=${businessId} AND action='employment.transfer.voided_by_exit'`),
    notices: await count(sql`SELECT count(*) AS n FROM approval_notifications WHERE tenant_id=${t}
      AND template_code='application_voided_by_exit'`),
  };
}

/** 直接离职（最后工作日 10-02）：有确认清单时先拿令牌再带回（§8）。 */
async function acked(session: Carried['session'], employeeId: string) {
  const create = async (exit?: object) =>
    session.request('POST', `/employees/${employeeId}/businesses`, {
      ifMatch: (await session.getEmployee(employeeId)).revision,
      body: leaveBody('2026-10-02', 'direct', exit),
    });
  let response = await create();
  if (response.status === 409) {
    const token = ((await response.json()) as { error: { details: { ackToken: string } } }).error.details.ackToken;
    response = await create({ pendingTransferAck: token });
  }
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as { id: string };
}

/** 经调动接口建 mode=direct、withEstablishment=true、10-20 生效的未来带编调动（已落地，没有审批实例）。 */
async function landedCarried(w: Carried) {
  const person = await w.hired();
  const before = await amountsAt(w, '2026-10-03');
  const saved = await w.save(person, { mode: 'direct', effectiveDate: '2026-10-20' });
  expect(saved.status, await saved.clone().text()).toBe(201);
  const transfer = (await saved.json()) as { id: string; status: string };
  expect(transfer.status).toBe('effective');
  expect(await amountsAt(w, '2026-10-03')).not.toEqual(before);
  expect(await allocations(w, transfer.id)).not.toEqual([]);
  return { person, transfer, before };
}

describe('F-400 r2 ① 已落地的未来带编调动被离职作废：回退带编分配', () => {
  it('源 / 目标额度与细分恢复，分配 reversed=true；重试不重复回退', async () => {
    const w = await carriedWorld(database().db, `f400r2-carry-${uniqueSuffix()}`);
    await installExitSeeds(database().db, w.session.tenant.id);
    const { person, transfer, before } = await landedCarried(w);
    const leave = await acked(w.session, person.employee.id);
    const activate = exitActivator(database().db, w.session);
    expect(await activate(leave.id, '2026-10-03')).toMatchObject({ outcome: 'effective' });

    expect((await w.business(transfer.id)).status).toBe('voided');
    expect(await amountsAt(w, '2026-10-03')).toEqual(before);
    expect((await allocations(w, transfer.id)).every((row) => row.reversed)).toBe(true);
    const once = await traces(w, transfer.id);

    // 再次触发生效（调度重跑）：已生效的离职被状态机拒绝，不再作废、不再回退
    await expect(activate(leave.id, '2026-10-03')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await amountsAt(w, '2026-10-03')).toEqual(before);
    expect(await traces(w, transfer.id)).toEqual(once);
  });

  it('回退会超编时离职生效失败 ESTABLISHMENT_EXCEEDED：墓碑 / 状态 / 台账 / 审计 / 通知与额度全部回滚', async () => {
    const w = await carriedWorld(database().db, `f400r2-carry-strict-${uniqueSuffix()}`);
    await installExitSeeds(database().db, w.session.tenant.id);
    const { person, transfer } = await landedCarried(w);
    // 另一名员工占满调入岗位后，回退带编分配会让调入部门超出严格编制（同 AC-DM-16 B-12 超编分支）
    const occupant = await w.session.employee('合成后来占编员工');
    await w.session.business(
      occupant.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-10-01',
        fields: { departmentId: w.to.id, positionId: w.targetPosition },
      },
      occupant.revision,
    );
    // 申请人有账号：回滚后不得留下站内消息
    await linkAccount(w, person.employee.id);
    const leave = await acked(w.session, person.employee.id);
    const amounts = await amountsAt(w, '2026-10-03');
    const reversedBefore = await allocations(w, transfer.id);

    expect(await exitActivator(database().db, w.session)(leave.id, '2026-10-03')).toMatchObject({
      outcome: 'failed',
      reason: 'ESTABLISHMENT_EXCEEDED',
    });
    expect((await w.business(transfer.id)).status).toBe('effective');
    expect((await w.business(leave.id)).status).not.toBe('effective');
    expect(await amountsAt(w, '2026-10-03')).toEqual(amounts);
    expect(await allocations(w, transfer.id)).toEqual(reversedBefore);
    expect(await traces(w, transfer.id)).toEqual({ tombstones: 0, effects: 0, audits: 0, notices: 0 });
  });
});

/** 员工的登录账号（申请人账号）：已有绑定直接沿用，否则新建一个并绑定。 */
async function linkAccount(w: Carried, employeeId: string) {
  const db = database().db;
  const [existing] = await rows<{ userId: string }>(
    w,
    sql`SELECT user_id AS "userId" FROM permission_user_person_links
    WHERE tenant_id=${w.session.tenant.id} AND employee_id=${employeeId}::uuid`,
  );
  if (existing) return existing.userId;
  const account = await createUser(db, { email: `f400r2-${randomUUID()}@example.com`, displayName: '申请人' }, cmd());
  await grantMembership(db, { tenantId: w.session.tenant.id, userId: account.id, expectedRevision: 0 }, cmd());
  await withTenant(db, w.session.tenant.id, (tx) =>
    tx.insert(permissionUserPersonLinks).values({ tenantId: w.session.tenant.id, userId: account.id, employeeId }),
  );
  return account.id;
}

describe('F-400 r2 ② 没有审批实例的未来直接调动被作废：站内消息通知申请人与发起人', () => {
  const notices = (x: Awaited<ReturnType<typeof downstreamWorld>>) =>
    x.sqlRows<{ recipient: string }>(sql`SELECT recipient_user_id AS recipient FROM approval_notifications
      WHERE tenant_id=${x.session.tenant.id} AND template_code='application_voided_by_exit' AND kind='message'
      ORDER BY recipient_user_id`);

  async function directFuture(x: Awaited<ReturnType<typeof downstreamWorld>>) {
    const transfer = await x.session.business(
      x.employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-20', fields: { departmentId: x.to.id } },
      (await x.session.getEmployee(x.employee.id)).revision,
    );
    expect(transfer.status).toBe('effective');
    expect(await x.instanceOf(transfer.id)).toBeUndefined();
    return transfer;
  }

  it('申请人与发起人各一条站内消息、不伪造审批实例；重试不重复发送', async () => {
    const x = await downstreamWorld(database().db, `f400r2-notice-${uniqueSuffix()}`, '2026-10-06');
    const applicant = await x.applicantAccount(x.employee.id);
    const transfer = await directFuture(x);
    const leave = await x.directLeave('2026-10-05');
    expect(await x.activate(leave.id, '2026-10-06')).toMatchObject({ outcome: 'effective' });

    expect(await x.stateOfBusiness(transfer.id)).toBe('voided');
    expect((await notices(x)).map((row) => row.recipient)).toEqual([x.session.user.id, applicant].sort());
    expect(await x.instanceOf(transfer.id)).toBeUndefined();
    // 再次触发生效（调度重跑）被拒，不重复发送
    await expect(x.activate(leave.id, '2026-10-06')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await notices(x)).toHaveLength(2);
  });

  it('申请人就是发起人时只发一条', async () => {
    const x = await downstreamWorld(database().db, `f400r2-notice-same-${uniqueSuffix()}`, '2026-10-06');
    await directFuture(x);
    const leave = await x.directLeave('2026-10-05');
    // 单据建好后把员工的账号改绑为发起人本人（本人不能给自己办单；夹具可能已给员工绑了别的账号）
    await withTenant(database().db, x.session.tenant.id, async (tx) => {
      await tx.execute(sql`DELETE FROM permission_user_person_links
        WHERE tenant_id=${x.session.tenant.id} AND employee_id=${x.employee.id}::uuid`);
      await tx
        .insert(permissionUserPersonLinks)
        .values({ tenantId: x.session.tenant.id, userId: x.session.user.id, employeeId: x.employee.id });
    });
    expect(await x.activate(leave.id, '2026-10-06')).toMatchObject({ outcome: 'effective' });
    expect((await notices(x)).map((row) => row.recipient)).toEqual([x.session.user.id]);
  });
});
