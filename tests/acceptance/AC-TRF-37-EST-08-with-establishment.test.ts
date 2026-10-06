import { useTestDb } from '@italent/testkit';
import { sql, withTenant } from '@italent/db';
import { describe, expect, it } from 'vitest';
import { carriedWorld } from './AC-TRF-37-EST-08-support.js';
import { rowsOf } from '../../apps/api/src/modules/establishment/store.js';

const database = useTestDb();
describe('AC-TRF-37 / AC-EST-08 DEC-181 保存即调编', () => {
  it.each([true, false])('匹配细分=%s，未来调动保存即增减，组织总量始终平衡', async (matched) => {
    const w = await carriedWorld(database().db, `carried-${matched}`, { matched });
    const person = await w.hired();
    const response = await w.save(person);
    expect(response.status, await response.clone().text()).toBe(201);
    const business = (await response.json()) as { id: string };
    const [source, target] = await w.capacities();
    expect(source).toMatchObject({
      localCapacity: 2,
      reservedLocal: matched ? 1 : 0,
      subdivisions: [{ positionId: w.sourcePosition, localCapacity: matched ? 1 : 2 }],
    });
    expect(target).toMatchObject({
      localCapacity: 1,
      reservedLocal: 0,
      subdivisions: [{ positionId: w.targetPosition, localCapacity: 1 }],
    });
    for (const record of [source!, target!])
      expect(record.localCapacity).toBe(
        record.reservedLocal + record.subdivisions.reduce((n, p) => n + (p.localCapacity ?? 0), 0),
      );
    const events = await w.history();
    expect(events).toHaveLength(2);
    expect(events.every((event) => JSON.stringify(event.after).includes(business.id))).toBe(true);
    const outbox = await withTenant(w.db, w.session.tenant.id, async (tx) =>
      rowsOf(
        await tx.execute(sql`
      SELECT id FROM establishment_outbox WHERE tenant_id=${w.session.tenant.id}
        AND event_type LIKE 'establishment.transfer.%'`),
      ),
    );
    expect(outbox).toHaveLength(2);
  });

  it('AC-EST-09 无匹配细分且预留为零：整单拒绝，容量、业务及调整历史均不变', async () => {
    const w = await carriedWorld(database().db, 'carried-no-reserve', { matched: false, reserve: 0 });
    const person = await w.hired();
    const before = await w.capacities();
    const response = await w.save(person);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { details: { reason: 'ESTABLISHMENT_RESERVE_INSUFFICIENT' } },
    });
    expect(await w.capacities()).toEqual(before);
    expect(await w.history()).toEqual([]);
    expect((await w.session.records(person.employee.id, '2026-10-05')).map((r) => r.id)).toEqual([person.hire.id]);
  });

  it('AC-EST-10 增加一份编制后仍超编：严格控编拒绝且同事务回滚', async () => {
    const w = await carriedWorld(database().db, 'carried-strict');
    const occupant = await w.session.employee('合成已有超编员工');
    await w.session.business(
      occupant.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { departmentId: w.to.id, positionId: w.targetPosition },
      },
      occupant.revision,
    );
    const person = await w.hired();
    const before = await w.capacities();
    const response = await w.save(person);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'ESTABLISHMENT_EXCEEDED' } } });
    expect(await w.capacities()).toEqual(before);
    expect(await w.history()).toEqual([]);
  });

  it('AC-TRF-39 迟到执行按实际日落地，不重复增加保存时已转移的编制', async () => {
    const w = await carriedWorld(database().db, 'carried-late');
    const response = await w.save(await w.hired(), { mode: 'application', submit: true });
    expect(response.status, await response.clone().text()).toBe(201);
    const business = (await response.json()) as { id: string };
    await w.approve(business, '2026-10-02T01:00:00Z');
    const before = await w.capacities();
    expect(await w.runScheduler('2026-10-08T01:00:00Z')).toMatchObject({ activated: [business.id], failed: [] });
    expect(await w.business(business.id)).toMatchObject({ effectiveDate: '2026-10-08', status: 'effective' });
    expect(await w.capacities()).toEqual(before);
    expect(await w.history()).toHaveLength(2);
  });

  it('AC-EST-11 跨租户的目标组织和职位不可用于带编调动', async () => {
    const w = await carriedWorld(database().db, 'carried-tenant-a');
    const other = await carriedWorld(database().db, 'carried-tenant-b');
    const before = await other.capacities();
    const response = await w.save(await w.hired(), {
      fields: { departmentId: other.to.id, positionId: other.targetPosition },
    });
    expect([400, 403, 404]).toContain(response.status);
    expect(await other.capacities()).toEqual(before);
    expect(await w.history()).toEqual([]);
  });
});
