/**
 * R2-T03 B3-1 第 1 轮审查返工（#410，三项 P2）的行为用例，均在旧实现下按行为断言判红：
 * ① 覆盖校验豁免只能给“同员工、同周期、真实离职之后”的被摘下调动，不得放行他人的调动缺投影；
 * ② 离职落地的引用校验按存在性而不是可用性 / 在职日：调动当天新设的部门、同日离职的经理都不得误拒；
 * ③ 删除被摘下的调动，审计 before 取最新记录快照，与版本 ID 对应的内容一致。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { exitActivationWorld, type ExitActivationWorld } from './AC-EXIT-activation-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const world = (label: string) => exitActivationWorld(database().db, label, TODAY);

async function futureTransfer(x: ExitActivationWorld, employeeId: string, date: string, fields: object) {
  const employee = await x.session.getEmployee(employeeId);
  return x.session.business(
    employeeId,
    { kind: 'transfer', mode: 'direct', effectiveDate: date, fields },
    employee.revision,
  );
}

describe('P2-1 覆盖校验豁免收窄：他人的调动不被放行', () => {
  it('把指向乙的调动的“摘下台账”记在甲的离职名下并删除乙的投影 → 提交被拒（employment_timeline_complete）', async () => {
    const x = await world('detach-other');
    const leave = await x.directLeave('2026-10-20');
    await x.activate(leave.id, '2026-10-21');
    const other = await x.session.employee('乙');
    await x.session.business(
      other.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { departmentId: x.from.id } },
      other.revision,
    );
    const transfer = await futureTransfer(x, other.id, '2026-10-25', { departmentId: x.to.id });
    const tenantId = x.session.tenant.id;
    const forged = withTenant(x.db, tenantId, async (tx) => {
      await tx.execute(sql`INSERT INTO exit_effects(tenant_id, business_id, employee_id, phase, kind, target_type,
          target_id, detail, command_id)
        VALUES (${tenantId}, ${leave.id}::uuid, ${x.employee.id}::uuid, 'effective', 'future_transfer_detached',
          'employment-record', ${transfer.id}::uuid, '{}'::jsonb, ${randomUUID()})`);
      await tx.execute(
        sql`DELETE FROM employment_timeline WHERE tenant_id=${tenantId} AND record_id=${transfer.id}::uuid`,
      );
      await tx.execute(sql`UPDATE employment_timeline SET valid_during=daterange(start_date, NULL, '[)')
        WHERE tenant_id=${tenantId} AND employee_id=${other.id}::uuid`);
    });
    await expect(forged).rejects.toThrow();
    expect((await x.timeline(other.id)).map((row) => row.kind)).toEqual(['hire', 'transfer']);
  });

  it('同员工但目标不是离职之后的调动（调动早于离职）→ 同样被拒', async () => {
    const x = await world('detach-before');
    const transfer = await futureTransfer(x, x.employee.id, '2026-10-10', { departmentId: x.to.id });
    const leave = await x.directLeave('2026-10-20');
    await x.activate(leave.id, '2026-10-21');
    const tenantId = x.session.tenant.id;
    const forged = withTenant(x.db, tenantId, async (tx) => {
      await tx.execute(sql`INSERT INTO exit_effects(tenant_id, business_id, employee_id, phase, kind, target_type,
          target_id, detail, command_id)
        VALUES (${tenantId}, ${leave.id}::uuid, ${x.employee.id}::uuid, 'effective', 'future_transfer_detached',
          'employment-record', ${transfer.id}::uuid, '{}'::jsonb, ${randomUUID()})`);
      await tx.execute(
        sql`DELETE FROM employment_timeline WHERE tenant_id=${tenantId} AND record_id=${transfer.id}::uuid`,
      );
      await tx.execute(sql`UPDATE employment_timeline SET valid_during=daterange(start_date, '2026-10-21', '[)')
        WHERE tenant_id=${tenantId} AND employee_id=${x.employee.id}::uuid AND start_date='2026-09-01'`);
    });
    await expect(forged).rejects.toThrow();
  });
});

describe('P2-2 离职落地的引用校验：按存在性，合法引用不被误拒', () => {
  it('① 员工 10-21 调入当天新设的部门，最后工作日 10-20 的离职落地：继承调动后的部门，成功', async () => {
    const x = await world('refs-new-dept');
    const created = await x.session.org('当天新设部门', { establishedOn: '2026-10-21' });
    await futureTransfer(x, x.employee.id, '2026-10-21', { departmentId: created.id });
    const leave = await x.directLeave('2026-10-20');
    expect(await x.activate(leave.id, '2026-10-21')).toMatchObject({ outcome: 'effective' });
    const records = await x.session.records(x.employee.id, '2026-10-21');
    expect(records.find((record) => record.kind === 'leave')!.fields.departmentId).toBe(created.id);
  });

  it('② 经理和下属同日离职，经理先落地后下属照常落地（不要求经理在离职日在职）', async () => {
    const x = await world('refs-manager');
    const subordinate = await x.session.employee('下属');
    await x.session.business(
      subordinate.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { departmentId: x.from.id, directManagerId: x.employee.id },
      },
      subordinate.revision,
    );
    const managerLeave = await x.directLeave('2026-10-20');
    const subordinateLeave = await x.directLeave('2026-10-20', undefined, subordinate.id);
    expect(await x.activate(managerLeave.id, '2026-10-21')).toMatchObject({ outcome: 'effective' });
    expect(await x.activate(subordinateLeave.id, '2026-10-21')).toMatchObject({ outcome: 'effective' });
  });
});

describe('P2-3 删除被摘下的调动：审计 before 取最新记录快照', () => {
  it('备注 before-edit 改为 after-edit 后被离职摘下再删除：delete.before 为新值，版本 ID 对应同一内容', async () => {
    const x = await world('detach-audit');
    const transfer = await futureTransfer(x, x.employee.id, '2026-10-25', {
      departmentId: x.to.id,
      remarks: 'before-edit',
    });
    const edited = await x.session.request('PATCH', `/records/${transfer.id}`, {
      ifMatch: transfer.revision,
      body: { fields: { remarks: 'after-edit' } },
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    const leave = await x.directLeave('2026-10-20');
    await x.activate(leave.id, '2026-10-21');
    x.setNow('2026-10-26T01:00:00Z');
    const current = await x.business(transfer.id);
    const deleted = await x.session.request('DELETE', `/businesses/${transfer.id}`, { ifMatch: current.revision });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    const [audit] = await x.audits(transfer.id, 'employment.record.delete');
    const before = audit!.before as Record<string, unknown>;
    expect(before.remarks).toBe('after-edit');
    const [version] = await x.sqlRows<{ remarks: string | null }>(sql`SELECT remarks FROM employment_payload_versions
      WHERE tenant_id=${x.session.tenant.id} AND id=${String(before.payloadVersionId)}::uuid`);
    expect(version!.remarks).toBe(before.remarks);
  });
});

describe('P2-1 第 3 轮：同日先后按可信顺序（C-3：计划生效日 → 操作序号），不信台账', () => {
  const forgeDetach = (x: ExitActivationWorld, leaveId: string, transferId: string) => {
    const tenantId = x.session.tenant.id;
    return withTenant(x.db, tenantId, async (tx) => {
      await tx.execute(sql`INSERT INTO exit_effects(tenant_id, business_id, employee_id, phase, kind, target_type,
          target_id, detail, command_id)
        VALUES (${tenantId}, ${leaveId}::uuid, ${x.employee.id}::uuid, 'effective', 'future_transfer_detached',
          'employment-record', ${transferId}::uuid, '{"window":{"from":"2026-10-21","to":null}}'::jsonb,
          ${randomUUID()})`);
      await tx.execute(
        sql`DELETE FROM employment_timeline WHERE tenant_id=${tenantId} AND record_id=${transferId}::uuid`,
      );
    });
  };

  it('a. 同日 T 排在离职之前（H→T→L）：伪造台账并删除 T 投影 → 提交被拒，历史不变', async () => {
    const x = await world('same-day-before');
    const transfer = await futureTransfer(x, x.employee.id, '2026-10-21', { departmentId: x.to.id });
    const leave = await x.directLeave('2026-10-20');
    await x.activate(leave.id, '2026-10-21');
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire', 'transfer', 'leave']);
    await expect(forgeDetach(x, leave.id, transfer.id)).rejects.toThrow();
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire', 'transfer', 'leave']);
  });

  it('b. 同日 T 排在离职之后（计划日相同、操作序号更晚）：真实摘下成功', async () => {
    const x = await world('same-day-after');
    const leave = await x.directLeave('2026-10-20');
    const transfer = await futureTransfer(x, x.employee.id, '2026-10-21', { departmentId: x.to.id });
    expect(await x.activate(leave.id, '2026-10-21')).toMatchObject({ outcome: 'effective' });
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire', 'leave']);
    expect(await x.effects(leave.id)).toContainEqual(
      expect.objectContaining({ kind: 'future_transfer_detached', target_id: transfer.id }),
    );
  });

  it('c. 同日多条调动前后混排：只摘下排在离职之后的，之前的保留在历史里', async () => {
    const x = await world('same-day-mixed');
    const before = await futureTransfer(x, x.employee.id, '2026-10-21', { departmentId: x.to.id });
    const leave = await x.directLeave('2026-10-20');
    const after = await futureTransfer(x, x.employee.id, '2026-10-21', { departmentId: x.from.id });
    expect(await x.activate(leave.id, '2026-10-21')).toMatchObject({ outcome: 'effective' });
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire', 'transfer', 'leave']);
    const detached = (await x.effects(leave.id)).filter((row) => row.kind === 'future_transfer_detached');
    expect(detached.map((row) => row.target_id)).toEqual([after.id]);
    expect((await x.timeline()).map((row) => row.record_id)).toContain(before.id);
    await expect(forgeDetach(x, leave.id, before.id)).rejects.toThrow();
  });
});
