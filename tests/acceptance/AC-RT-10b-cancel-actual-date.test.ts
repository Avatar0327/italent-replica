/**
 * R2-T04 BE-5a′ / AC-RT-10b：实际退休日期（撤销侧，设计 §6 接线点 5）。
 * 撤销已生效退休（record_deleted*）把实际退休日期恢复为该退休生效前的人事版本值（追加人事版本，审计 retirement.actual_date.restored）；
 * 撤销 approved / 未办结（approved_voided / process_voided）不动人事。
 */
import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { retireBody } from './AC-RT-support.js';
import { retirementCancelWorld, type RetirementCancelWorld } from './AC-RT-cancel-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const world = (label: string) => retirementCancelWorld(database().db, label, TODAY);

describe('AC-RT-10b 撤销已生效退休：实际退休日期恢复为生效前的值', () => {
  it('首次退休（生效前为空）：生效写 E′，撤销恢复为空；追加人事版本并审计前后值', async () => {
    const x = await world('rt10b-null');
    const retire = await x.createdRetire(x.employee.id, retireBody('2026-10-05', 'direct'));
    expect(retire.status).toBe('effective');
    expect((await x.retirementDates()).actual).toBe(TODAY);
    const versions = await x.personnelVersionCount();

    const result = await x.retireCancelled(retire.id);

    expect(result.cancellation.case).toBe('record_deleted_reinstated');
    expect((await x.retirementDates()).actual).toBeNull();
    expect(await x.personnelVersionCount()).toBe(versions + 1);
    const [restored] = await x.audits(retire.id, 'retirement.actual_date.restored');
    expect(restored).toMatchObject({
      before: { actualRetirementDate: TODAY },
      after: { actualRetirementDate: null },
    });
    expect(await x.audits(retire.id, 'retirement.actual_date.restored')).toHaveLength(1);
  });

  it('生效前已有值（上一次退休留下的）：撤销恢复为该值，不是空', async () => {
    const x = await world('rt10b-previous');
    await x.setActualRetirement('2025-12-31');
    const retire = await x.createdRetire(x.employee.id, retireBody('2026-10-05', 'direct'));
    expect((await x.retirementDates()).actual).toBe(TODAY);

    await x.retireCancelled(retire.id);

    expect((await x.retirementDates()).actual).toBe('2025-12-31');
    const [restored] = await x.audits(retire.id, 'retirement.actual_date.restored');
    expect(restored).toMatchObject({
      before: { actualRetirementDate: TODAY },
      after: { actualRetirementDate: '2025-12-31' },
    });
  });

  it('生效后实际退休日期已被别处改写（不再等于本退休写入的值）：不覆盖，不追加版本', async () => {
    const x = await world('rt10b-overwritten');
    const retire = await x.createdRetire(x.employee.id, retireBody('2026-10-05', 'direct'));
    await x.setActualRetirement('2026-10-01');
    const versions = await x.personnelVersionCount();

    await x.retireCancelled(retire.id);

    expect((await x.retirementDates()).actual).toBe('2026-10-01');
    expect(await x.personnelVersionCount()).toBe(versions);
    expect(await x.audits(retire.id, 'retirement.actual_date.restored')).toEqual([]);
  });
});

describe('AC-RT-10b 撤销 approved / 未办结退休：不动人事', () => {
  it('approved 撤销：实际退休日期本就未写，人事版本数不变，无 restored 审计', async () => {
    const x = await world('rt10b-approved');
    await x.setActualRetirement('2025-12-31');
    const retire = await x.directRetire('2026-10-20');
    const versions = await x.personnelVersionCount();

    const result = await x.retireCancelled(retire.id);

    expect(result.cancellation.case).toBe('approved_voided');
    expect((await x.retirementDates()).actual).toBe('2025-12-31');
    expect(await x.personnelVersionCount()).toBe(versions);
    expect(await x.audits(retire.id, 'retirement.actual_date.restored')).toEqual([]);
  });

  it('草稿 / 审批中撤销：同样不动人事', async () => {
    const x = await world('rt10b-process');
    const draft = await x.createdRetire(x.employee.id, retireBody('2026-10-20', 'application'));
    const versions = await x.personnelVersionCount();
    expect((await x.retireCancelled(draft.id)).cancellation.case).toBe('process_voided');

    const submitted = await x.submittedRetire('2026-10-22');
    expect((await x.retireCancelled(submitted.id)).cancellation.case).toBe('process_voided');

    expect(await x.personnelVersionCount()).toBe(versions);
    expect((await x.retirementDates()).actual).toBeNull();
  });
});

/**
 * 日志保留期清理的效果：本租户全部业务审计整条删除（DEC-198）。生产清理 purge_expired_audit 的截止日以数据库真实时钟封顶
 * （LEAST(传入时间, now())），夹具的业务日期在“今天”附近，到不了六个月前，所以这里用清理函数同一个放行开关
 * （italent.audit_purge）直接删，效果等同“生效审计已过保留期被清理”。
 */
async function purgeAudit(x: RetirementCancelWorld) {
  const tenantId = x.session.tenant.id;
  await x.db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('italent.audit_purge', 'on', true)`,
    );
    await tx.execute(sql`DELETE FROM audit_events WHERE tenant_id=${tenantId}`);
  });
  expect(await x.sqlRows(sql`SELECT 1 FROM audit_events WHERE tenant_id=${tenantId}`)).toEqual([]);
}

describe('AC-RT-10b 生效审计已被保留期清理后：恢复依据取自人事版本链，不依赖审计行（第 1 轮审查 P2-1）', () => {
  it('生效前为空：审计清理后撤销，实际退休日期恢复为空；追加人事版本', async () => {
    const x = await world('rt10b-purged-null');
    const retire = await x.createdRetire(x.employee.id, retireBody('2026-10-05', 'direct'));
    expect((await x.retirementDates()).actual).toBe(TODAY);
    await purgeAudit(x);
    expect(await x.audits(retire.id, 'retirement.actual_date.synced')).toEqual([]);
    const versions = await x.personnelVersionCount();

    await x.retireCancelled(retire.id);

    expect((await x.retirementDates()).actual).toBeNull();
    expect(await x.personnelVersionCount()).toBe(versions + 1);
  });

  it('生效前有值：审计清理后撤销，恢复为该值', async () => {
    const x = await world('rt10b-purged-value');
    await x.setActualRetirement('2025-12-31');
    const retire = await x.createdRetire(x.employee.id, retireBody('2026-10-05', 'direct'));
    await purgeAudit(x);

    await x.retireCancelled(retire.id);

    expect((await x.retirementDates()).actual).toBe('2025-12-31');
    // 清理后撤销新写的恢复审计仍在（清理只删过期的）
    expect(await x.audits(retire.id, 'retirement.actual_date.restored')).toHaveLength(1);
  });

  it('审计清理后当前值已被后续改写：仍不覆盖，不追加版本', async () => {
    const x = await world('rt10b-purged-overwritten');
    const retire = await x.createdRetire(x.employee.id, retireBody('2026-10-05', 'direct'));
    await purgeAudit(x);
    await x.setActualRetirement('2026-10-01');
    const versions = await x.personnelVersionCount();

    await x.retireCancelled(retire.id);

    expect((await x.retirementDates()).actual).toBe('2026-10-01');
    expect(await x.personnelVersionCount()).toBe(versions);
  });

  it('调度到期生效（与撤销不同一个命令）：审计清理后同样恢复', async () => {
    const x = await world('rt10b-purged-scheduler');
    await x.setActualRetirement('2025-12-31');
    const retire = await x.directRetire('2026-10-20');
    expect(await x.runScheduler('2026-10-21T01:00:00Z')).toMatchObject({ activated: [retire.id] });
    expect((await x.retirementDates()).actual).toBe('2026-10-21');
    await purgeAudit(x);
    x.session.setNow('2026-10-22T01:00:00Z');

    await x.retireCancelled(retire.id);

    expect((await x.retirementDates()).actual).toBe('2025-12-31');
  });

  it('审批通过当场生效：审计清理后同样恢复', async () => {
    const x = await world('rt10b-purged-approval');
    const draft = await x.submittedRetire('2026-10-05');
    expect((await x.approve(draft, `${TODAY}T02:00:00Z`)).status).toBe('effective');
    expect((await x.retirementDates()).actual).toBe(TODAY);
    await purgeAudit(x);

    await x.retireCancelled(draft.id);

    expect((await x.retirementDates()).actual).toBeNull();
  });

  it('迟到顺延后的生效（E′ ≠ 原计划）：审计清理后同样恢复', async () => {
    const x = await world('rt10b-purged-late');
    await x.setActualRetirement('2025-12-31');
    const retire = await x.directRetire('2026-10-15');
    expect(await x.runScheduler('2026-10-18T01:00:00Z')).toMatchObject({ activated: [retire.id] });
    expect((await x.retirementDates()).actual).toBe('2026-10-18');
    await purgeAudit(x);
    x.session.setNow('2026-10-19T01:00:00Z');

    await x.retireCancelled(retire.id);

    expect((await x.retirementDates()).actual).toBe('2025-12-31');
  });
});

describe('AC-RT-10b 无法确定恢复来源时明确拒绝并回滚（第 1 轮审查 P2-1）', () => {
  it('生效前的实际退休日期本就等于 E′（生效没有改变它）：撤销 409 RETIREMENT_ACTUAL_DATE_SOURCE_UNKNOWN，整单回滚', async () => {
    const x = await world('rt10b-unknown');
    await x.setActualRetirement(TODAY);
    const retire = await x.createdRetire(x.employee.id, retireBody('2026-10-05', 'direct'));
    expect((await x.retirementDates()).actual).toBe(TODAY);
    const before = await x.stateOf(x.employee.id);

    const response = await x.cancelRetire(retire.id);

    expect(await x.reason(response)).toMatchObject({
      status: 409,
      reason: 'RETIREMENT_ACTUAL_DATE_SOURCE_UNKNOWN',
    });
    expect(await x.stateOfBusiness(retire.id)).toBe('effective');
    expect(await x.cancellationOf(retire.id)).toBeUndefined();
    expect(await x.stateOf(x.employee.id)).toEqual(before);
  });
});
