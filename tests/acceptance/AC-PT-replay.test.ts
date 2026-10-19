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
import { denyButton, httpWorld } from './AC-PT-http-support.js';
import { requestWorld } from './AC-PT-request-support.js';
import { partTimeWorld, type PartTimeWorld } from './AC-PT-support.js';
import { orgScope, revocable } from './support/revocable-rights.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const TODAY = '2026-10-01';
const OBJECT = MODULE_OBJECTS.employmentRecord.code;

type Footprint = readonly [action: string, objectType: string, objectId: string];

/** 一条命令：经 auditEmployment 写足迹（同事务审计 + outbox），再按 scope 复核；返回 undefined 或错误码。 */
async function replay(w: PartTimeWorld, scope: ModuleScope, footprints: readonly Footprint[], body: unknown = {}) {
  const { authorize } = revocable();
  const base = w.context();
  const ctx: EmploymentContext = { ...base, objectCode: OBJECT, scope };
  try {
    await withTenant(w.db, w.tenantId, async (tx) => {
      for (const [action, type, id] of footprints) await auditEmployment(tx, ctx, action, type, id, null, {});
      await authorizeEmploymentResult(tx, ctx, authorize, base.commandId!, body);
    });
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

const record = (id: string, action = 'employment.part_time.edit'): Footprint => [
  action,
  PART_TIME_AUDIT_OBJECTS.record,
  id,
];
const request = (id: string): Footprint => ['part_time.request.update', PART_TIME_AUDIT_OBJECTS.request, id];

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
    const scope = { employeeId: w.employeeId, orgId: w.partTimeOrg.id };
    await withTenant(w.db, w.tenantId, async (tx) => {
      for (const [action, type, id] of [record(recordId, 'employment.part_time.create'), request(add)])
        await auditEmployment(tx, ctx, action, type, id, null, {}, undefined, undefined, scope);
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

describe('AC-PT-replay PT-3b：直接新增兼职的命令重放（PB-64～69）', () => {
  async function replayWorld(label: string) {
    const w = await httpWorld(database().db, label);
    const { authorize, rights } = revocable();
    const send = w.as(authorize);
    const call = (key: string, patch: Record<string, unknown> = {}) =>
      send('POST', `/employees/${w.employeeId}/part-times`, { idempotencyKey: key, body: w.body(patch) });
    return { w, rights, call };
  }
  const refused = (status: number) => status === 403 || status === 404;

  it('PB-64 / PB-65：首次执行 201 且足迹含 employment-part-time；同键同内容重放返回原响应，不再写入', async () => {
    const { w, call } = await replayWorld('replay-http-first');
    const key = randomUUID();
    const first = await call(key);
    const created = await w.ok(first, 201);
    const footprint = await withTenant(w.db, w.tenantId, async (tx) =>
      rowsOf<{ object_type: string }>(
        await tx.execute(sql`SELECT object_type FROM audit_events WHERE tenant_id=${w.tenantId}
          AND object_id=${created.id} AND action='employment.part_time.create'`),
      ),
    );
    expect(footprint).toEqual([{ object_type: PART_TIME_AUDIT_OBJECTS.record }]);
    const before = await w.writes();
    const again = await call(key);
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual(created);
    expect(await w.writes()).toEqual(before);
  });

  it('PB-66：首次业务失败（兼职部门自开始日后停用）后同键回查返回同一失败，不写入', async () => {
    const { w, call } = await replayWorld('replay-http-failed');
    const disabled = await w.disableOrg(w.partTimeOrg, '2026-09-10');
    expect(disabled.status).toBe(200);
    const key = randomUUID();
    const before = await w.writes();
    const first = await w.refusal(await call(key));
    expect(first).toMatchObject({ status: 400, reason: 'EMPLOYMENT_DEPARTMENT_DISABLED' });
    const again = await w.refusal(await call(key));
    expect(again).toEqual(first);
    expect(await w.writes()).toEqual(before);
  });

  it.each([
    [
      'PB-67 撤掉兼职部门范围（只剩主职部门）',
      404,
      (x: Awaited<ReturnType<typeof replayWorld>>) => {
        x.rights.scope = orgScope(x.w.tenantId, TODAY, x.w.primaryOrg.id);
      },
    ],
    [
      'PB-67 数据范围收为空',
      404,
      (x: Awaited<ReturnType<typeof replayWorld>>) => {
        x.rights.emptyScope = true;
      },
    ],
    [
      'PB-68 撤掉 Employment.PartTime 按钮',
      403,
      (x: Awaited<ReturnType<typeof replayWorld>>) => {
        x.rights.deny = denyButton('Employment.PartTime');
      },
    ],
  ] as const)('%s：同键重放被拒（%s），不返回台账里的原响应，业务与审计不变', async (_name, status, revoke) => {
    const x = await replayWorld(`replay-http-revoked-${status}`);
    const key = randomUUID();
    const created = await x.w.ok(await x.call(key), 201);
    const before = await x.w.writes();
    revoke(x);
    const replay = await x.call(key);
    expect(replay.status).toBe(status);
    expect(JSON.stringify(await replay.json())).not.toContain(created.id);
    expect(await x.w.writes()).toEqual(before);
  });

  it('PB-69：首次成功后他人把该兼职改到操作人范围外的部门，同键重放按当前部门判 → 404', async () => {
    const x = await replayWorld('replay-http-moved');
    const key = randomUUID();
    const created = await x.w.ok(await x.call(key), 201);
    const elsewhere = await x.w.org(`被改去的部门${uniqueSuffix()}`, { establishedOn: '2024-01-01' });
    await x.w.moveSnapshot(created.id, elsewhere.id);
    x.rights.scope = orgScope(x.w.tenantId, TODAY, x.w.primaryOrg.id, x.w.partTimeOrg.id);
    const replay = await x.call(key);
    expect(refused(replay.status)).toBe(true);
    expect(replay.status).toBe(404);
  });
});

describe('AC-PT-replay PT-3c：编辑兼职与批量结束的命令重放（PB-56 / PB-64～69 同口径）', () => {
  async function replayWorld(label: string) {
    const w = await httpWorld(database().db, label);
    const record = await w.make({ endDate: '2026-10-31' });
    const { authorize, rights } = revocable();
    const send = w.as(authorize);
    const edit = (key: string, endDate = '2026-10-15') =>
      send('PATCH', `/part-times/${record.id}`, { ifMatch: 1, idempotencyKey: key, body: { endDate } });
    const batch = (key: string, endDate = '2026-10-15') =>
      send('POST', '/part-times/batch-end', {
        idempotencyKey: key,
        body: { items: [{ recordId: record.id, revision: 1 }], endDate },
      });
    return { w, record, rights, calls: { edit, batch } };
  }
  const entries = ['edit', 'batch'] as const;
  const button = { edit: 'Employment.PartTimeEdit', batch: 'Employment.PartTimeBatchEnd' };

  it.each(entries)('%s：首次 200 且足迹含 employment-part-time；同键同内容重放返回原响应，不再写入', async (entry) => {
    const { w, record, calls } = await replayWorld(`replay-${entry}-first`);
    const key = randomUUID();
    const first = await calls[entry](key);
    expect(first.status, await first.clone().text()).toBe(200);
    const created = await first.json();
    const footprint = await withTenant(w.db, w.tenantId, async (tx) =>
      rowsOf<{ object_type: string }>(
        await tx.execute(sql`SELECT DISTINCT object_type FROM audit_events WHERE tenant_id=${w.tenantId}
          AND object_id=${record.id} AND action IN ('employment.part_time.end', 'employment.part_time.batch_end')`),
      ),
    );
    expect(footprint).toEqual([{ object_type: PART_TIME_AUDIT_OBJECTS.record }]);
    const before = await w.writes();
    const again = await calls[entry](key);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(created);
    expect(await w.writes()).toEqual(before);
  });

  it('编辑：首次业务失败（部门自结束日后停用）后同键回查返回同一失败，不写入', async () => {
    const { w, calls } = await replayWorld('replay-edit-failed');
    expect((await w.disableOrg(w.partTimeOrg, '2026-11-10')).status).toBe(200);
    const key = randomUUID();
    const before = await w.writes();
    const first = await w.refusal(await calls.edit(key, '2026-11-30'));
    expect(first).toMatchObject({ status: 400, reason: 'EMPLOYMENT_DEPARTMENT_DISABLED' });
    expect(await w.refusal(await calls.edit(key, '2026-11-30'))).toEqual(first);
    expect(await w.writes()).toEqual(before);
  });

  it('批量结束：首次业务失败（新结束日晚于当前）后同键回查返回同一失败，不写入', async () => {
    const { w, calls } = await replayWorld('replay-batch-failed');
    const key = randomUUID();
    const before = await w.writes();
    const first = await w.refusal(await calls.batch(key, '2027-01-31'));
    expect(first).toMatchObject({ status: 409, reason: 'PART_TIME_END_AFTER_CURRENT' });
    expect(await w.refusal(await calls.batch(key, '2027-01-31'))).toEqual(first);
    expect(await w.writes()).toEqual(before);
  });

  it.each(entries)(
    '%s：撤掉兼职部门范围 / 范围收为空 → 同键重放 404；撤按钮 → 403；不返回原响应，业务与审计不变',
    async (entry) => {
      for (const [name, status, revoke] of [
        [
          '范围只剩主职部门',
          404,
          (x: Awaited<ReturnType<typeof replayWorld>>) => {
            x.rights.scope = orgScope(x.w.tenantId, TODAY, x.w.primaryOrg.id);
          },
        ],
        [
          '范围收为空',
          404,
          (x: Awaited<ReturnType<typeof replayWorld>>) => {
            x.rights.emptyScope = true;
          },
        ],
        [
          '撤按钮',
          403,
          (x: Awaited<ReturnType<typeof replayWorld>>) => {
            x.rights.deny = denyButton(button[entry]);
          },
        ],
      ] as const) {
        const x = await replayWorld(`replay-${entry}-revoked-${status}-${name}`);
        const key = randomUUID();
        const done = await x.calls[entry](key);
        expect(done.status, name).toBe(200);
        const before = await x.w.writes();
        revoke(x);
        const replay = await x.calls[entry](key);
        expect(replay.status, name).toBe(status);
        expect(JSON.stringify(await replay.json()), name).not.toContain(x.record.id);
        expect(await x.w.writes(), name).toEqual(before);
      }
    },
  );

  it.each(entries)('%s：首次成功后他人把该兼职改到操作人范围外的部门，同键重放按当前部门判 → 404', async (entry) => {
    const x = await replayWorld(`replay-${entry}-moved`);
    const key = randomUUID();
    expect((await x.calls[entry](key)).status).toBe(200);
    const elsewhere = await x.w.org(`被改去的部门${uniqueSuffix()}`, { establishedOn: '2024-01-01' });
    await x.w.moveSnapshot(x.record.id, elsewhere.id);
    x.rights.scope = orgScope(x.w.tenantId, TODAY, x.w.primaryOrg.id, x.w.partTimeOrg.id);
    expect((await x.calls[entry](key)).status).toBe(404);
  });
});

describe('AC-PT-replay PT-4b：新增兼职申请的命令重放（PB-70，PB-56 / PB-64～69 同口径）', () => {
  async function replayWorld(label: string) {
    const w = await requestWorld(database().db, `pt4b-replay-${label}`);
    const { authorize, rights } = revocable();
    const api = w.http(w.sendWith(authorize));
    const create = (key: string, patch: Record<string, unknown> = {}) => api.create(patch, { idempotencyKey: key });
    const submit = (key: string, id: string, revision: number) =>
      api.act(id, 'submit', revision, { idempotencyKey: key });
    return { w, rights, create, submit };
  }

  it('PB-70：首次 201（申请 ID 能被 currentTargets 找到，足迹含 part-time-request）；同键同内容重放返回原响应，不再写入', async () => {
    const { w, create } = await replayWorld('first');
    const key = randomUUID();
    const created = await w.ok(await create(key), 201);
    const footprint = await withTenant(w.db, w.tenant.id, async (tx) =>
      rowsOf<{ object_type: string }>(
        await tx.execute(sql`SELECT DISTINCT object_type FROM audit_events WHERE tenant_id=${w.tenant.id}
          AND object_id=${created.id} AND action='part_time.request.create'`),
      ),
    );
    expect(footprint).toEqual([{ object_type: PART_TIME_AUDIT_OBJECTS.request }]);
    const before = await w.writes();
    const again = await create(key);
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual(created);
    expect(await w.writes()).toEqual(before);
  });

  it('PB-70：提交的首次 / 重放同口径（命令内 guard 三个出口）；首次业务失败后同键回查返回同一失败，不写入', async () => {
    const { w, create, submit } = await replayWorld('submit');
    const created = await w.ok(await create(randomUUID()), 201);
    const key = randomUUID();
    const first = await w.ok(await submit(key, created.id, created.revision));
    expect(first.status).toBe('in_review');
    const before = await w.writes();
    const again = await submit(key, created.id, created.revision);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(first);
    expect(await w.writes()).toEqual(before);

    const failKey = randomUUID();
    const failed = await w.refusal(await create(failKey, { startDate: '2026-09-10', endDate: '2026-09-01' }));
    expect(failed).toMatchObject({ status: 400, reason: 'PART_TIME_END_BEFORE_START' });
    const mid = await w.writes();
    expect(await w.refusal(await create(failKey, { startDate: '2026-09-10', endDate: '2026-09-01' }))).toEqual(failed);
    expect(await w.writes()).toEqual(mid);
  });

  it.each([
    [
      '撤掉兼职部门范围（只剩主职部门）',
      404,
      (x: Awaited<ReturnType<typeof replayWorld>>) => {
        x.rights.scope = orgScope(x.w.tenant.id, TODAY, x.w.primary);
      },
    ],
    [
      '数据范围收为空',
      404,
      (x: Awaited<ReturnType<typeof replayWorld>>) => {
        x.rights.emptyScope = true;
      },
    ],
    [
      '撤掉 Employment.PartTimeApproval 按钮',
      403,
      (x: Awaited<ReturnType<typeof replayWorld>>) => {
        x.rights.deny = denyButton('Employment.PartTimeApproval');
      },
    ],
  ] as const)('%s：同键重放被拒（%s），不返回台账里的原响应，业务与审计不变', async (_name, status, revoke) => {
    const x = await replayWorld(`revoked-${status}`);
    const key = randomUUID();
    const created = await x.w.ok(await x.create(key), 201);
    const before = await x.w.writes();
    revoke(x);
    const replay = await x.create(key);
    expect(replay.status).toBe(status);
    expect(JSON.stringify(await replay.json())).not.toContain(created.id);
    expect(await x.w.writes()).toEqual(before);
  });

  it('提交的重放同样按当前授权重判：撤掉 Employment.Submit 后同键重放 403；他人把申请改到范围外部门后重放 404', async () => {
    const x = await replayWorld('submit-revoked');
    const created = await x.w.ok(await x.create(randomUUID()), 201);
    const key = randomUUID();
    await x.w.ok(await x.submit(key, created.id, created.revision));
    x.rights.deny = denyButton('Employment.Submit');
    expect((await x.submit(key, created.id, created.revision)).status).toBe(403);
    x.rights.deny = undefined;
    x.rights.scope = orgScope(x.w.tenant.id, TODAY, x.w.primary);
    expect((await x.submit(key, created.id, created.revision)).status).toBe(404);
  });
});
