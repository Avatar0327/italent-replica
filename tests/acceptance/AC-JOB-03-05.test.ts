/**
 * AC-JOB-03 / AC-JOB-05（F-006）：职务模块经真实人员数据端口（任职版本链）判定，全部走 HTTP 层。
 * - AC-JOB-03（DEC-016；DEC-074 接入后正式判定）：有在岗人员的职位禁止停用；
 * - AC-JOB-05（DEC-011、`19` §3.1、`07` A10 W-414～W-416、DEC-132）：职位变更时本次勾选「调整员工直线经理」，
 *   新上级职位在生效日恰好 1 人在岗 → 本职位每名在岗员工追加一条生效日的任职版本（业务类型 组织调整、
 *   变动类型 职位调整），原记录止于前一天；多人、无人、清空上级 → 不同步、不新增、不报错，职位照常保存。
 */
import { randomUUID } from 'node:crypto';
import { jobSettingsObjects, jobSettingsVersions, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../../apps/api/src/commands.js';
import { jobWriteContext } from './AC-JOB-personnel-support.js';
import { jobSession } from './AC-JOB-support.js';
import { orgPeopleWorld, resultRows, TODAY, type JobObject, type OrgPeopleWorld } from './AC-ORG-people-support.js';

const testDb = useTestDb();
const D = '2026-10-02';

async function managerScenario(label: string, managerCount: number, options: { alreadyNewManager?: boolean } = {}) {
  const world = await orgPeopleWorld(testDb().db, label);
  const org = await world.org('经理同步部门');
  const post = await world.job('posts', '经理同步职务');
  const position = (name: string, extra: Record<string, unknown> = {}) =>
    world.job('positions', name, { orgId: org.id, postId: post.id, ...extra });
  const oldParent = await position('原上级职位');
  const newParent = await position('新上级职位');
  const target = await position('员工职位', { parents: { admin: { parentId: oldParent.id } } });
  const oldManager = await world.hire('原经理', { departmentId: org.id, positionId: oldParent.id });
  const managers = [];
  for (let index = 0; index < managerCount; index++) {
    managers.push(await world.hire(`新上级在岗${index}`, { departmentId: org.id, positionId: newParent.id }));
  }
  const initialManager = options.alreadyNewManager ? managers[0]!.id : oldManager.id;
  const employees = [];
  for (const name of ['同步员工一', '同步员工二']) {
    employees.push(
      await world.hire(name, { departmentId: org.id, positionId: target.id, directManagerId: initialManager }),
    );
  }
  return { world, org, oldParent, newParent, target, oldManager, managers, employees, initialManager };
}

function changePosition(world: OrgPeopleWorld, target: JobObject, body: Record<string, unknown>, key?: string) {
  return world.call('PATCH', `job/positions/${target.id}`, {
    ifMatch: target.revision,
    body,
    ...(key ? { idempotencyKey: key } : {}),
  });
}

async function positionAt(world: OrgPeopleWorld, id: string, asOf: string) {
  const response = await world.call('GET', `job/positions/${id}?asOf=${asOf}`);
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

async function expectUnsynced(world: OrgPeopleWorld, employees: { id: string }[], managerId: string) {
  for (const employee of employees) {
    const records = await world.employmentRecords(employee.id, D);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'hire', isCurrent: true, fields: { directManagerId: managerId } });
  }
}

describe('AC-JOB-03 职位停用按真实在岗人员判定（DEC-016）', () => {
  it('职位在停用日有在岗人员时禁止停用，版本与 revision 不变', async () => {
    const { world, target } = await managerScenario('job03staffed', 0);
    const response = await changePosition(world, target, { enabled: false, effectiveDate: D });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'CONFLICT', details: { reason: 'POSITION_HAS_INCUMBENTS' } },
    });
    expect(await positionAt(world, target.id, D)).toMatchObject({ enabled: true, revision: 1 });
  });

  it('在岗人员已于停用日前离职、或职位本无人在岗时可以停用', async () => {
    const { world, newParent, oldParent, oldManager } = await managerScenario('job03empty', 0);
    const empty = await changePosition(world, newParent, { enabled: false, effectiveDate: D });
    expect(empty.status, await empty.clone().text()).toBe(200);
    expect(await positionAt(world, newParent.id, D)).toMatchObject({ enabled: false, revision: 2 });
    await world.business(oldManager.id, { kind: 'leave', mode: 'direct', lastWorkDate: TODAY }, oldManager.revision);
    const vacated = await changePosition(world, oldParent, { enabled: false, effectiveDate: D });
    expect(vacated.status, await vacated.clone().text()).toBe(200);
  });
});

describe('AC-JOB-05 职位变更时调整员工直线经理（真实人员端口）', () => {
  it('新上级恰好 1 人在岗：每名在岗员工追加组织调整 / 职位调整版本，原记录止于前一天，写审计与 outbox；重放不重复', async () => {
    const { db } = testDb();
    const s = await managerScenario('job05one', 1);
    const key = randomUUID();
    const body = {
      parents: { admin: { parentId: s.newParent.id } },
      effectiveDate: D,
      adjustEmployeeDirectManager: true,
    };
    const response = await changePosition(s.world, s.target, body, key);
    expect(response.status, await response.clone().text()).toBe(200);
    const saved = await response.json();
    expect(saved).toMatchObject({ revision: 2, directParentId: s.newParent.id, managerSync: { skipped: [] } });
    for (const employee of s.employees) {
      const records = await s.world.employmentRecords(employee.id, D);
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({
        id: employee.recordId,
        kind: 'hire',
        changeType: null,
        effectiveDate: TODAY,
        stopDate: TODAY,
        fields: { directManagerId: s.oldManager.id },
      });
      expect(records[1]).toMatchObject({
        kind: 'org_adjustment',
        changeType: 'position_adjustment',
        effectiveDate: D,
        isCurrent: true,
        fields: { directManagerId: s.managers[0]!.id, departmentId: s.org.id, positionId: s.target.id },
      });
    }
    const outbox = await withTenant(db, s.world.tenant.id, async (tx) =>
      resultRows<{ employeeId: string }>(
        await tx.execute(sql`SELECT employee_id AS "employeeId" FROM employment_outbox
          WHERE command_id = ${key} AND event_type = 'employment.record.create'`),
      ),
    );
    expect(outbox.map((row) => row.employeeId).sort()).toEqual(s.employees.map((employee) => employee.id).sort());
    const replay = await changePosition(s.world, s.target, body, key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(saved);
    for (const employee of s.employees) expect(await s.world.employmentRecords(employee.id, D)).toHaveLength(2);
  });

  it('未勾选本次「调整员工直线经理」（默认否）时不同步，职位照常保存', async () => {
    const s = await managerScenario('job05default', 1);
    const response = await changePosition(s.world, s.target, {
      parents: { admin: { parentId: s.newParent.id } },
      effectiveDate: D,
    });
    expect(response.status).toBe(200);
    const saved = (await response.json()) as Record<string, unknown>;
    expect(saved).toMatchObject({ revision: 2, directParentId: s.newParent.id });
    expect(saved).not.toHaveProperty('managerSync');
    await expectUnsynced(s.world, s.employees, s.oldManager.id);
  });

  it.each([
    ['新上级职位 2 人在岗', 2, false],
    ['新上级职位无人在岗（按原站说明推定）', 0, false],
    ['清空上级职位（按原站说明推定）', 1, true],
  ])('%s：勾选也不同步、不新增任职、不报错，职位变更照常保存', async (_case, count, clear) => {
    const s = await managerScenario(`job05skip${count}${clear ? 'clear' : ''}`, count);
    const parentId = clear ? null : s.newParent.id;
    const response = await changePosition(s.world, s.target, {
      parents: { admin: { parentId } },
      effectiveDate: D,
      adjustEmployeeDirectManager: true,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const saved = (await response.json()) as Record<string, unknown>;
    expect(saved).toMatchObject({ revision: 2, directParentId: parentId });
    expect(saved).not.toHaveProperty('managerSync');
    await expectUnsynced(s.world, s.employees, s.oldManager.id);
  });

  it('勾选但本次未改上级职位时选项不生效', async () => {
    const s = await managerScenario('job05sameparent', 1);
    const response = await changePosition(s.world, s.target, {
      name: '员工职位改名',
      effectiveDate: D,
      adjustEmployeeDirectManager: true,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ revision: 2, name: '员工职位改名' });
    await expectUnsynced(s.world, s.employees, s.oldManager.id);
  });

  it('DEC-132 员工直线经理本来就是新上级唯一在岗人时仍新增一条组织调整版本', async () => {
    const s = await managerScenario('job05samemanager', 1, { alreadyNewManager: true });
    const response = await changePosition(s.world, s.target, {
      parents: { admin: { parentId: s.newParent.id } },
      effectiveDate: D,
      adjustEmployeeDirectManager: true,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    for (const employee of s.employees) {
      const records = await s.world.employmentRecords(employee.id, D);
      expect(records).toHaveLength(2);
      expect(records[1]).toMatchObject({
        kind: 'org_adjustment',
        changeType: 'position_adjustment',
        fields: { directManagerId: s.managers[0]!.id },
      });
    }
  });

  it('只作用于生效日当天在本职位的员工：生效日前已离职的员工不追加', async () => {
    const s = await managerScenario('job05leaver', 1);
    const [leaver, stayer] = s.employees;
    await s.world.business(leaver!.id, { kind: 'leave', mode: 'direct', lastWorkDate: TODAY }, leaver!.revision);
    const response = await changePosition(s.world, s.target, {
      parents: { admin: { parentId: s.newParent.id } },
      effectiveDate: D,
      adjustEmployeeDirectManager: true,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await s.world.employmentRecords(leaver!.id, D)).map((record) => record.kind)).toEqual(['hire', 'leave']);
    expect((await s.world.employmentRecords(stayer!.id, D)).map((record) => record.kind)).toEqual([
      'hire',
      'org_adjustment',
    ]);
  });
});

describe('DEC-133 租户设置不再承载常驻开关', () => {
  it('升级前已成功的旧设置命令（开关为 true）按原幂等键重放仍返回首次结果，新命令照旧拒绝', async () => {
    const { db } = testDb();
    const session = await jobSession(db, 'job05legacyreplay');
    const legacyBody = { allowDuplicatePositionNames: false, adjustEmployeeDirectManager: true };
    const idempotencyKey = randomUUID();
    const ctx = { ...jobWriteContext(session, 0), commandId: idempotencyKey };
    // 模拟升级前版本：同一指纹（方法、路径、revision、请求体）已成功执行并写入命令台账。
    const legacy = await runCommand(db, ctx, {
      id: idempotencyKey,
      fingerprint: { method: 'PUT', path: '/api/tenant/job/settings', expectedRevision: 0, input: legacyBody },
      execute: async (tx) => {
        await tx.insert(jobSettingsObjects).values({ tenantId: ctx.tenantId, revision: 1, createdAt: ctx.now });
        const [version] = await tx
          .insert(jobSettingsVersions)
          .values({ tenantId: ctx.tenantId, versionNo: 1, startDate: '2026-10-01', ...legacyBody, createdAt: ctx.now })
          .returning();
        const body = {
          tenantId: ctx.tenantId,
          revision: 1,
          versionId: version!.id,
          startDate: '2026-10-01',
          stopDate: '9999-12-31',
          enabled: true,
          ...legacyBody,
        };
        return { status: 200 as const, body };
      },
    });
    const replay = await session.request('PUT', '/settings', { ifMatch: 0, idempotencyKey, body: legacyBody });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(legacy.body);
    const changed = await session.request('PUT', '/settings', {
      ifMatch: 0,
      idempotencyKey,
      body: { allowDuplicatePositionNames: true, adjustEmployeeDirectManager: true },
    });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    const fresh = await session.request('PUT', '/settings', { ifMatch: 1, body: legacyBody });
    expect(fresh.status).toBe(400);
    expect(await fresh.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    const current = await session.request('GET', '/settings');
    expect(await current.json()).toMatchObject({ revision: 1 });
  });

  it('设置只兼容 false 且读取不再返回；职位变更接口接受单次选项', async () => {
    const s = await managerScenario('job05http', 1);
    const settings = (body: Record<string, unknown>) => s.world.call('PUT', 'job/settings', { ifMatch: 0, body });
    const legacyOn = await settings({ allowDuplicatePositionNames: false, adjustEmployeeDirectManager: true });
    expect(legacyOn.status).toBe(400);
    expect(await legacyOn.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    const legacyOff = await settings({ allowDuplicatePositionNames: false, adjustEmployeeDirectManager: false });
    expect(legacyOff.status).toBe(200);
    expect(await legacyOff.json()).not.toHaveProperty('adjustEmployeeDirectManager');
    const option = await changePosition(s.world, s.target, {
      parents: { admin: { parentId: s.newParent.id } },
      effectiveDate: D,
      adjustEmployeeDirectManager: true,
    });
    expect(option.status, await option.clone().text()).toBe(200);
    expect(await option.json()).toMatchObject({ revision: 2, managerSync: { skipped: [] } });
  });
});
