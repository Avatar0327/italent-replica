/**
 * BE-3 试用期信息落到任职（docs/02_业务建模/29 §1，15 §5；R2e6 / R2f1）与 F-205 默认转正日期：
 * 入职有试用期时写入开始日 / 月数 / 预计结束日；转正没填日期取预计结束日次日；
 * 转正日期是本任职周期的投影：转正记录及之后的记录都显示它（PB-R13），之前的不显示。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { addHire, entryAction, hireBody } from './AC-EN-BE2a-support.js';
import { hire, pbWorld, probationOf, regularizeOk, transition } from './AC-PB-support.js';

const testDb = useTestDb();

describe('BE-3 试用期信息', () => {
  it('直接入职有试用期：开始日 = 入职日，预计结束日 = 开始日 + 月数 − 1 天（10-16 + 1 个月 = 11-15）', async () => {
    const w = await pbWorld(testDb().db, 'pb-info-hire');
    const { employee } = await hire(w, { date: '2026-10-16', months: 1 });
    expect(await probationOf(w, employee.id, '2026-10-16')).toMatchObject({
      employeeId: employee.id,
      entryDate: '2026-10-16',
      hasProbation: true,
      startDate: '2026-10-16',
      months: 1,
      expectedEndDate: '2026-11-15',
      regularizationDate: null,
      actualEndDate: null,
    });
  });

  it('预计结束日可手填（R2e6 可手改）；无试用期为正式且其余字段为空', async () => {
    const w = await pbWorld(testDb().db, 'pb-info-manual');
    const manual = await hire(w, { months: 3, endDate: '2026-11-20' });
    expect(await probationOf(w, manual.employee.id)).toMatchObject({ months: 3, expectedEndDate: '2026-11-20' });
    const regular = await hire(w, { probation: false, name: '正式合成员工' });
    expect(await probationOf(w, regular.employee.id)).toMatchObject({
      hasProbation: false,
      startDate: null,
      months: null,
      expectedEndDate: null,
    });
    expect((regular.business as unknown as { employeeStatus: number }).employeeStatus).toBe(3);
  });

  it('入职控制项不合法：月数越界、无试用期却带月数、非入职类业务带月数均 400', async () => {
    const w = await pbWorld(testDb().db, 'pb-info-invalid');
    for (const extra of [
      { probation: true, probationMonths: 0 },
      { probation: true, probationMonths: 7 },
      { probation: false, probationMonths: 3 },
      { probation: true, probationEndDate: '2026-13-01' },
      { probation: true, probationMonths: 3, mode: 'application' },
    ]) {
      const employee = await w.session.employee();
      const response = await addHire(w.session, employee, hireBody(w.org.id, '2026-09-01', extra));
      expect(response.status, JSON.stringify(extra)).toBe(400);
    }
  });

  it('入职申请只记是否有试用期：生效后开始日取入职日，月数与预计结束日待调整试用信息填写', async () => {
    const w = await pbWorld(testDb().db, 'pb-info-apply');
    const employee = await w.session.employee();
    const created = await addHire(
      w.session,
      employee,
      hireBody(w.org.id, '2026-09-10', { mode: 'application', probation: true }),
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const business = (await created.json()) as { id: string };
    for (const action of ['submit', 'approve'] as const)
      expect((await transition(w, business, action)).status).toBe(200);
    expect(await probationOf(w, employee.id)).toMatchObject({
      hasProbation: true,
      startDate: '2026-09-10',
      months: null,
      expectedEndDate: null,
    });
  });

  it('办理入职时填写试用期：开始日 = 入职日，月数推算预计结束日', async () => {
    const w = await pbWorld(testDb().db, 'pb-info-complete');
    const employee = await w.session.employee();
    const added = await addHire(w.session, employee, hireBody(w.org.id, '2026-09-15', { pendingEntry: true }));
    expect(added.status, await added.clone().text()).toBe(201);
    const { id } = (await added.json()) as { id: string };
    const completed = await entryAction(w, id, 'complete', { probation: true, probationMonths: 2 });
    expect(completed.status, await completed.clone().text()).toBe(200);
    expect(await probationOf(w, employee.id)).toMatchObject({
      hasProbation: true,
      startDate: '2026-09-15',
      months: 2,
      expectedEndDate: '2026-11-14',
    });
  });

  it('F-205：转正不填日期取预计试用结束日次日（11-30 → 12-01），并写入实际试用结束日期', async () => {
    const w = await pbWorld(testDb().db, 'pb-info-default');
    const { employee } = await hire(w, { date: '2026-09-01', months: 3 });
    const receipt = await regularizeOk(w, { mode: 'direct' }, [employee.id]);
    expect(receipt.items[0]).toMatchObject({ status: 'succeeded', effectiveDate: '2026-12-01' });
    const detail = await probationOf(w, employee.id, '2026-12-01');
    expect(detail).toMatchObject({
      regularizationDate: '2026-12-01',
      actualEndDate: '2026-11-30',
      regularizationState: 'effective',
      probationResult: 'normal',
    });
  });

  it('F-205 跨年：预计结束 12-31 的默认转正日为次年 01-01', async () => {
    const w = await pbWorld(testDb().db, 'pb-info-year');
    const { employee } = await hire(w, { date: '2026-10-01', months: 3 });
    expect((await probationOf(w, employee.id)).expectedEndDate).toBe('2026-12-31');
    const receipt = await regularizeOk(w, { mode: 'direct' }, [employee.id]);
    expect(receipt.items[0]).toMatchObject({ status: 'succeeded', effectiveDate: '2027-01-01' });
  });

  it('PB-R13：转正日期是本周期的投影，转正记录及之后的记录都显示它、之前的不带（转正插在已有调动之前）', async () => {
    const w = await pbWorld(testDb().db, 'pb-info-forward');
    const { employee } = await hire(w, { date: '2026-09-01', months: 2 });
    await w.session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-12-01', fields: { place: '调动地点' } },
      (await w.session.getEmployee(employee.id)).revision,
    );
    await regularizeOk(w, { mode: 'direct', effectiveDate: '2026-11-01' }, [employee.id]);
    const detail = await probationOf(w, employee.id, '2026-12-01');
    expect(detail.records.map((record) => [record.kind, record.regularizationDate])).toEqual([
      ['hire', null],
      ['regularization', '2026-11-01'],
      ['transfer', '2026-11-01'],
    ]);
  });
});
