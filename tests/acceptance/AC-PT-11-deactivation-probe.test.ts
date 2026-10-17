/**
 * AC-PT-11 组织停用计兼职；删除入职记录的探针（docs/08_设计/R2-T05_兼职设计.md §6.4 / §5.3 / §3.3 S13，§9 PB-30 / PB-31；PT-3a）：
 * - 停用（含下级）时，自停用日起与 [from, ∞) 相交的兼职记录按记录计入“任职记录 N 条”，不按员工去重；已结束的、空区间不计；
 * - 删除某周期的入职类记录时，该周期有兼职记录则整单拒绝（EMPLOYMENT_LINKED_CHANGES_EXIST 同形态）；删其他主职记录不受影响。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { serviceWorld, type ServiceWorld } from './AC-PT-service-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();

async function child(w: ServiceWorld, parentId: string) {
  return w.session.org(`兼职下级${uniqueSuffix()}`, {
    establishedOn: '2024-01-01',
    parents: { admin: { parentId } },
  });
}

describe('AC-PT-11 停用含兼职的组织', () => {
  it('PB-30：兼职挂在下级组织上 → 409 ORG_SUBTREE_NOT_EMPTY，计入兼职条数（两条同员工兼职算 2 条），组织不变', async () => {
    const w = await serviceWorld(database().db, 'pt11-count');
    const parent = await w.session.org(`停用上级${uniqueSuffix()}`, { establishedOn: '2024-01-01' });
    const sub = await child(w, parent.id);
    await w.create({ departmentId: sub.id, startDate: '2026-09-01', endDate: null });
    await w.create({ departmentId: sub.id, startDate: '2026-09-05', endDate: '2026-12-31' });
    const response = await w.disableOrg(parent, '2026-10-02');
    expect(response.status, await response.clone().text()).toBe(409);
    const body = (await response.json()) as { error: { message: string; details: Record<string, unknown> } };
    expect(body.error.message).toBe('当前组织或下级组织中存在待入职或在职员工任职记录2条，不能被停用');
    expect(body.error.details).toMatchObject({
      reason: 'ORG_SUBTREE_NOT_EMPTY',
      organizations: [{ orgId: sub.id, employeeCount: 2, positionCount: 0 }],
    });
  });

  it('只计自停用日起仍有效的兼职：停用日前已结束的、空区间的不计，停用日当天才结束的计入', async () => {
    const w = await serviceWorld(database().db, 'pt11-window');
    const org = await w.session.org(`停用窗口${uniqueSuffix()}`, { establishedOn: '2024-01-01' });
    await w.seedPartTime({ departmentId: org.id, startDate: '2026-09-01', endDate: '2026-10-01' });
    await w.seedPartTime({ departmentId: org.id, startDate: '2026-09-20', endDate: '2026-09-19' });
    const blocked = await w.disableOrg(org, '2026-10-02');
    expect(blocked.status, await blocked.clone().text()).toBe(200);
    const edge = await w.session.org(`停用当天结束${uniqueSuffix()}`, { establishedOn: '2024-01-01' });
    await w.seedPartTime({ departmentId: edge.id, startDate: '2026-09-01', endDate: '2026-10-02' });
    const counted = await w.disableOrg(edge, '2026-10-02');
    expect(counted.status).toBe(409);
    expect(((await counted.json()) as { error: { details: unknown } }).error.details).toMatchObject({
      organizations: [{ orgId: edge.id, employeeCount: 1 }],
    });
  });

  it('兼职记录被编辑改过部门后，按最新快照的部门计数', async () => {
    const w = await serviceWorld(database().db, 'pt11-snapshot');
    const org = await w.session.org(`旧部门${uniqueSuffix()}`, { establishedOn: '2024-01-01' });
    const record = await w.seedPartTime({ departmentId: org.id, startDate: '2026-09-01', endDate: null });
    await w.moveSnapshot(record, w.partTimeOrg.id);
    expect((await w.disableOrg(org, '2026-10-02')).status).toBe(200);
    expect((await w.disableOrg(w.partTimeOrg, '2026-10-02')).status).toBe(409);
  });
});

describe('AC-PT-11 / S13 删除入职记录的探针', () => {
  it('PB-31：删除该周期的入职（hire）记录 → 409 EMPLOYMENT_LINKED_CHANGES_EXIST，联动项为兼职记录，无写入', async () => {
    const w = await serviceWorld(database().db, 'pt11-delete-hire');
    await w.create({ startDate: '2026-09-01', endDate: null });
    await w.create({ startDate: '2026-09-02', endDate: '2026-09-30' });
    const hire = (await w.records(w.employeeId)).find((record) => record.kind === 'hire')!;
    const business = (await (await w.request('GET', `/businesses/${hire.id}`)).json()) as { revision: number };
    const before = await w.writes();
    const response = await w.request('DELETE', `/businesses/${hire.id}`, { ifMatch: business.revision });
    expect(response.status, await response.clone().text()).toBe(409);
    const body = (await response.json()) as { error: { details: { reason: string; linkages: unknown[] } } };
    expect(body.error.details.reason).toBe('EMPLOYMENT_LINKED_CHANGES_EXIST');
    expect(body.error.details.linkages).toEqual([expect.objectContaining({ kind: 'part-time', count: 2 })]);
    expect(await w.writes()).toEqual(before);
    expect((await w.records(w.employeeId)).map((record) => record.kind)).toContain('hire');
  });

  it('删除同周期里的其他主职记录（调动）不受兼职影响', async () => {
    const w = await serviceWorld(database().db, 'pt11-delete-transfer');
    await w.create({ startDate: '2026-09-01', endDate: null });
    const employee = await w.getEmployee(w.employeeId);
    const transfer = await w.business(
      w.employeeId,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-15', fields: { place: '调动地点' } },
      employee.revision,
    );
    const removed = await w.request('DELETE', `/businesses/${transfer.id}`, { ifMatch: transfer.revision });
    expect(removed.status, await removed.clone().text()).toBe(200);
  });

  it('其他员工的入职记录删除不受本员工兼职影响（按周期计）', async () => {
    const w = await serviceWorld(database().db, 'pt11-other-cycle');
    const other = await w.session.employee('无兼职员工');
    const hired = await w.session.business(
      other.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2025-01-01', fields: { departmentId: w.primaryOrg.id } },
      other.revision,
    );
    await w.create({ startDate: '2026-09-01', endDate: null });
    const removed = await w.request('DELETE', `/businesses/${hired.id}`, { ifMatch: hired.revision });
    expect(removed.status, await removed.clone().text()).toBe(200);
  });
});
