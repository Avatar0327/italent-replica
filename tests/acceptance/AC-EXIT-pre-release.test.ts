/**
 * R2-T03 B3-3 / AC-DM-24：批准即预减（设计 §6，DEC-266①）。编制占用投影 pendingExits：审批通过 / 直接离职确认当日 R 起，
 * 离职人在同一任职周期内的时间轴记录与申请预占段都不再占编，不用 L 过滤；跨周期（重聘）不误扣，也不被旧离职误放行。
 * 覆盖 B-21a、B-21c、B-62、B-62a、B-62b 与 B-77 步骤 1～2（申请预占段）。
 * 夹具：调出部门 / 调入部门各配严格编制 1（方案无细分），第三个部门无编制，用来安放“另一个人”。
 */
import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { downstreamWorld } from './AC-EXIT-downstream-support.js';
import { leaveBody } from './AC-EXIT-gate-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const TODAY = '2026-10-06';

async function capacityWorld(label: string) {
  const x = await downstreamWorld(database().db, label, TODAY);
  const api = tenantApi(x.db, { clock: () => new Date(`${TODAY}T01:00:00Z`) });
  const establishment = async (path: string, body: object) => {
    const response = await api.request('POST', `/api/tenant/establishment${path}`, {
      user: x.session.user.id,
      tenant: x.session.tenant.id,
      ifMatch: 0,
      body,
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string };
  };
  const scheme = await establishment('/schemes', {
    name: '预减验收方案',
    periodType: 'annual',
    maintenanceMode: 'local',
    startDate: '2026-01-01',
  });
  for (const org of [x.from, x.to])
    await establishment('/capacities', {
      orgId: org.id,
      schemeId: scheme.id,
      periodStart: '2026-01-01',
      localCapacity: 1,
      strictControl: true,
    });
  const other = await x.session.org('无编制部门', { establishedOn: '2026-01-01' });
  /** 另一个人（在无编制部门入职），用来向有编制的部门调入。 */
  async function newcomer(name: string) {
    const employee = await x.session.employee(name);
    await x.session.business(
      employee.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { departmentId: other.id } },
      employee.revision,
    );
    return employee;
  }
  /** 直接 / 申请调入：返回响应（严格编制超编 409 ESTABLISHMENT_EXCEEDED）。 */
  async function transferInto(employeeId: string, departmentId: string, effectiveDate: string, mode = 'direct') {
    return x.session.request('POST', `/transfers/employees/${employeeId}`, {
      ifMatch: (await x.session.getEmployee(employeeId)).revision,
      body: {
        initiator: 'hr',
        transferTypeCode: 'cross_department',
        mode,
        submit: mode === 'application',
        effectiveDate,
        fields: { departmentId },
      },
    });
  }
  const exceeded = async (response: Response) =>
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'ESTABLISHMENT_EXCEEDED' } } });
  const preReleaseDate = async (businessId: string) =>
    (
      await x.sqlRows<{ r: string | null }>(sql`SELECT pre_release_date::text AS r FROM exit_requests
        WHERE tenant_id=${x.session.tenant.id} AND business_id=${businessId}::uuid`)
    )[0]!.r;
  return { ...x, newcomer, transferInto, exceeded, other, preReleaseDate };
}

/** 11-01 重聘进入调入部门：新 staff_id 的新任职周期。 */
async function rehired(x: Awaited<ReturnType<typeof capacityWorld>>) {
  const employee = await x.session.getEmployee(x.employee.id);
  await x.session.business(
    employee.id,
    { kind: 'rehire', mode: 'direct', effectiveDate: '2026-11-01', fields: { departmentId: x.to.id } },
    employee.revision,
  );
}

describe('AC-DM-24 B-21a / B-21c 批准即预减：从 R 起员工不再占编，与 L 和生效日无关', () => {
  it('B-21a 直接离职保存当天（R）起即释放：此前被挡的调入放行；离职前仍占编', async () => {
    const x = await capacityWorld('pre-b21a');
    const newcomer = await x.newcomer('调入者');
    // 离职前：调出部门编制 1 被员工占满，另一人 10-10 调入超编
    await x.exceeded(await x.transferInto(newcomer.id, x.from.id, '2026-10-10'));

    const leave = await x.createdLeave(x.employee.id, leaveBody('2026-10-20', 'direct'));
    expect(leave.status).toBe('approved');
    expect(await x.preReleaseDate(leave.id)).toBe(TODAY);

    // 离职人仍在岗到 L（10-20），但编制从 R = 今天起释放：调入 10-10 不再超编
    const allowed = await x.transferInto(newcomer.id, x.from.id, '2026-10-10');
    expect(allowed.status, await allowed.clone().text()).toBe(201);
  });

  it('B-21a 申请离职：审批通过当天起释放，审批中（未批准）仍占编', async () => {
    const x = await capacityWorld('pre-b21a-approval');
    const newcomer = await x.newcomer('调入者');
    const draft = await x.submittedLeave('2026-10-20');
    await x.exceeded(await x.transferInto(newcomer.id, x.from.id, '2026-10-10'));
    await x.approve(draft, `${TODAY}T02:00:00Z`);
    expect(await x.stateOfBusiness(draft.id)).toBe('approved');
    expect((await x.transferInto(newcomer.id, x.from.id, '2026-10-10')).status).toBe(201);
  });

  it('B-21c 迟到顺延后 R 不变，修正行记 E′：释放时点仍是批准当天', async () => {
    const x = await capacityWorld('pre-b21c');
    const leave = await x.directLeave('2026-10-10');
    expect(await x.preReleaseDate(leave.id)).toBe(TODAY);
    expect(await x.runScheduler('2026-10-15T01:00:00Z')).toMatchObject({ activated: [leave.id] });
    expect(await x.preReleaseDate(leave.id)).toBe(TODAY);
    const effects = (await x.effects(leave.id)).filter((row) => row.kind === 'establishment_pre_released');
    expect(effects.map((row) => row.phase)).toEqual(['confirmed', 'effective']);
    expect(effects[0]!.detail).toMatchObject({ releasedFrom: TODAY, plannedEffectiveDate: '2026-10-11' });
    expect(effects[1]!.detail).toMatchObject({
      releasedFrom: TODAY,
      effectiveDate: '2026-10-15',
      lastWorkDate: '2026-10-14',
      correction: true,
    });
  });
});

describe('AC-DM-24 B-62 / B-62a 预减绑定任职周期（重聘开新周期）', () => {
  it('B-62 第一周期预减不影响重聘后的新周期：新周期照常占编，旧离职不误放行；旧周期占用已释放', async () => {
    const x = await capacityWorld('pre-b62');
    const newcomer = await x.newcomer('调入者');
    const leave = await x.directLeave('2026-10-20');
    expect(await x.runScheduler('2026-10-21T01:00:00Z')).toMatchObject({ activated: [leave.id] });
    // 11-01 重聘进入调入部门（新周期、新 staff_id）
    await rehired(x);
    // 调出部门（旧周期）自 R 起已释放：10-25 调入放行；调入部门里是重聘后的新周期记录，旧离职的预减不能误放行：11-10 调入超编
    expect((await x.transferInto(newcomer.id, x.from.id, '2026-10-25')).status).toBe(201);
    const second = await x.newcomer('第二个调入者');
    await x.exceeded(await x.transferInto(second.id, x.to.id, '2026-11-10'));
  });

  it('B-62a 第二次离职只释放第二周期：staff_id 为第二周期，R₂ 起新周期释放', async () => {
    const x = await capacityWorld('pre-b62a');
    const first = await x.directLeave('2026-10-20');
    await x.runScheduler('2026-10-21T01:00:00Z');
    await rehired(x);
    x.setNow('2026-12-01T01:00:00Z');
    const secondLeave = await x.createdLeave(x.employee.id, leaveBody('2026-12-20', 'direct'));
    const cycles = await x.sqlRows<{ id: string }>(sql`SELECT id FROM employment_cycles
      WHERE tenant_id=${x.session.tenant.id} AND employee_id=${x.employee.id}::uuid ORDER BY entry_date`);
    const staff = async (businessId: string) =>
      (
        await x.sqlRows<{ staff: string }>(sql`SELECT staff_id AS staff FROM exit_requests
          WHERE tenant_id=${x.session.tenant.id} AND business_id=${businessId}::uuid`)
      )[0]!.staff;
    expect(cycles).toHaveLength(2);
    expect([await staff(first.id), await staff(secondLeave.id)]).toEqual([cycles[0]!.id, cycles[1]!.id]);
    expect(await x.preReleaseDate(secondLeave.id)).toBe('2026-12-01');
    // 12-10：新周期（调入部门）已从 R₂ = 12-01 起释放，调入放行
    const newcomer = await x.newcomer('调入者');
    expect((await x.transferInto(newcomer.id, x.to.id, '2026-12-10')).status).toBe(201);
  });
});

describe('AC-DM-24 B-62b / B-77 R 之后开始的记录与申请预占段同样不占编（不用 L 过滤）', () => {
  it('B-62b 员工有 10-15 起调入 B 部门的直接调动（R 之后开始）：离职批准后 B 部门不再被他占编，另一人 10-22 调入放行', async () => {
    const x = await capacityWorld('pre-b62b');
    const newcomer = await x.newcomer('调入者');
    expect((await x.transferInto(x.employee.id, x.to.id, '2026-10-15')).status).toBe(201);
    // 员工 10-15 起占调入部门编制 1：另一人 10-22 调入超编
    await x.exceeded(await x.transferInto(newcomer.id, x.to.id, '2026-10-22'));
    const leave = await x.createdLeave(x.employee.id, leaveBody('2026-10-30', 'direct'));
    expect(await x.preReleaseDate(leave.id)).toBe(TODAY);
    expect((await x.transferInto(newcomer.id, x.to.id, '2026-10-22')).status).toBe(201);
  });

  it('B-77 步骤 1～2 审批中的调入申请预占段随预减扣掉：离职批准后另一人调入同岗位放行', async () => {
    const x = await capacityWorld('pre-b77');
    const newcomer = await x.newcomer('调入者');
    const review = await x.transferInto(x.employee.id, x.to.id, '2026-10-25', 'application');
    expect(review.status, await review.clone().text()).toBe(201);
    // 员工的审批中申请在调入部门 10-25 起预占（控编时机缺省“提交即占”）：另一人 10-26 调入超编
    await x.exceeded(await x.transferInto(newcomer.id, x.to.id, '2026-10-26'));
    // 批准离职（要先确认“将作废”审批中的调动，§8）
    const unconfirmed = await x.reason(await x.createLeave(x.employee.id, leaveBody('2026-10-30', 'direct')));
    expect(unconfirmed).toMatchObject({ status: 409, reason: 'EXIT_PENDING_TRANSFER_ACK_REQUIRED' });
    await x.createdLeave(
      x.employee.id,
      leaveBody('2026-10-30', 'direct', { pendingTransferAck: unconfirmed.ackToken }),
    );
    expect((await x.transferInto(newcomer.id, x.to.id, '2026-10-26')).status).toBe(201);
  });
});
