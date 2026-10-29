/**
 * R2-T03 编制类验收夹具（B3-3 预减、B4 撤销共用）：调出部门 / 调入部门各配严格编制 1（方案无细分），
 * 第三个部门无编制，用来安放“另一个人”。
 */
import { sql, type Db } from '@italent/db';
import { expect } from 'vitest';
import { downstreamWorld } from './AC-EXIT-downstream-support.js';
import { tenantApi } from './support/tenant-api.js';

const TODAY = '2026-10-06';

/**
 * capacity=false：不给调出 / 调入部门建编制。要停用这两个部门的用例用它——F-296 在 11e 前拒绝直接停用含编制的组织，
 * 这类用例关心的是停用与离职 / 退休的并发与校验，编制不是它们的前置。
 */
export async function capacityWorld(db: Db, label: string, today = TODAY, options: { capacity?: boolean } = {}) {
  const x = await downstreamWorld(db, label, today);
  const api = tenantApi(x.db, { clock: () => new Date(`${today}T01:00:00Z`) });
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
  if (options.capacity !== false) {
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
  }
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
export async function rehired(x: Awaited<ReturnType<typeof capacityWorld>>, department = x.to) {
  const employee = await x.session.getEmployee(x.employee.id);
  await x.session.business(
    employee.id,
    { kind: 'rehire', mode: 'direct', effectiveDate: '2026-11-01', fields: { departmentId: department.id } },
    employee.revision,
  );
}
