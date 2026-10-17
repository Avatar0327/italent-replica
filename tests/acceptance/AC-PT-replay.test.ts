/**
 * BE-7 PT-2 AC-PT-replay 框架（docs/08_设计/R2-T05_兼职设计.md §7.3A 第 2 层，表 B P-19）：统一结果复核链
 * `authorizeEmploymentResult` 认得兼职足迹——兼职记录 / 兼职申请两类审计对象都被采集；兼职申请 ID 能在当前目标里找到
 * （部门：新增取申请最新版本，延长 / 结束取目标记录当前部门）；创建人按兼职口径（申请发起人 / 直接新增的操作人）；
 * 离职 / 调动联动结束按 DEC-177 可见口径复核（同 DEC-178），其余兼职动作按写入口径。
 * PT-2 没有兼职入口，这里在租户事务里经 auditEmployment 写足迹后直接调复核；PB-64～70 的 HTTP 重放随各入口批次补。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS, PART_TIME_AUDIT_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { auditEmployment } from '../../apps/api/src/modules/employment/context.js';
import type { EmploymentContext } from '../../apps/api/src/modules/employment/types.js';
import { authorizeEmploymentResult } from '../../apps/api/src/modules/permission/employment-replay.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { partTimeWorld, type PartTimeWorld } from './AC-PT-support.js';
import { orgScope, revocable } from './support/revocable-rights.js';

const database = useTestDb();
const TODAY = '2026-10-01';
const OBJECT = MODULE_OBJECTS.employmentRecord.code;

interface Footprint {
  readonly action: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly after?: unknown;
}

/** 一条命令：经 auditEmployment 写足迹（同事务审计 + outbox），再按 scope 复核；返回 undefined 或错误码。 */
async function replay(w: PartTimeWorld, scope: ModuleScope, footprints: readonly Footprint[], body: unknown = {}) {
  const { authorize } = revocable();
  const base = w.context();
  const ctx: EmploymentContext = { ...base, objectCode: OBJECT, scope };
  try {
    await withTenant(w.db, w.tenantId, async (tx) => {
      for (const step of footprints)
        await auditEmployment(tx, ctx, step.action, step.objectType, step.objectId, null, step.after ?? {}, undefined, {
          note: 'pt-replay',
        });
      await authorizeEmploymentResult(tx, ctx, authorize, base.commandId!, body);
    });
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

const record = (objectId: string, action = 'employment.part_time.edit') => ({
  action,
  objectType: PART_TIME_AUDIT_OBJECTS.record,
  objectId,
});
const request = (objectId: string, action = 'part_time.request.update') => ({
  action,
  objectType: PART_TIME_AUDIT_OBJECTS.request,
  objectId,
});

describe('AC-PT-replay §7.3A 统一结果复核链认得兼职足迹', () => {
  it('兼职记录足迹：兼职部门在范围内放行；只管主职部门的写入口径 404；范围为空 404', async () => {
    const w = await partTimeWorld(database().db, 'replay-record');
    const id = await w.seedPartTime();
    expect(await replay(w, orgScope(w.tenantId, TODAY, w.partTimeOrg.id), [record(id)])).toBeUndefined();
    expect(await replay(w, orgScope(w.tenantId, TODAY, w.primaryOrg.id), [record(id)])).toBe('NOT_FOUND');
    expect(await replay(w, EMPTY_SCOPE, [record(id)])).toBe('NOT_FOUND');
  });

  it('离职 / 调动联动结束按 DEC-177 可见口径：员工当前主职在范围内即放行（同 DEC-178）', async () => {
    const w = await partTimeWorld(database().db, 'replay-linked');
    const id = await w.seedPartTime();
    const primaryOnly = orgScope(w.tenantId, TODAY, w.primaryOrg.id);
    for (const action of ['employment.part_time.ended_by_exit', 'employment.part_time.ended_by_transfer'])
      expect(await replay(w, primaryOnly, [record(id, action)]), action).toBeUndefined();
    const elsewhere = await w.org(`他处部门-${w.tenantId}`, { establishedOn: '2024-01-01' });
    expect(
      await replay(w, orgScope(w.tenantId, TODAY, elsewhere.id), [record(id, 'employment.part_time.ended_by_exit')]),
    ).toBe('NOT_FOUND');
    // 同一命令里该记录另有直接写入，就按写入口径
    expect(await replay(w, primaryOnly, [record(id, 'employment.part_time.ended_by_exit'), record(id)])).toBe(
      'NOT_FOUND',
    );
  });

  it('兼职申请：新增按申请最新版本部门、延长 / 结束按目标记录当前部门，响应快照里的申请 ID 能找到', async () => {
    const w = await partTimeWorld(database().db, 'replay-request');
    const add = await w.seedRequest();
    const recordId = await w.seedPartTime();
    const extend = await w.seedRequest({ requestType: 'extend', recordId, departmentId: w.primaryOrg.id });
    const inScope = orgScope(w.tenantId, TODAY, w.partTimeOrg.id);
    const outScope = orgScope(w.tenantId, TODAY, w.primaryOrg.id);
    const snapshot = (id: string) => ({ id, employeeId: w.employeeId, fields: { departmentId: w.partTimeOrg.id } });
    expect(await replay(w, inScope, [request(add)], snapshot(add))).toBeUndefined();
    expect(await replay(w, inScope, [], { items: [snapshot(add)] })).toBeUndefined();
    expect(await replay(w, outScope, [request(add)])).toBe('NOT_FOUND');
    // 延长申请版本里写的是主职部门，复核按目标兼职记录当前部门（兼职部门）判
    expect(await replay(w, inScope, [request(extend)])).toBeUndefined();
    expect(await replay(w, outScope, [request(extend)])).toBe('NOT_FOUND');
    // 快照与申请的员工不一致 → 404
    expect(
      await replay(w, inScope, [], { id: add, employeeId: randomUUID(), fields: { departmentId: w.partTimeOrg.id } }),
    ).toBe('NOT_FOUND');
  });

  it('“使用用户”维度：兼职申请按发起人、兼职记录按直接新增的操作人判', async () => {
    const w = await partTimeWorld(database().db, 'replay-creator');
    const mine = await w.seedRequest();
    const theirs = await w.seedRequest({ initiatorUserId: randomUUID() });
    const recordId = await w.seedPartTime();
    const usingUser: ModuleScope = {
      ...EMPTY_SCOPE,
      hasDataPermission: true,
      terms: [{ dimension: 'using_user', orgIds: [], personIds: [], creatorId: w.user.id }],
    };
    expect(await replay(w, usingUser, [request(mine)])).toBeUndefined();
    expect(await replay(w, usingUser, [request(theirs)])).toBe('NOT_FOUND');
    // 记录没有 employment.part_time.create 创建人 → 404；同一命令先写 create（本人）再改 → 放行
    expect(await replay(w, usingUser, [record(recordId)])).toBe('NOT_FOUND');
    expect(
      await replay(w, usingUser, [record(recordId, 'employment.part_time.create'), record(recordId)]),
    ).toBeUndefined();
  });

  it('兼职足迹进同一事务的 outbox：申请（不在业务头表）归属员工取 scope.employeeId（§7.4 P-44）', async () => {
    const w = await partTimeWorld(database().db, 'replay-outbox');
    const add = await w.seedRequest();
    const recordId = await w.seedPartTime();
    const ctx = w.context();
    await withTenant(w.db, w.tenantId, async (tx) => {
      await auditEmployment(
        tx,
        ctx,
        'part_time.request.create',
        PART_TIME_AUDIT_OBJECTS.request,
        add,
        null,
        {},
        undefined,
        undefined,
        {
          employeeId: w.employeeId,
          orgId: w.partTimeOrg.id,
        },
      );
      await auditEmployment(
        tx,
        ctx,
        'employment.part_time.create',
        PART_TIME_AUDIT_OBJECTS.record,
        recordId,
        null,
        {},
        undefined,
        undefined,
        {
          employeeId: w.employeeId,
          orgId: w.partTimeOrg.id,
        },
      );
    });
    const rows = await withTenant(w.db, w.tenantId, async (tx) =>
      rowsOf<{ object_id: string; employee_id: string | null; business_id: string | null; org: string | null }>(
        await tx.execute(sql`SELECT o.object_id, o.employee_id, o.business_id,
            (SELECT a.scope_org_id FROM audit_events a WHERE a.tenant_id=o.tenant_id AND a.command_id=o.command_id
              AND a.object_id=o.object_id::text) AS org
          FROM employment_outbox o WHERE o.tenant_id=${w.tenantId} AND o.command_id=${ctx.commandId}
          ORDER BY o.object_type`),
      ),
    );
    expect(rows).toEqual([
      { object_id: recordId, employee_id: w.employeeId, business_id: recordId, org: w.partTimeOrg.id },
      { object_id: add, employee_id: w.employeeId, business_id: null, org: w.partTimeOrg.id },
    ]);
  });
});
