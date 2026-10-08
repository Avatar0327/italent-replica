/**
 * PR #107 第 4 轮修改清单（DEC-297③，评论 6050983318；依据第 3 轮审查 6047548443）第二步的回归：
 * - R3-P2-2 同步冲突的审计按冲突员工当前的员工信息查看权与数据范围过滤（与业务冲突清单同一判定）；
 * - R3-P2-3 跨页回补只写操作人 360 人员范围内的人，范围外的不写入、不出现在回执里；
 * - R3-P2-4 回补先筛出真正待补的人员，按游标分页续跑，没补完不报结束（含前面 5,000 条不需要回补的大数据量用例）。
 * R3-P2-1（关系新增 / 导入的重放）见 AC-360-R4-replay.test.ts 的表驱动第四类。
 */
import { sql, withTenant } from '@italent/db';
import { survey360 } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { loginEmailOf } from './AC-EMP-support.js';
import { auditApi } from './AC-AUD-support.js';
import { fullAccess, type PersonView, world360, type World360 } from './AC-360-support.js';

const testDb = useTestDb();

interface SyncPage {
  created: { personId: string; employeeId: string }[];
  updated: { personId: string; employeeId: string }[];
  skipped: { employeeId: string; reason: string }[];
  nextCursor: string | null;
}

async function hire(w: World360, employee: { id: string; revision: number }, orgId: string, managerId?: string) {
  await w.session.business(
    employee.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2025-01-01',
      fields: { departmentId: orgId, ...(managerId ? { directManagerId: managerId } : {}) },
    },
    employee.revision,
  );
}

/** 按员工 ID 升序建员工（同步按员工 ID 分页，ID 小的先同步）。 */
async function employeesInOrder(w: World360, names: readonly string[]) {
  const list: Awaited<ReturnType<World360['session']['employee']>>[] = [];
  for (const name of names) list.push(await w.session.employee(name));
  return list.sort((x, y) => (x.id < y.id ? -1 : 1));
}

const sync = (w: World360, body: Record<string, unknown>, user?: string) =>
  w.ok<SyncPage>((user ? w.as(user) : w.request)('POST', '/people/sync', { body }));

describe('R3-P2-2 同步冲突审计按冲突员工当前的员工信息查看权与数据范围过滤', () => {
  async function conflictScene(label: string) {
    const access = fullAccess();
    const w = await world360(testDb().db, label, { access });
    const org = await w.session.org('冲突部门', { establishedOn: '2025-01-01' });
    const employee = await w.session.employee('冲突员工');
    await hire(w, employee, org.id);
    const external = await w.ok<PersonView>(
      w.request('POST', '/people', { ifMatch: 0, body: { name: '外部同邮箱', email: loginEmailOf(employee.id) } }),
      201,
    );
    await w.ok(w.request('POST', '/people/sync', { body: {} }));
    const audit = auditApi(testDb().db, '2026-10-01T02:00:00Z', { authorize: w.authorize });
    const as = { user: w.admin, tenant: w.tenantId };
    const conflictLogs = async () =>
      (await audit.dataChanges(as, { limit: '100' })).items.filter((i) => i.objectType === 'survey360-sync-conflict');
    // 基线：员工在范围内、有员工信息查看权时，冲突日志可见（含员工 ID 与候选人员 ID）
    const visible = await conflictLogs();
    expect(visible).toHaveLength(1);
    expect(JSON.stringify(await audit.dataChange(as, visible[0]!.id))).toContain(employee.id);
    return { access, w, employee, external, audit, as, conflictLogs, logId: visible[0]!.id };
  }

  it('撤空员工范围：业务冲突清单为空，审计列表与详情也看不到这条冲突日志', async () => {
    const s = await conflictScene('r4a');
    s.access.scope = EMPTY_SCOPE;
    expect((await s.w.ok<{ items: unknown[] }>(s.w.request('GET', '/people/sync-conflicts'))).items).toEqual([]);
    expect(await s.conflictLogs()).toEqual([]);
    const detail = await s.audit.get(`/data-changes/${s.logId}`, s.as);
    expect(detail.status).toBe(404);
    expect(await detail.text()).not.toContain(s.employee.id);
  });

  it('撤掉员工信息查看权：业务接口 403，审计列表与详情也看不到这条冲突日志', async () => {
    const s = await conflictScene('r4b');
    s.access.canView = false;
    expect((await s.w.request('GET', '/people/sync-conflicts')).status).toBe(403);
    expect(await s.conflictLogs()).toEqual([]);
    const detail = await s.audit.get(`/data-changes/${s.logId}`, s.as);
    expect(detail.status).toBe(404);
    expect(await detail.text()).not.toContain(s.external.id);
  });
});

describe('R3-P2-3 跨页回补只写操作人 360 人员范围内的人', () => {
  it('高级管理员（360 范围只含经理部门、员工范围全部）只同步经理所在末页：范围外的下属一个字段都不改，回执不列出', async () => {
    const w = await world360(testDb().db, 'r4c', { access: fullAccess() });
    const bossOrg = await w.session.org('经理部门', { establishedOn: '2025-01-01' });
    const subOrg = await w.session.org('下属部门', { establishedOn: '2025-01-01' });
    const [sub, boss] = await employeesInOrder(w, ['员工X', '员工Y']);
    await hire(w, boss!, bossOrg.id);
    await hire(w, sub!, subOrg.id, boss!.id);
    // 系统管理员先同步第一页（只有下属）：经理还没有 360 人员，下属上级为空；随后在 360 端人工改下属部门
    const page1 = await sync(w, { limit: 1 });
    expect(page1.created.map((c) => c.employeeId)).toEqual([sub!.id]);
    const subPersonId = page1.created[0]!.personId;
    const current = await w.ok<PersonView>(w.request('GET', `/people/${subPersonId}`));
    const edited = await w.ok<PersonView>(
      w.request('PUT', `/people/${subPersonId}`, { ifMatch: current.revision, body: { department: '人工部门' } }),
    );
    const advanced = await w.member('高级管理员');
    await w.appoint(advanced, 'advanced');
    const mou = await w.ok<{ id: string }>(
      w.enterprise('POST', '/mous', {
        ifMatch: 0,
        body: { code: 'mou-r4c', name: '经理部门', orgRanges: [{ orgId: bossOrg.id, includeDescendants: true }] },
      }),
      201,
    );
    await w.ok(
      w.enterprise('PUT', `/scopes/${advanced}/${survey360.SURVEY360_APP}`, {
        ifMatch: 0,
        body: { kind: 'mou', mouId: mou.id },
      }),
    );
    const settings = await w.ok<{ revision: number }>(w.request('GET', '/settings'));
    await w.ok(w.request('PUT', '/settings', { ifMatch: settings.revision, body: { finePermission: true } }));
    expect((await w.as(advanced)('GET', `/people/${subPersonId}`)).status).toBe(404);

    const page2 = await sync(w, { limit: 1, after: page1.nextCursor }, advanced);
    expect(page2.created.map((c) => c.employeeId)).toEqual([boss!.id]);
    expect(page2.nextCursor).toBeNull();
    expect(JSON.stringify(page2)).not.toContain(sub!.id);
    expect(JSON.stringify(page2)).not.toContain(subPersonId);
    // 范围外的下属：上级仍为空、revision 不变、人工部门保留
    expect(await w.ok<PersonView>(w.request('GET', `/people/${subPersonId}`))).toEqual(edited);
  });
});

describe('R3-P2-4 回补先筛真正待补的人员，按游标分页续跑，没补完不报结束', () => {
  it('前面放 5,000 条上级为空、但不需要回补的挂接人员：经理所在末页之后，下属照样回补', async () => {
    const w = await world360(testDb().db, 'r4d');
    const org = await w.session.org('大数据量部门', { establishedOn: '2025-01-01' });
    const [sub, boss] = await employeesInOrder(w, ['员工A', '员工B']);
    await hire(w, boss!, org.id);
    await hire(w, sub!, org.id, boss!.id);
    const page1 = await sync(w, { limit: 1 });
    expect(page1.created.map((c) => c.employeeId)).toEqual([sub!.id]);
    // 5,000 名员工 ID 排在下属之前、没有任职记录（因而没有直线经理）的挂接人员：上级为空，但都不需要回补
    const bulkId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    expect(bulkId(5000) < sub!.id).toBe(true);
    await withTenant(w.db, w.tenantId, async (tx) => {
      await tx.execute(sql`INSERT INTO employment_employees (id, tenant_id, code, name)
        SELECT ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, ${w.tenantId}::uuid,
          'BULK-' || g, '批量员工' || g FROM generate_series(1, 5000) g`);
      await tx.execute(sql`INSERT INTO survey360_people (tenant_id, name, email, employee_id, email_locked, source,
          created_by)
        SELECT ${w.tenantId}::uuid, '批量员工' || g, 'bulk-' || g || '@example.com',
          ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, true, 'org_sync', ${w.admin}::uuid
        FROM generate_series(1, 5000) g`);
    });

    const page2 = await sync(w, { limit: 1, after: page1.nextCursor });
    expect(page2.created.map((c) => c.employeeId)).toEqual([boss!.id]);
    expect(page2.updated.map((u) => u.employeeId)).toEqual([sub!.id]);
    expect(page2.nextCursor).toBeNull();
    const subPerson = await w.ok<PersonView>(w.request('GET', `/people/${page1.created[0]!.personId}`));
    expect(subPerson.superiorPersonId).toBe(page2.created[0]!.personId);
  }, 120_000);

  it('回补总量超过一页：limit = 1 时经理末页之后按游标逐页续跑，每页最多回补一人，补完之前不报结束', async () => {
    const w = await world360(testDb().db, 'r4e');
    const org = await w.session.org('多页回补部门', { establishedOn: '2025-01-01' });
    const ordered = await employeesInOrder(w, ['员工一', '员工二', '员工三', '员工四']);
    const boss = ordered.at(-1)!;
    const subs = ordered.slice(0, 3);
    await hire(w, boss, org.id);
    for (const sub of subs) await hire(w, sub, org.id, boss.id);

    const pages: SyncPage[] = [];
    let after: string | null = null;
    for (let i = 0; i < 20; i += 1) {
      const page: SyncPage = await sync(w, { limit: 1, ...(after ? { after } : {}) });
      pages.push(page);
      if (page.nextCursor === null) break;
      after = page.nextCursor;
    }
    expect(pages.at(-1)!.nextCursor).toBeNull();
    const bossPage = pages.findIndex((p) => p.created.some((c) => c.employeeId === boss.id));
    expect(bossPage).toBeGreaterThanOrEqual(0);
    // 经理所在的末页之后还有待补的下属：不报结束
    expect(pages[bossPage]!.nextCursor).not.toBeNull();
    for (const page of pages) expect(page.updated.length).toBeLessThanOrEqual(1);
    const backfilled = pages.flatMap((p) => p.updated.map((u) => u.employeeId));
    expect([...backfilled].sort()).toEqual(subs.map((s) => s.id).sort());
    const bossPerson = pages[bossPage]!.created.find((c) => c.employeeId === boss.id)!.personId;
    const created = pages.flatMap((p) => p.created);
    for (const sub of subs) {
      const personId = created.find((c) => c.employeeId === sub.id)!.personId;
      expect((await w.ok<PersonView>(w.request('GET', `/people/${personId}`))).superiorPersonId).toBe(bossPerson);
    }
  });
});
