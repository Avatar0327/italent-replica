import { randomUUID } from 'node:crypto';
import { withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  hasPositionIncumbents,
  readPositionIncumbents,
} from '../../apps/api/src/modules/employment/personnel-reader.js';
import { employmentSession, type Employee, type EmploymentBusiness, type EmploymentSession } from './AC-EMP-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

async function positionReferences(db: Db, session: EmploymentSession, label: string) {
  const org = await session.org(`${label}部门`, { establishedOn: '2026-01-01' });
  const api = tenantApi(db, { clock: () => new Date('2026-10-01T01:00:00.000Z') });
  const create = async (kind: string, extra: Record<string, unknown> = {}) => {
    const response = await api.request('POST', `/api/tenant/job/${kind}`, {
      user: session.user.id,
      tenant: session.tenant.id,
      ifMatch: 0,
      body: { name: `${label}${kind}`, code: `PORT_${randomUUID()}`, startDate: '2026-01-01', ...extra },
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string };
  };
  const post = await create('posts');
  const position = await create('positions', { orgId: org.id, postId: post.id });
  return { departmentId: org.id, postId: post.id, positionId: position.id };
}

describe('真实任职职位在岗读取端口契约', () => {
  it('按生效日读取真实在岗记录并分页，返回直接经理，离职生效后不再占岗', async () => {
    const { db } = testDb();
    const session = await employmentSession(db, 'empportpage');
    const fields = await positionReferences(db, session, '分页职位');
    const manager = await session.employee('合成直接经理');
    await session.business(
      manager.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { employType: 'internal' } },
      manager.revision,
    );
    const incumbents: { employee: Employee; hired: EmploymentBusiness }[] = [];
    for (let index = 0; index < 3; index++) {
      const employee = await session.employee(`分页在岗合成员工${index}`);
      const hired = await session.business(
        employee.id,
        {
          kind: 'hire',
          mode: 'direct',
          effectiveDate: '2026-09-01',
          fields: { employType: 'internal', ...fields, directManagerId: manager.id },
        },
        employee.revision,
      );
      incumbents.push({ employee, hired });
    }
    const leaver = incumbents[0]!;
    await session.business(
      leaver.employee.id,
      { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-30' },
      leaver.hired.employeeRevision,
    );

    await withTenant(db, session.tenant.id, async (tx) => {
      const query = { tenantId: session.tenant.id, positionId: fields.positionId, asOf: '2026-09-30' };
      const first = await readPositionIncumbents(tx, { ...query, limit: 2 });
      const second = await readPositionIncumbents(tx, { ...query, limit: 2, offset: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.hasMore).toBe(true);
      expect(second.items).toHaveLength(1);
      expect(second.hasMore).toBe(false);
      const all = [...first.items, ...second.items];
      expect(all.map((item) => item.employeeId)).toEqual(incumbents.map(({ employee }) => employee.id).sort());
      for (const { employee, hired } of incumbents)
        expect(all).toContainEqual({
          employeeId: employee.id,
          recordId: hired.record!.id,
          staffId: hired.record!.staffId,
          directManagerId: manager.id,
        });
      expect(await hasPositionIncumbents(tx, query)).toBe(true);
      expect(await hasPositionIncumbents(tx, { ...query, asOf: '2026-08-31' })).toBe(false);

      const afterLeave = await readPositionIncumbents(tx, { ...query, asOf: '2026-10-01' });
      expect(afterLeave.items.map((item) => item.employeeId)).toEqual(
        incumbents
          .slice(1)
          .map(({ employee }) => employee.id)
          .sort(),
      );
      expect(afterLeave.hasMore).toBe(false);
    });
  });

  it('租户事务和查询租户双重隔离，外租户职位在岗记录不会通过读端口泄露', async () => {
    const { db } = testDb();
    const own = await employmentSession(db, 'empportown');
    const foreign = await employmentSession(db, 'empportforeign');
    const ownFields = await positionReferences(db, own, '本租户职位');
    const foreignFields = await positionReferences(db, foreign, '外租户职位');
    const ownEmployee = await own.employee('本租户在岗合成员工');
    const foreignEmployee = await foreign.employee('外租户在岗合成员工');
    for (const { session, employee, fields } of [
      { session: own, employee: ownEmployee, fields: ownFields },
      { session: foreign, employee: foreignEmployee, fields: foreignFields },
    ])
      await session.business(
        employee.id,
        { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { employType: 'internal', ...fields } },
        employee.revision,
      );

    const foreignQuery = { tenantId: foreign.tenant.id, positionId: foreignFields.positionId, asOf: '2026-10-01' };
    const ownQuery = { tenantId: own.tenant.id, positionId: ownFields.positionId, asOf: '2026-10-01' };
    await withTenant(db, own.tenant.id, async (tx) => {
      expect((await readPositionIncumbents(tx, ownQuery)).items.map((item) => item.employeeId)).toEqual([
        ownEmployee.id,
      ]);
      for (const query of [foreignQuery, { ...ownQuery, positionId: foreignFields.positionId }]) {
        expect(await readPositionIncumbents(tx, query)).toEqual({ items: [], hasMore: false });
        expect(await hasPositionIncumbents(tx, query)).toBe(false);
      }
    });
    await withTenant(db, foreign.tenant.id, async (tx) => {
      expect((await readPositionIncumbents(tx, foreignQuery)).items.map((item) => item.employeeId)).toEqual([
        foreignEmployee.id,
      ]);
      expect(await hasPositionIncumbents(tx, foreignQuery)).toBe(true);
      expect(await readPositionIncumbents(tx, ownQuery)).toEqual({ items: [], hasMore: false });
    });
  });
});
