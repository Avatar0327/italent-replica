/**
 * F-206 已取消入职返回取消说明（后端读字段；DEC-560，issue #376，docs/02_业务建模/34 EN-R9）：
 * 四视图每项带 cancelRemark = 本条记录最近一次 cancel 动作日志的 remark，没取消过 / 没填说明为 null；
 * 改期恢复换新记录 ID，新记录不继承旧说明；子查询带 tenant_id，不会取到别的租户的动作日志。
 * 详情：前端详情由通用 /businesses /records /employees 拼成，没有待入职专用详情接口，不新建（见 PR 描述）。
 */
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { listEntryView } from '../../apps/api/src/modules/employment/entry-views.js';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { addPending, entryAction, entryWorld, type EntryWorld } from './AC-EN-BE2a-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

interface Item {
  readonly id: string;
  readonly name: string;
  readonly cancelRemark: string | null;
}

async function view(w: EntryWorld, name: string): Promise<Item[]> {
  const response = await w.session.request('GET', `/pending-entries?view=${name}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: Item[] }).items;
}

async function cancel(w: EntryWorld, recordId: string, body: object = {}) {
  const response = await entryAction(w, recordId, 'cancel', body);
  expect(response.status, await response.clone().text()).toBe(200);
}

/** 改期恢复：已取消 → 延期，换新记录 ID。 */
async function restore(w: EntryWorld, recordId: string, effectiveDate: string): Promise<string> {
  const response = await entryAction(w, recordId, 'postpone', { effectiveDate });
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { record: { id: string } }).record.id;
}

describe('F-206(DEC-560) 取消说明读字段', () => {
  it('取消带说明：已取消视图读到该说明；未取消的记录为 null', async () => {
    const w = await entryWorld(testDb().db, 'f206-remark');
    const cancelled = await addPending(w, '2026-10-10', '取消说明员工');
    const normal = await addPending(w, '2026-10-11', '正常待入职员工');
    await cancel(w, cancelled.recordId, { reason: 'personal', remark: '候选人另有安排' });
    expect(await view(w, 'cancelled')).toMatchObject([{ id: cancelled.recordId, cancelRemark: '候选人另有安排' }]);
    expect(await view(w, 'all')).toMatchObject([{ id: normal.recordId, cancelRemark: null }]);
  });

  it('取消不带说明：cancelRemark 为 null（原站显示 --）', async () => {
    const w = await entryWorld(testDb().db, 'f206-no-remark');
    const { recordId } = await addPending(w);
    await cancel(w, recordId, { reason: 'growth' });
    expect(await view(w, 'cancelled')).toMatchObject([{ id: recordId, cancelRemark: null }]);
  });

  it('取消 → 改期恢复 → 再次取消：新记录不继承旧说明，只读到新说明', async () => {
    const w = await entryWorld(testDb().db, 'f206-restore');
    const { recordId } = await addPending(w);
    await cancel(w, recordId, { remark: '第一次说明' });
    const restored = await restore(w, recordId, '2026-10-20');
    expect(restored).not.toBe(recordId);
    expect(await view(w, 'cancelled')).toEqual([]);
    expect(await view(w, 'all')).toMatchObject([{ id: restored, cancelRemark: null }]);
    await cancel(w, restored, { remark: '第二次说明' });
    expect(await view(w, 'cancelled')).toMatchObject([{ id: restored, cancelRemark: '第二次说明' }]);
  });

  it('同一记录有多条取消动作时取最近一次', async () => {
    const w = await entryWorld(testDb().db, 'f206-latest');
    const { employee, recordId } = await addPending(w);
    await cancel(w, recordId, { remark: '最近一次说明' });
    await insertCancelAction(w.session.tenant.id, employee.id, recordId, '2026-09-01T00:00:00Z', '更早的说明');
    expect(await view(w, 'cancelled')).toMatchObject([{ id: recordId, cancelRemark: '最近一次说明' }]);
  });

  it('跨租户：另一租户的取消记录与说明不会出现在本租户结果里', async () => {
    const db = testDb().db;
    const a = await entryWorld(db, 'f206-tenant-a');
    const b = await entryWorld(db, 'f206-tenant-b');
    const own = await addPending(a);
    await cancel(a, own.recordId, { remark: '本租户说明' });
    const baseline = await view(a, 'cancelled');
    expect(baseline).toMatchObject([{ id: own.recordId, cancelRemark: '本租户说明' }]);
    const other = await addPending(b);
    await cancel(b, other.recordId, { remark: '外租户说明' });
    const after = await view(a, 'cancelled');
    expect(after).toEqual(baseline);
    expect(JSON.stringify(after)).not.toContain('外租户说明');
  });

  it('跨租户纵深防御：动作日志即使带着本租户记录的业务 ID，别的租户的行也不被取到', async () => {
    // 业务 ID 全局唯一（主键）+ 组合外键，正常数据里造不出这种行；为证明租户条件写在 SQL 里而不是靠约束 / RLS 兜底，
    // 在这个文件独占的测试库里拆掉动作日志的外键并关掉该表的行级安全，再直接查
    const db = testDb().db;
    const a = await entryWorld(db, 'f206-depth-a');
    const b = await entryWorld(db, 'f206-depth-b');
    const { recordId } = await addPending(a);
    await cancel(a, recordId, { remark: '本租户说明' });
    const outsider = await b.session.employee('外租户员工');
    await db.execute(sql`ALTER TABLE employment_entry_actions DROP CONSTRAINT employment_entry_actions_business_fk`);
    await db.execute(sql`ALTER TABLE employment_entry_actions DISABLE ROW LEVEL SECURITY`);
    await insertCancelAction(b.session.tenant.id, outsider.id, recordId, '2026-12-01T00:00:00Z', '外租户说明');
    const items = await withTenant(db, a.session.tenant.id, (tx) =>
      listEntryView(
        tx,
        a.session.tenant.id,
        { view: 'cancelled', today: '2026-10-01', page: { limit: 50, offset: 0 } },
        undefined,
      ),
    );
    expect(items).toMatchObject([{ id: recordId, cancelRemark: '本租户说明' }]);
  });
});

async function insertCancelAction(
  tenantId: string,
  employeeId: string,
  businessId: string,
  at: string,
  remark: string,
) {
  await withTenant(testDb().db, tenantId, (tx) =>
    tx.execute(sql`INSERT INTO employment_entry_actions(tenant_id, employee_id, business_id, action, reason_code,
        remark, command_id, actor_user_id, created_at)
      VALUES (${tenantId}, ${employeeId}::uuid, ${businessId}::uuid, 'cancel', 'other', ${remark},
        ${randomUUID()}, ${randomUUID()}::uuid, ${at}::timestamptz)`),
  );
}

describe('F-206(DEC-560) 取消说明随行可见：数据范围反向', () => {
  async function cancelledAs(w: EntryWorld, orgIds: readonly string[]): Promise<Item[]> {
    const authorize: Authorizer = () => true;
    registerScopeProvider(authorize, {
      scope: async () => ({
        ...EMPTY_SCOPE,
        orgIds,
        hasDataPermission: orgIds.length > 0,
        terms: orgIds.length ? [{ dimension: 'organization' as const, orgIds, personIds: [] }] : [],
      }),
      authorize: async () => true,
      fields: async () => new Set(['id', 'employeeId', 'kind', 'effectiveDate', 'revision', 'departmentId']),
    });
    const api = tenantApi(w.db, { authorize, clock: () => new Date('2026-10-01T01:00:00.000Z') });
    const response = await api.request('GET', '/api/tenant/employment/pending-entries?view=cancelled', {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { items: Item[] }).items;
  }

  it('范围内看到说明；范围外 / 范围为空看不到该行，也读不到说明', async () => {
    const w = await entryWorld(testDb().db, 'f206-scope');
    const other = await w.session.org(`另一部门-${randomUUID()}`, { establishedOn: '2026-01-01' });
    const { recordId } = await addPending(w);
    await cancel(w, recordId, { remark: '范围测试说明' });
    expect(await cancelledAs(w, [w.org.id])).toMatchObject([{ id: recordId, cancelRemark: '范围测试说明' }]);
    expect(await cancelledAs(w, [other.id])).toEqual([]);
    expect(await cancelledAs(w, [])).toEqual([]);
  });
});
