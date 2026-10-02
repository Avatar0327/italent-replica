/** DEC-080：任职路由按真实操作、按钮和展开后的业务字段鉴权。 */
import { randomUUID } from 'node:crypto';
import type { AuthorizationRequest } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { employmentSession } from './AC-EMP-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const objectCode = 'TenantBase.EmploymentRecord';

describe('AC-PRM-22 / DEC-080 任职授权接线', () => {
  async function fixture(denied: (request: AuthorizationRequest) => boolean) {
    const db = database().db;
    const session = await employmentSession(db, 'prm-employment-wiring');
    const employee = await session.employee();
    const business = await session.business(
      employee.id,
      { kind: 'hire', mode: 'application', effectiveDate: '2026-10-01', fields: { place: '甲地' } },
      employee.revision,
    );
    const calls: AuthorizationRequest[] = [];
    const api = tenantApi(db, {
      clock: () => new Date('2026-10-01T01:00:00.000Z'),
      authorize: (request) => {
        calls.push(request);
        return !denied(request);
      },
    });
    const as = { user: session.user.id, tenant: session.tenant.id };
    return { session, employee, business, api, as, calls };
  }

  it('创建员工和任职业务必须有 create，而不是沿用 update', async () => {
    const world = await fixture((request) => request.action === 'object.create');
    const employee = await world.api.request('POST', '/api/tenant/employment/employees', {
      ...world.as,
      ifMatch: 0,
      body: { code: `EMP_${randomUUID()}`, name: '不可创建' },
    });
    expect(employee.status).toBe(403);
    const business = await world.api.request(
      'POST',
      `/api/tenant/employment/employees/${world.employee.id}/businesses`,
      {
        ...world.as,
        ifMatch: 2,
        body: { kind: 'hire', mode: 'application', effectiveDate: '2026-10-02', fields: {} },
      },
    );
    expect(business.status).toBe(403);
  });

  it('删除业务必须有 delete 数据操作', async () => {
    const world = await fixture((request) => request.action === 'object.delete');
    const response = await world.api.request('DELETE', `/api/tenant/employment/businesses/${world.business.id}`, {
      ...world.as,
      ifMatch: world.business.revision,
    });
    expect(response.status).toBe(403);
  });

  it.each(['submit', 'delete'] as const)('%s 必须有对应按钮，update 开启不能替代', async (action) => {
    const world = await fixture((request) => request.action === 'object.button');
    const suffix = action === 'delete' ? '' : '/submit';
    const response = await world.api.request(
      action === 'delete' ? 'DELETE' : 'POST',
      `/api/tenant/employment/businesses/${world.business.id}${suffix}`,
      { ...world.as, ifMatch: world.business.revision },
    );
    expect(response.status).toBe(403);
    expect(
      world.calls.some(
        (request) => request.action === 'object.button' && request.resource?.startsWith(`${objectCode}#`),
      ),
    ).toBe(true);
  });

  it('嵌套 fields 中的不可编辑字段整单拒绝，不把 fields 容器当字段', async () => {
    const world = await fixture((request) => request.fields?.includes('place') === true);
    const response = await world.api.request('PATCH', `/api/tenant/employment/businesses/${world.business.id}`, {
      ...world.as,
      ifMatch: world.business.revision,
      body: { fields: { place: '未授权地点' } },
    });
    expect(response.status).toBe(403);
    expect(world.calls.some((request) => request.action === 'object.update' && request.fields?.includes('place'))).toBe(
      true,
    );
    const unchanged = await world.session.request('GET', `/businesses/${world.business.id}`);
    expect(((await unchanged.json()) as { fields: { place: string } }).fields.place).toBe('甲地');
  });

  it('导入按每项真正的 operation 和业务字段判权', async () => {
    const world = await fixture((request) => request.fields?.includes('place') === true);
    const response = await world.api.request('POST', `/api/tenant/employment/employees/${world.employee.id}/import`, {
      ...world.as,
      ifMatch: 2,
      body: {
        items: [
          {
            operation: 'create',
            business: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-01', fields: { place: '拒绝导入' } },
          },
        ],
        updateLaterEmployment: '否',
      },
    });
    expect(response.status).toBe(403);
    expect(world.calls.some((request) => request.action === 'object.create' && request.fields?.includes('place'))).toBe(
      true,
    );
  });
});
