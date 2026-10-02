import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  hasPositionIncumbents,
  readPositionIncumbents,
} from '../../apps/api/src/modules/employment/personnel-reader.js';
import { findCurrentRecord } from '../../apps/api/src/modules/employment/read-model.js';
import type { EmploymentBusiness } from '../../apps/api/src/modules/employment/types.js';
import { customField } from './AC-EMP-inheritance-support.js';
import { employmentSession, type Employee } from './AC-EMP-support.js';
import { forwardFixture, forwardJobApi } from './AC-FWD-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

describe('AC-FWD 最新快照读模型及预览隔离', () => {
  it('最新payload明确清空字段时，单条、列表、当前与业务读取均返回null，变更前动态取最新上一条', async () => {
    const { db } = testDb();
    const { session, employee, hired } = await forwardFixture(db, 'fwd-read-null');
    const custom = await customField(session);
    const baseline = await session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-09-05',
        customFields: { [custom.id]: '原自定义值' },
      },
      hired.employeeRevision,
    );
    const later = await session.business(
      employee.id,
      {
        kind: 'regularization',
        mode: 'direct',
        effectiveDate: '2026-09-20',
      },
      baseline.employeeRevision,
    );
    const source = await session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-09-10',
        fields: { place: null },
        customFields: { [custom.id]: null },
      },
      later.employeeRevision,
    );
    const record = await session.record(later.id);
    const listed = (await session.records(employee.id)).find((item) => item.id === later.id);
    const current = await withTenant(db, session.tenant.id, (tx) =>
      findCurrentRecord(tx, session.tenant.id, employee.id, '2026-10-01'),
    );
    const businessResponse = await session.request('GET', `/businesses/${later.id}`);
    expect(businessResponse.status).toBe(200);
    const business = (await businessResponse.json()) as EmploymentBusiness;
    for (const result of [record, listed, current, business.record]) {
      expect(result).toMatchObject({
        id: later.id,
        fields: { place: null },
        customFields: { [custom.id]: null },
        previousRecordId: source.id,
        before: { fields: { place: null }, customFields: { [custom.id]: null } },
      });
    }
    expect(business.fields.place).toBeNull();
    expect(business.customFields[custom.id]).toBeNull();
    const historyEdit = await session.request('PATCH', `/records/${source.id}`, {
      ifMatch: source.revision,
      body: { fields: { place: '历史记录最新值' }, customFields: { [custom.id]: '历史最新自定义值' } },
    });
    expect(historyEdit.status).toBe(200);
    expect(await session.record(later.id)).toMatchObject({
      fields: { place: null },
      customFields: { [custom.id]: null },
      before: { fields: { place: '历史记录最新值' }, customFields: { [custom.id]: '历史最新自定义值' } },
    });
  });

  it('向后更新职位A到B后在岗查询从A移出、B读入，经理及其清空均使用最新快照', async () => {
    const { db } = testDb();
    const { session, employee, org, hired } = await forwardFixture(db, 'fwd-read-position');
    const jobs = forwardJobApi(db, session);
    const post = await jobs.create('posts');
    const oldPosition = await jobs.create('positions', { orgId: org.id, postId: post.id });
    const newPosition = await jobs.create('positions', { orgId: org.id, postId: post.id });
    const managers: Employee[] = [];
    for (const name of ['原合成经理', '新合成经理']) {
      const manager = await session.employee(name);
      await session.business(
        manager.id,
        {
          kind: 'hire',
          mode: 'direct',
          effectiveDate: '2026-01-01',
          fields: { employType: 'internal' },
        },
        manager.revision,
      );
      managers.push(manager);
    }
    const baseline = await session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-09-05',
        fields: { positionId: oldPosition.id, postId: post.id, directManagerId: managers[0]!.id },
      },
      hired.employeeRevision,
    );
    const later = await session.business(
      employee.id,
      {
        kind: 'regularization',
        mode: 'direct',
        effectiveDate: '2026-09-20',
      },
      baseline.employeeRevision,
    );
    await session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-09-10',
        fields: { positionId: newPosition.id, directManagerId: managers[1]!.id },
      },
      later.employeeRevision,
    );
    const query = { tenantId: session.tenant.id, asOf: '2026-10-01' };
    await withTenant(db, session.tenant.id, async (tx) => {
      expect(await readPositionIncumbents(tx, { ...query, positionId: oldPosition.id })).toEqual({
        items: [],
        hasMore: false,
      });
      expect(await hasPositionIncumbents(tx, { ...query, positionId: oldPosition.id })).toBe(false);
      expect(await hasPositionIncumbents(tx, { ...query, positionId: newPosition.id })).toBe(true);
      expect((await readPositionIncumbents(tx, { ...query, positionId: newPosition.id })).items).toEqual([
        {
          employeeId: employee.id,
          recordId: later.id,
          staffId: hired.record!.staffId,
          directManagerId: managers[1]!.id,
        },
      ]);
    });
    const currentBusiness = await session.request('GET', `/businesses/${later.id}`);
    const current = (await currentBusiness.json()) as EmploymentBusiness;
    const cleared = await session.request('PATCH', `/records/${later.id}`, {
      ifMatch: current.revision,
      body: { fields: { directManagerId: null } },
    });
    expect(cleared.status).toBe(200);
    await withTenant(db, session.tenant.id, async (tx) => {
      expect((await readPositionIncumbents(tx, { ...query, positionId: newPosition.id })).items[0]).toMatchObject({
        directManagerId: null,
      });
    });
  });

  it('JobNumber 经核心传播code→null→主档code，任意不同工号仍被主档约束拒绝', async () => {
    const { session, employee, hired } = await forwardFixture(testDb().db, 'fwd-read-job-number');
    const future = await session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-11-01',
      },
      hired.employeeRevision,
    );
    const cleared = await session.request('PATCH', `/records/${hired.id}`, {
      ifMatch: hired.revision,
      body: { fields: { jobNumber: null } },
    });
    expect(cleared.status).toBe(200);
    const clearedBusiness = (await cleared.json()) as EmploymentBusiness;
    expect((await session.record(future.id)).fields.jobNumber).toBeNull();
    const invalid = await session.request('PATCH', `/records/${hired.id}`, {
      ifMatch: clearedBusiness.revision,
      body: { fields: { jobNumber: 'SYNTHETIC_INVALID_CODE' } },
    });
    expect(invalid.status).toBe(400);
    expect((await session.record(future.id)).fields.jobNumber).toBeNull();
    const restored = await session.request('PATCH', `/records/${hired.id}`, {
      ifMatch: clearedBusiness.revision,
      body: { fields: { jobNumber: employee.code } },
    });
    expect(restored.status).toBe(200);
    expect((await session.record(future.id)).fields.jobNumber).toBe(employee.code);
    expect((await session.getEmployee(employee.id)).code).toBe(employee.code);
  });

  it('预览不能读取外租户员工或越过本租户员工范围，错误不含记录与字段值', async () => {
    const { db } = testDb();
    const { session, employee, hired } = await forwardFixture(db, 'fwd-preview-scope');
    const later = await session.business(
      employee.id,
      {
        kind: 'regularization',
        mode: 'direct',
        effectiveDate: '2026-09-20',
      },
      hired.employeeRevision,
    );
    const foreign = await employmentSession(db, 'fwd-preview-foreign');
    const body = { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-10', fields: { place: '新地点' } };
    const crossTenant = await foreign.request('POST', `/employees/${employee.id}/forward-update-preview`, { body });
    expect(crossTenant.status).toBe(404);
    const checked: { action: string; resource?: string }[] = [];
    const restricted = tenantApi(db, {
      clock: () => new Date('2026-10-01T01:00:00.000Z'),
      authorize: (request) => {
        checked.push(request);
        return request.resource !== employee.id;
      },
    });
    const outOfScope = await restricted.request(
      'POST',
      `/api/tenant/employment/employees/${employee.id}/forward-update-preview`,
      {
        tenant: session.tenant.id,
        user: session.user.id,
        body,
      },
    );
    expect(outOfScope.status).toBe(403);
    expect(checked).toContainEqual(
      expect.objectContaining({
        action: 'tenant.employment.read',
        resource: employee.id,
      }),
    );
    for (const response of [crossTenant, outOfScope]) {
      const error = JSON.stringify(await response.json());
      expect(error).not.toContain(later.id);
      expect(error).not.toContain('原地点');
    }
  });
});
