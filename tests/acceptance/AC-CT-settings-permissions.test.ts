import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { contractWorld } from './AC-CT-support.js';
import { tenantApi } from './support/tenant-api.js';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import type { Authorizer } from '@italent/api';

const testDb = useTestDb();
describe('R2-T06 期限联动、重聘计数和权限', () => {
  it('CT-R16 所选类型第三次签订默认无固定期限；手工明确选择仍可覆盖默认', async () => {
    const w = await contractWorld(testDb().db, 'ctterm');
    await w.settings({ indefiniteTypeIds: [w.type.id] });
    await w.create();
    await w.create();
    expect(await w.create({ termType: undefined })).toMatchObject({
      signingCount: 3,
      termType: 'indefinite',
      endDate: null,
    });
  });

  it.each([true, false])('CT-R17 离职重聘累计开关 %s', async (accumulateRehire) => {
    const w = await contractWorld(testDb().db, `ctrehire${accumulateRehire}`);
    await w.create();
    await w.settings({ accumulateRehire });
    let employee = await w.session.getEmployee(w.employee.id);
    await w.session.business(
      employee.id,
      {
        kind: 'leave',
        mode: 'direct',
        effectiveDate: '2026-10-01',
        lastWorkDate: '2026-09-30',
        fields: {},
      },
      employee.revision,
    );
    employee = await w.session.getEmployee(w.employee.id);
    await w.session.business(
      employee.id,
      {
        kind: 'rehire',
        mode: 'direct',
        effectiveDate: '2026-10-01',
        fields: { departmentId: w.org.id },
      },
      employee.revision,
    );
    const contract = await w.create({ effectiveDate: '2026-10-01', endDate: '2027-09-30' });
    expect(contract.signingCount).toBe(accumulateRehire ? 2 : 1);
  });

  it('范围在分页前过滤，自定义字段按字段权限裁剪，撤权后原命令重放也拒绝', async () => {
    const w = await contractWorld(testDb().db, 'ctfield');
    const definition = await w.session.request('POST', '/custom-fields', {
      ifMatch: 0,
      body: { name: '合同自定义备注', objectType: 'contract', valueType: 'text' },
    });
    expect(definition.status).toBe(201);
    const field = (await definition.json()) as { id: string };
    const original = await w.create({ customFields: { [field.id]: '受限值' } });
    let permitted = true;
    const authorize: Authorizer = (request) =>
      request.action !== 'data.scope.all' &&
      !(request.action === 'object.update' && request.fields?.includes('probationSalary'));
    registerScopeProvider(authorize, {
      scope: async () => ({
        ...EMPTY_SCOPE,
        personIds: permitted ? [w.employee.id] : [],
        hasDataPermission: permitted,
        terms: [{ dimension: 'management', orgIds: [w.org.id], personIds: permitted ? [w.employee.id] : [] }],
      }),
      authorize: async (request) => Boolean(await authorize(request)),
      fields: async () => new Set(['id', 'number', 'revision']),
    });
    const api = tenantApi(w.db, { authorize, clock: () => new Date('2026-10-01T01:00:00Z') });
    const identity = { tenant: w.session.tenant.id, user: w.session.user.id };
    const list = await api.request('GET', '/api/tenant/contracts?pageSize=1', identity);
    expect(await list.json()).toMatchObject({ items: [{ id: original.id }] });
    const detail = await api.request('GET', `/api/tenant/contracts/records/${original.id}`, identity);
    const value = (await detail.json()) as Record<string, unknown>;
    expect(value.customFields).toEqual({});
    expect(JSON.stringify(value)).not.toContain('受限值');
    expect(Object.keys(value).sort()).toEqual(['customFields', 'id', 'number', 'revision']);
    const denied = await api.request('POST', '/api/tenant/contracts/commands', {
      ...identity,
      ifMatch: 1,
      body: {
        operation: 'change',
        mode: 'direct',
        employeeId: w.employee.id,
        targetId: original.id,
        fields: { probationSalary: '100.00' },
      },
    });
    expect(denied.status).toBe(403);
    const command = {
      ...identity,
      ifMatch: 1,
      idempotencyKey: 'scope-replay',
      body: {
        operation: 'terminate',
        mode: 'direct',
        employeeId: w.employee.id,
        targetId: original.id,
        fields: { actualTerminationDate: '2026-09-30' },
      },
    };
    expect((await api.request('POST', '/api/tenant/contracts/commands', command)).status).toBe(201);
    permitted = false;
    expect((await api.request('POST', '/api/tenant/contracts/commands', command)).status).toBe(404);
  });
});
