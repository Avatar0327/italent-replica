/**
 * R2-T04 BE-5a′ / AC-RT-10b：实际退休日期（撤销侧，设计 §6 接线点 5）。
 * 撤销已生效退休（record_deleted*）把实际退休日期恢复为该退休生效前的人事版本值（追加人事版本，审计 retirement.actual_date.restored）；
 * 撤销 approved / 未办结（approved_voided / process_voided）不动人事。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { retireBody } from './AC-RT-support.js';
import { retirementCancelWorld } from './AC-RT-cancel-support.js';

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
