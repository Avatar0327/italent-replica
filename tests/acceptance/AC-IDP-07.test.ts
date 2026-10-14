/**
 * AC-IDP-07（docs/02_业务建模/28 §5；IDP-R7 关键信息取计划起止内有交集的记录；PR 描述 K-16 / K-35）：
 * 计划 2026 年，轮岗记录 2025-10 至 2026-03 → 关键信息模块显示该轮岗（有交集）；完全在计划期外的不显示。
 * 同时覆盖带教 / 职业发展的交集与三类关键信息的判重键。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { errorOf, planWorld } from './AC-IDP-plan-support.js';

const testDb = useTestDb();
const IDP = '/api/tenant/idp';

describe('AC-IDP-07 关键信息取有交集的记录', () => {
  it('轮岗 2025-10～2026-03 与 2026 年计划有交集即显示；2024 年的轮岗不显示', async () => {
    const w = await planWorld(testDb().db, 'idp-ac07');
    const shift = async (body: Record<string, unknown>) =>
      w.ok<{ id: string }>(await w.http(w.hrUser, 'POST', `${IDP}/work-shifts`, { ifMatch: 0, body }), 201);
    const crossing = await shift({
      employeeId: w.employee.employeeId,
      orgId: w.dept,
      mentorEmployeeId: w.manager.employeeId,
      startDate: '2025-10-01',
      endDate: '2026-03-31',
    });
    await shift({ employeeId: w.employee.employeeId, orgId: w.dept, startDate: '2024-01-01', endDate: '2024-06-30' });
    const tutorship = await w.ok<{ id: string }>(
      await w.http(w.hrUser, 'POST', `${IDP}/tutorships`, {
        ifMatch: 0,
        body: {
          tutorEmployeeId: w.manager.employeeId,
          tuteeEmployeeId: w.employee.employeeId,
          startDate: '2026-12-01',
          endDate: '2027-05-31',
        },
      }),
      201,
    );
    const career = await w.ok<{ id: string }>(
      await w.http(w.hrUser, 'POST', `${IDP}/careers`, {
        ifMatch: 0,
        body: { employeeId: w.employee.employeeId, strengths: '系统设计', startDate: '2025-01-01', endDate: null },
      }),
      201,
    );
    const plan = await w.readPlan((await w.createPlan()).id);
    expect(plan.keyInfo!.workShifts!.map((s) => [s.id, s.startDate, s.endDate])).toEqual([
      [crossing.id, '2025-10-01', '2026-03-31'],
    ]);
    expect(plan.keyInfo!.tutorships!.map((s) => s.id)).toEqual([tutorship.id]);
    expect(plan.keyInfo!.careers!.map((s) => [s.id, s.strengths])).toEqual([[career.id, '系统设计']]);
  });

  it('判重键：带教 = 带教人 + 被带教人 + 起止；职业发展 = 员工 + 起止；轮岗 = 员工 + 部门 + 职位 + 起止', async () => {
    const w = await planWorld(testDb().db, 'idp-ac07-dup');
    const twice = async (path: string, body: Record<string, unknown>, reason: string) => {
      const first = await w.http(w.hrUser, 'POST', `${IDP}${path}`, { ifMatch: 0, body });
      expect(first.status, await first.clone().text()).toBe(201);
      const second = await w.http(w.hrUser, 'POST', `${IDP}${path}`, { ifMatch: 0, body });
      expect(await errorOf(second)).toMatchObject({ status: 409, reason });
    };
    const span = { startDate: '2026-01-01', endDate: '2026-06-30' };
    await twice(
      '/tutorships',
      { tutorEmployeeId: w.manager.employeeId, tuteeEmployeeId: w.employee.employeeId, ...span },
      'IDP_TUTORSHIP_DUPLICATE',
    );
    await twice('/careers', { employeeId: w.employee.employeeId, ...span }, 'IDP_CAREER_DUPLICATE');
    await twice(
      '/work-shifts',
      { employeeId: w.employee.employeeId, orgId: w.dept, ...span },
      'IDP_WORK_SHIFT_DUPLICATE',
    );
    // 不同员工同期轮岗到同一部门不冲突（判重键含员工，K-35 🟡）
    const other = await w.http(w.hrUser, 'POST', `${IDP}/work-shifts`, {
      ifMatch: 0,
      body: { employeeId: w.outsider.employeeId, orgId: w.dept, ...span },
    });
    expect(other.status).toBe(201);
  });

  it('结束早于开始 400；带教人与被带教人相同 400', async () => {
    const w = await planWorld(testDb().db, 'idp-ac07-invalid');
    const bad = await w.http(w.hrUser, 'POST', `${IDP}/careers`, {
      ifMatch: 0,
      body: { employeeId: w.employee.employeeId, startDate: '2026-06-01', endDate: '2026-01-01' },
    });
    expect(bad.status).toBe(400);
    const self = await w.http(w.hrUser, 'POST', `${IDP}/tutorships`, {
      ifMatch: 0,
      body: {
        tutorEmployeeId: w.employee.employeeId,
        tuteeEmployeeId: w.employee.employeeId,
        startDate: '2026-01-01',
        endDate: '2026-06-30',
      },
    });
    expect(self.status).toBe(400);
  });
});
