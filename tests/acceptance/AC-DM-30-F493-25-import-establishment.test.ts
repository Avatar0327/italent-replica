/**
 * AC-DM-30-F493-25：通用任职导入超编仍只警告（S3c 回归，设计 §9）。
 * 历史离职导入不再把任职段按编制拦截（importedTenureExcesses 已删除）；通用任职导入的超编提示走
 * record-edit.ts 的 establishmentWarnings 收集器，返回 2xx + warnings，不得变成 409。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { activationWorld } from './AC-TRF-activation-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();

describe('AC-DM-30-F493-25 通用任职导入超编', () => {
  it('目标部门编制已满且严格控制：修改已有任职、改到该部门 → 2xx，warnings 含 ESTABLISHMENT_EXCEEDED', async () => {
    const w = await activationWorld(database().db, 'f493-25');
    const api = tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00Z') });
    const est = (method: string, path: string, body: object) =>
      api.request(method, `/api/tenant/establishment${path}`, {
        user: w.session.user.id,
        tenant: w.session.tenant.id,
        ifMatch: 0,
        body,
      });
    const scheme = await est('POST', '/schemes', {
      name: '合成严格控编方案',
      periodType: 'annual',
      maintenanceMode: 'local',
      startDate: '2026-01-01',
      occupancyRanges: [{ employmentType: 'internal' }],
    });
    expect(scheme.status, await scheme.clone().text()).toBe(201);
    const capacity = await est('POST', '/capacities', {
      orgId: w.to.id,
      schemeId: ((await scheme.json()) as { id: string }).id,
      periodStart: '2026-01-01',
      localCapacity: 0,
      strictControl: true,
    });
    expect(capacity.status, await capacity.clone().text()).toBe(201);

    const { employee, hire } = await w.hired();
    const response = await w.session.request('POST', `/employees/${employee.id}/import`, {
      ifMatch: hire.employeeRevision,
      body: {
        items: [
          {
            operation: 'edit',
            id: hire.id,
            revision: hire.revision,
            patch: { fields: { departmentId: w.to.id } },
          },
        ],
      },
    });
    expect(response.status, await response.clone().text()).toBeLessThan(300);
    expect(await response.json()).toMatchObject({ warnings: [{ reason: 'ESTABLISHMENT_EXCEEDED' }] });
  });
});
