/**
 * R3-T05 A3 / AC-SC-02：设计 §5.4、DEC-343 的明确部分先红测。
 * DEC-440：离职改期不在 A3 实现范围；事后更正见 F-096。
 */
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { rowsOf } from './support/f048.js';
import { tenantApi } from './support/tenant-api.js';
import { OPEN_END, type SuccessionWorld, successionWorld } from './AC-SC-support.js';

const testDb = useTestDb();
const leaveDate = '2026-10-02';
// DEC-440：改期口径见 F-096；本文件保留其他 A3 断言。

describe('AC-SC-02 离职事件与继任记录（DEC-343）', () => {
  let w: SuccessionWorld;
  let std: Awaited<ReturnType<SuccessionWorld['standard']>>;
  let seq = 0;

  beforeAll(async () => {
    w = await successionWorld(testDb().db, 'sc-exit');
    std = await w.standard();
  });

  const successor = () => w.hire(`离职继任者${++seq}`, { departmentId: std.orgB.id });
  const seed = (employeeId: string, type: 'org' | 'position') =>
    w.insertRecord({
      type,
      targetId: type === 'org' ? std.orgA.id : std.keyPosition.id,
      successorId: employeeId,
      startDate: '2026-10-01',
    });
  const state = async (id: string) =>
    rowsOf<{
      end_date: string;
      end_source: string | null;
      end_reason: string | null;
      exit_record_id: string | null;
      revision: number;
    }>(
      await w.asTenant((tx) =>
        tx.execute(sql`SELECT end_date::text, end_source, end_reason, exit_record_id, revision
          FROM succession_records WHERE id = ${id}::uuid`),
      ),
    )[0]!;

  it.each([
    ['生效当天', '2026-10-02T01:00:00Z', leaveDate],
    ['生效之前', '2026-10-01T01:00:00Z', OPEN_END],
    ['生效之后补办', '2026-10-03T01:00:00Z', leaveDate],
  ])('职位继任：%s办理离职，结束日期按离职生效日', async (_label, now, expectedEnd) => {
    w.setNow('2026-10-01T01:00:00Z');
    const employee = await successor();
    const id = await seed(employee.id, 'position');
    w.setNow(now);
    const leave = await w.business(
      employee.id,
      { kind: 'leave', mode: 'direct', lastWorkDate: '2026-10-01' },
      employee.revision,
    );
    expect(leave.effectiveDate).toBe(leaveDate);
    expect(await state(id)).toMatchObject(
      expectedEnd === OPEN_END
        ? { end_date: OPEN_END, end_source: null, revision: 1 }
        : {
            end_date: leaveDate,
            end_source: 'exit',
            end_reason: '离职',
            exit_record_id: leave.id,
            revision: 2,
          },
    );
  });

  it('组织继任：当天离职事件不立即结束，留给夜间 exit_sweep', async () => {
    w.setNow('2026-10-01T01:00:00Z');
    const employee = await successor();
    const id = await seed(employee.id, 'org');
    const before = await state(id);
    w.setNow('2026-10-02T01:00:00Z');
    await w.business(employee.id, { kind: 'leave', mode: 'direct', lastWorkDate: '2026-10-01' }, employee.revision);
    expect(await state(id)).toEqual(before);
  });

  it('未来离职保存即登记台账，不能依赖到期再次发钩子', async () => {
    w.setNow('2026-10-01T01:00:00Z');
    const employee = await successor();
    await seed(employee.id, 'position');
    await w.business(employee.id, { kind: 'leave', mode: 'direct', lastWorkDate: '2026-10-01' }, employee.revision);
    const tables = rowsOf<{ n: number }>(
      await w.asTenant((tx) =>
        tx.execute(sql`SELECT count(*)::int AS n FROM pg_class
          WHERE relname = 'succession_exit_applications' AND relkind = 'r'`),
      ),
    );
    expect(tables[0]!.n).toBe(1);
    const applications = rowsOf<{ employee_id: string; leave_date: string }>(
      await w.asTenant((tx) =>
        tx.execute(sql`SELECT employee_id, leave_date::text FROM succession_exit_applications
          WHERE tenant_id = ${w.tenant.id}::uuid AND employee_id = ${employee.id}::uuid`),
      ),
    );
    expect(applications).toEqual([{ employee_id: employee.id, leave_date: leaveDate }]);
  });

  it('离职事件后才新增的继任记录：到离职日仍生效，列表和详情提示 successorLeft', async () => {
    w.setNow('2026-10-01T01:00:00Z');
    const employee = await successor();
    await w.business(employee.id, { kind: 'leave', mode: 'direct', lastWorkDate: '2026-10-01' }, employee.revision);
    const created = await w.request('POST', '/records', {
      body: {
        successionType: 'position',
        targetPositionId: std.keyPosition.id,
        successorEmployeeId: employee.id,
        startDate: '2026-10-01',
      },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const api = tenantApi(w.db, { clock: () => new Date('2026-10-02T01:00:00Z') });
    const as = { user: w.user.id, tenant: w.tenant.id };
    const detail = await api.request('GET', `/api/tenant/succession/records/${id}`, as);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ id, status: 'active', successorLeft: true });
    const list = await api.request('GET', '/api/tenant/succession/records', as);
    expect(list.status).toBe(200);
    const { items } = (await list.json()) as { items: { id: string; successorLeft?: boolean }[] };
    expect(items.find((item) => item.id === id)).toMatchObject({ id, successorLeft: true });
    expect((await state(id)).end_date).toBe(OPEN_END);
  });
});
