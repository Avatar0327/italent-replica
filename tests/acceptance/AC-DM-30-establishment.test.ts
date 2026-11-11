/**
 * AC-DM-30-F493-12：历史离职导入不做编制提示（设计 §7.2，U8）。部门编制已满、严格控制时导入照常成功，
 * 不返回 409，不写 over_capacity_confirmed 审计；报文带 confirmed 键属未知键 → 400。普通入职的编制行为不在本文件范围。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { importWorld, type ImportWorld } from './AC-DM-30-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const CONFIRMED = 'employment.exit.over_capacity_confirmed';

/** 年度编制方案 + 部门编制（periodStart 决定年度）。 */
async function capacity(x: ImportWorld, orgId: string, periodStart: string, strictControl: boolean) {
  const api = tenantApi(x.db, { clock: () => new Date('2026-11-05T01:00:00Z') });
  const post = async (path: string, body: object) => {
    const response = await api.request('POST', `/api/tenant/establishment${path}`, {
      user: x.session.user.id,
      tenant: x.tenantId,
      ifMatch: 0,
      body,
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string };
  };
  const scheme = await post('/schemes', {
    name: `导入编制方案${orgId.slice(0, 6)}`,
    periodType: 'annual',
    maintenanceMode: 'local',
    startDate: '2022-01-01',
  });
  return post('/capacities', { orgId, schemeId: scheme.id, periodStart, localCapacity: 1, strictControl });
}

/** 在编的现有人员：普通入职（单人不超上限）。 */
async function occupant(x: ImportWorld, departmentId: string, effectiveDate: string) {
  const employee = await x.session.employee('在编合成员工');
  const hire = await x.session.business(
    employee.id,
    { kind: 'hire', mode: 'direct', effectiveDate, fields: { departmentId } },
    employee.revision,
  );
  expect(hire.status).toBe('effective');
}

describe.each([
  ['严格控编', true],
  ['非严格控编', false],
])('AC-DM-30-F493-12 %s：编制满不提示', (_name, strict) => {
  it('202，行 succeeded；无确认审计；带 confirmed 键 → 400 零写入', async () => {
    const x = await importWorld(database().db, `12-${strict}`);
    const d = await x.dept('编制满部门');
    await capacity(x, d.id, '2025-01-01', strict);
    await occupant(x, d.id, '2024-01-01');
    const batchId = await x.imported([x.row(1, d.code)]);
    expect((await x.rowsOfBatch(batchId))[0]).toMatchObject({ status: 'succeeded', errors: [] });
    expect(await x.auditCount(CONFIRMED)).toBe(0);
    const before = await x.writeCounts();
    const response = await x.submit([x.row(2, d.code)], { confirmed: true });
    expect(response.status).toBe(400);
    expect(await x.writeCounts()).toEqual(before);
  });
});
