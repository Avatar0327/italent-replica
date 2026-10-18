/**
 * BE-7 PT-2 兼职审计归属与查看规则（docs/08_设计/R2-T05_兼职设计.md §7.4，表 B P-44 / P-45，§9 PB-71～75 规则部分）：
 * 兼职对象写审计时显式给出 { employeeId, orgId = 兼职部门 }（0058 推不出这两类对象的部门，不改 0058）；查看规则
 * = DEC-177 两项（记录部门 ∪ 员工当前主职部门）对 row.org 与“改部门前的旧部门”各判一次，外层 anchored。
 * 场景：主职在 A、兼职在 B，之后兼职从 B 改到 C；只管 B / A / C / D 的 HR 各看到什么。各入口批次补本批动作的 HTTP 版。
 */
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { sql, withTenant } from '@italent/db';
import { PART_TIME_AUDIT_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { auditEmployment } from '../../apps/api/src/modules/employment/context.js';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { auditApi } from './AC-AUD-support.js';
import { httpWorld, restricted } from './AC-PT-http-support.js';
import { partTimeWorld, type PartTimeWorld } from './AC-PT-support.js';
import { orgScope } from './support/revocable-rights.js';

const database = useTestDb();
const AT = '2026-10-01T01:00:00.000Z';
const RECORD = PART_TIME_AUDIT_OBJECTS.record;
const REQUEST = PART_TIME_AUDIT_OBJECTS.request;

let w: PartTimeWorld;
let recordId: string;
let requestId: string;
let orgC: string;
let orgD: string;

/** 只管 orgIds 的 HR（组织维度，人员按当前主职部门算），可看字段为 fields。 */
function viewer(orgIds: string[], fields = ['departmentId', 'place', 'endDate']) {
  const authorize: Authorizer = () => true;
  registerScopeProvider(authorize, {
    scope: async () => orgScope(w.tenantId, '2026-10-01', ...orgIds),
    authorize: async () => true,
    fields: async () => new Set(fields),
  });
  return auditApi(w.db, AT, { authorize });
}

const as = () => ({ tenant: w.tenantId, user: w.user.id });

async function seen(orgIds: string[]) {
  const audit = viewer(orgIds);
  const actions: string[] = [];
  for (const objectType of [RECORD, REQUEST]) {
    const page = await audit.dataChanges(as(), { objectType });
    actions.push(...page.items.map((row) => `${row.objectType}:${row.action}`));
  }
  return actions.sort();
}

beforeAll(async () => {
  w = await partTimeWorld(database().db, 'pt-audit');
  orgC = (await w.org(`兼职新部门${randomUUID()}`, { establishedOn: '2024-01-01' })).id;
  orgD = (await w.org(`无关部门${randomUUID()}`, { establishedOn: '2024-01-01' })).id;
  recordId = await w.seedPartTime({ place: '兼职地点' });
  requestId = await w.seedRequest();
  const B = w.partTimeOrg.id;
  const scope = (orgId: string) => ({ employeeId: w.employeeId, orgId });
  const ctx = w.context(0, AT);
  await withTenant(w.db, w.tenantId, async (tx) => {
    const write = (action: string, type: string, id: string, before: unknown, after: unknown, orgId: string) =>
      auditEmployment(tx, ctx, action, type, id, before, after, undefined, undefined, scope(orgId));
    await write(
      'employment.part_time.create',
      RECORD,
      recordId,
      null,
      { fields: { departmentId: B, place: '兼职地点' } },
      B,
    );
    await write('employment.part_time.end', RECORD, recordId, { endDate: null }, { endDate: '2026-12-31' }, B);
    await write(
      'employment.part_time.batch_end',
      RECORD,
      recordId,
      { endDate: '2026-12-31' },
      { endDate: '2026-11-30' },
      B,
    );
    await write(
      'employment.part_time.ended_by_exit',
      RECORD,
      recordId,
      { endDate: '2026-11-30' },
      { endDate: '2026-11-15' },
      B,
    );
    await write('part_time.request.create', REQUEST, requestId, null, { fields: { departmentId: B } }, B);
    // 改部门 B → C：新部门写 orgId，旧部门在 before 里
    await write(
      'employment.part_time.edit',
      RECORD,
      recordId,
      { fields: { departmentId: B } },
      { fields: { departmentId: orgC } },
      orgC,
    );
    await write(
      'employment.part_time.edit',
      RECORD,
      recordId,
      { fields: { place: '兼职地点' } },
      { fields: { place: '新地点' } },
      orgC,
    );
  });
});

describe('AC-PT-audit §7.4 兼职审计按员工 + 兼职部门归属', () => {
  it('写入时显式归属：scope_employee_id = 员工、scope_org_id = 兼职部门（0058 推不出的两类对象）', async () => {
    const rows = await withTenant(w.db, w.tenantId, async (tx) =>
      rowsOf<{ action: string; employee: string; org: string }>(
        await tx.execute(sql`SELECT action, scope_employee_id AS employee, scope_org_id AS org FROM audit_events
          WHERE tenant_id=${w.tenantId} AND object_type IN (${RECORD}, ${REQUEST}) ORDER BY occurred_at, id`),
      ),
    );
    expect(rows).toHaveLength(7);
    expect(new Set(rows.map((row) => row.employee))).toEqual(new Set([w.employeeId]));
    expect(rows.filter((row) => row.org === w.partTimeOrg.id)).toHaveLength(5);
    expect(rows.filter((row) => row.org === orgC).map((row) => row.action)).toEqual([
      'employment.part_time.edit',
      'employment.part_time.edit',
    ]);
    // 空范围看不到任何兼职日志（fail-closed）
    expect((await viewer([], []).dataChanges(as(), { objectType: RECORD })).items).toEqual([]);
  });

  it('PB-71 / PB-73：只管兼职部门 B 的 HR（主职在 A）看到 B 期间全部日志与“改部门”那条，看不到之后只在 C 的', async () => {
    expect(await seen([w.partTimeOrg.id])).toEqual(
      [
        `${RECORD}:employment.part_time.batch_end`,
        `${RECORD}:employment.part_time.create`,
        `${RECORD}:employment.part_time.edit`,
        `${RECORD}:employment.part_time.end`,
        `${RECORD}:employment.part_time.ended_by_exit`,
        `${REQUEST}:part_time.request.create`,
      ].sort(),
    );
  });

  it('PB-72：只管主职部门 A 的 HR 看到该员工全部兼职日志（DEC-177 ②，员工当前主职在 A）', async () => {
    expect(await seen([w.primaryOrg.id])).toHaveLength(7);
  });

  it('只管新部门 C 的 HR 只看到改部门及之后的两条；PB-74 只管无关部门 D 的什么都看不到', async () => {
    expect(await seen([orgC])).toEqual([`${RECORD}:employment.part_time.edit`, `${RECORD}:employment.part_time.edit`]);
    expect(await seen([orgD])).toEqual([]);
  });

  it('PB-75：兼职申请日志对兼职部门 HR 可见；详情字段按字段权限裁剪', async () => {
    const audit = viewer([w.partTimeOrg.id], ['departmentId']);
    const [created] = (await audit.dataChanges(as(), { objectType: RECORD, action: 'employment.part_time.create' }))
      .items;
    const detail = await audit.dataChange(as(), created!.id);
    expect(detail.after).toEqual({ fields: { departmentId: w.partTimeOrg.id } });
    const requests = await audit.dataChanges(as(), { objectType: REQUEST });
    expect(requests.items.map((row) => row.objectId)).toEqual([requestId]);
    expect(requests.items[0]).toMatchObject({ objectLabel: '兼职申请' });
  });
});

describe('AC-PT-audit PT-3b：经 HTTP 新增写出的审计归属与查看（PB-71 / PB-72 / PB-74 新增动作）', () => {
  it('新增写 employment.part_time.create：scope = 员工 + 兼职部门；B / A 的 HR 可见，无关部门 D 的什么都看不到', async () => {
    const h = await httpWorld(database().db, 'pt-audit-http');
    const created = await h.ok(await h.post(), 201);
    const rows = await withTenant(h.db, h.tenantId, async (tx) =>
      rowsOf<{ action: string; employee: string; org: string; object_type: string }>(
        await tx.execute(sql`SELECT action, object_type, scope_employee_id AS employee, scope_org_id AS org
          FROM audit_events WHERE tenant_id=${h.tenantId} AND object_id=${created.id}`),
      ),
    );
    expect(rows).toEqual([
      { action: 'employment.part_time.create', object_type: RECORD, employee: h.employeeId, org: h.partTimeOrg.id },
    ]);
    const unrelated = (await h.org(`无关部门${randomUUID()}`, { establishedOn: '2024-01-01' })).id;
    const as = { tenant: h.tenantId, user: h.user.id };
    const seenBy = async (...orgIds: string[]) => {
      const authorize = restricted({ scope: h.scopeOf(...orgIds), fields: ['departmentId', 'endDate'] });
      const page = await auditApi(h.db, AT, { authorize }).dataChanges(as, { objectType: RECORD });
      return page.items.map((row) => row.action);
    };
    expect(await seenBy(h.partTimeOrg.id)).toEqual(['employment.part_time.create']);
    expect(await seenBy(h.primaryOrg.id)).toEqual(['employment.part_time.create']);
    expect(await seenBy(unrelated)).toEqual([]);
  });

  it('outbox 同事务：employment.part_time.create 事件归属员工与底层业务头；不写 employment.record.create', async () => {
    const h = await httpWorld(database().db, 'pt-audit-http-outbox');
    const created = await h.ok(await h.post(), 201);
    const events = await withTenant(h.db, h.tenantId, async (tx) =>
      rowsOf<{ event_type: string; employee_id: string; business_id: string }>(
        await tx.execute(sql`SELECT event_type, employee_id, business_id FROM employment_outbox
          WHERE tenant_id=${h.tenantId} AND (object_id=${created.id}::uuid OR business_id=${created.id}::uuid)`),
      ),
    );
    expect(events).toEqual([
      { event_type: 'employment.part_time.create', employee_id: h.employeeId, business_id: created.id },
    ]);
  });
});
