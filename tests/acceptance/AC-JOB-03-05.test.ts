import { randomUUID } from 'node:crypto';
import { type Db, jobSettingsObjects, jobSettingsVersions, type Tx } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { runCommand } from '../../apps/api/src/commands.js';
import {
  assignmentVersions,
  installJobPersonnelFixture,
  jobWriteContext,
  loadJobWriteService,
  personnelFixtureGateway,
  seedIncumbent,
  type JobPersonnelGateway,
  type JobWriteContext,
} from './AC-JOB-personnel-support.js';
import { jobSession, type JobRecord } from './AC-JOB-support.js';

const testDb = useTestDb();
beforeAll(async () => installJobPersonnelFixture(testDb().db));

describe('AC-JOB-03/05 职位停用与职位变更时调整员工直线经理', () => {
  it('AC-JOB-03 默认人员数据端口未接入时返回 503，客户端不能自报无人而停用', async () => {
    const session = await jobSession(testDb().db, 'job03default');
    const org = await session.org('人员数据未知部门');
    const post = await session.create('posts', '人员数据未知职务');
    const position = await session.create('positions', '人员数据未知职位', { orgId: org.id, postId: post.id });
    const response = await session.request('PATCH', `/positions/${position.id}`, {
      ifMatch: position.revision,
      body: { enabled: false, effectiveDate: '2026-10-02' },
    });
    expect(response.status).toBe(503);
    expect(await session.detail('positions', position.id, '2026-10-02')).toMatchObject({
      enabled: true,
      revision: 1,
    });
  });

  it('AC-JOB-03 可信端口在写事务内读到在岗人员，拒绝停用且版本不增加', async () => {
    const { db } = testDb();
    const session = await jobSession(db, 'job03staffed');
    const org = await session.org('有人部门');
    const post = await session.create('posts', '有人职务');
    const position = await session.create('positions', '有人职位', { orgId: org.id, postId: post.id });
    await seedIncumbent(db, session, position.id);
    const service = await loadJobWriteService();
    const observed: Tx[] = [];
    const gateway = personnelFixtureGateway(observed);
    const ctx = jobWriteContext(session, position.revision);
    let writeTransaction: Tx | undefined;
    await expect(
      runCommand(db, ctx, {
        id: ctx.commandId,
        fingerprint: { action: 'test-position-disable', id: position.id },
        execute: async (tx, commandId) => {
          writeTransaction = tx;
          const body = await service.updateJobObject(
            tx,
            { ...ctx, commandId },
            'positions',
            position.id,
            { enabled: false, effectiveDate: '2026-10-02' },
            gateway,
          );
          return { status: 200, body };
        },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'POSITION_HAS_INCUMBENTS' } });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toBe(writeTransaction);
    expect(await session.detail('positions', position.id, '2026-10-02')).toMatchObject({ enabled: true, revision: 1 });
  });

  it('AC-JOB-05 本次勾选且新上级职位恰好 1 人在岗：每个在岗员工新增 D 生效的组织调整版本，重放不再追加', async () => {
    const { db, session, newParent, position, oldManager, employees, managers } = await managerScenario('job05one', 1);
    const observed: Tx[] = [];
    const ctx = jobWriteContext(session, position.revision);
    let writeTransaction: Tx | undefined;
    const command = positionChange(ctx, position.id, {
      parents: { admin: { parentId: newParent.id } },
      effectiveDate: '2026-10-02',
      adjustEmployeeDirectManager: true,
    });
    const saved = await runPositionChange(db, ctx, command, personnelFixtureGateway(observed), (tx) => {
      writeTransaction = tx;
    });
    expect(saved).toMatchObject({ revision: 2, directParentId: newParent.id, managerSync: { skipped: [] } });
    for (const employee of employees) {
      const history = await assignmentVersions(db, session.tenant.id, employee.assignmentId);
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({
        revision: 1,
        directManagerId: oldManager.employeeId,
        effectiveDate: '2026-10-01',
        businessKind: null,
        changeType: null,
      });
      expect(history[1]).toMatchObject({
        revision: 2,
        directManagerId: managers[0]!.employeeId,
        effectiveDate: '2026-10-02',
        businessKind: 'org_adjustment',
        changeType: 'position_adjustment',
        previousVersionId: history[0]!.id,
      });
    }
    expect(observed.length).toBeGreaterThanOrEqual(4);
    expect(observed.every((tx) => tx === writeTransaction)).toBe(true);
    const calls = observed.length;
    await runPositionChange(db, ctx, command, personnelFixtureGateway(observed));
    expect(observed).toHaveLength(calls);
    expect(await assignmentVersions(db, session.tenant.id, employees[0]!.assignmentId)).toHaveLength(2);
  });

  it('AC-JOB-05 未勾选本次「调整员工直线经理」（默认否）时不调用人员端口，职位变更照常保存', async () => {
    const { db, session, newParent, position, oldManager, employees } = await managerScenario('job05default', 1);
    const observed: Tx[] = [];
    const ctx = jobWriteContext(session, position.revision);
    const command = positionChange(ctx, position.id, {
      parents: { admin: { parentId: newParent.id } },
      effectiveDate: '2026-10-02',
    });
    expect(await runPositionChange(db, ctx, command, personnelFixtureGateway(observed))).toMatchObject({
      revision: 2,
      directParentId: newParent.id,
    });
    expect(observed).toEqual([]);
    const history = await assignmentVersions(db, session.tenant.id, employees[0]!.assignmentId);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ revision: 1, directManagerId: oldManager.employeeId });
  });

  it.each([
    ['新上级职位 2 人在岗', 2, false],
    ['新上级职位无人在岗（按原站说明推定）', 0, false],
    ['清空上级职位（按原站说明推定）', 1, true],
  ])('AC-JOB-05 %s：勾选也不同步、不新增任职、不报错，职位变更照常保存', async (_case, count, clear) => {
    const { db, session, newParent, position, oldManager, employees } = await managerScenario(
      `job05skip${count}${clear ? 'clear' : ''}`,
      count,
    );
    const appended: unknown[] = [];
    const base = personnelFixtureGateway();
    const gateway: JobPersonnelGateway = {
      ...base,
      async appendManagerVersion(tx, ctx, change) {
        appended.push(change);
        await base.appendManagerVersion(tx, ctx, change);
      },
    };
    const parentId = clear ? null : newParent.id;
    const ctx = jobWriteContext(session, position.revision);
    const command = positionChange(ctx, position.id, {
      parents: { admin: { parentId } },
      effectiveDate: '2026-10-02',
      adjustEmployeeDirectManager: true,
    });
    expect(await runPositionChange(db, ctx, command, gateway)).toMatchObject({ revision: 2, directParentId: parentId });
    expect(appended).toEqual([]);
    for (const employee of employees) {
      const history = await assignmentVersions(db, session.tenant.id, employee.assignmentId);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ revision: 1, directManagerId: oldManager.employeeId });
    }
  });

  it('AC-JOB-05 勾选但本次未改上级职位时选项不生效，不调用人员端口', async () => {
    const { db, session, position, employees } = await managerScenario('job05sameparent', 1);
    const observed: Tx[] = [];
    const ctx = jobWriteContext(session, position.revision);
    const command = positionChange(ctx, position.id, {
      name: '员工职位改名',
      effectiveDate: '2026-10-02',
      adjustEmployeeDirectManager: true,
    });
    expect(await runPositionChange(db, ctx, command, personnelFixtureGateway(observed))).toMatchObject({
      revision: 2,
      name: '员工职位改名',
    });
    expect(observed).toEqual([]);
    expect(await assignmentVersions(db, session.tenant.id, employees[0]!.assignmentId)).toHaveLength(1);
  });

  it('DEC-133 升级前已成功的旧设置命令（开关为 true）按原幂等键重放仍返回首次结果，新命令照旧拒绝', async () => {
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

  it('AC-JOB-05 职位变更接口接受单次选项；租户设置不再承载常驻开关（只兼容 false）', async () => {
    const { session, newParent, position } = await managerScenario('job05http', 1);
    const legacyOn = await session.request('PUT', '/settings', {
      ifMatch: 0,
      body: { allowDuplicatePositionNames: false, adjustEmployeeDirectManager: true },
    });
    expect(legacyOn.status).toBe(400);
    expect(await legacyOn.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    const legacyOff = await session.request('PUT', '/settings', {
      ifMatch: 0,
      body: { allowDuplicatePositionNames: false, adjustEmployeeDirectManager: false },
    });
    expect(legacyOff.status).toBe(200);
    expect(await legacyOff.json()).not.toHaveProperty('adjustEmployeeDirectManager');
    // DEC-074：人员数据端口接入前，需要按职位树同步时 fail-closed，而不是把未知人数当成“不同步”。
    const pending = await session.request('PATCH', `/positions/${position.id}`, {
      ifMatch: position.revision,
      body: {
        parents: { admin: { parentId: newParent.id } },
        effectiveDate: '2026-10-02',
        adjustEmployeeDirectManager: true,
      },
    });
    expect(pending.status).toBe(503);
    const plain = await session.request('PATCH', `/positions/${position.id}`, {
      ifMatch: position.revision,
      body: {
        parents: { admin: { parentId: newParent.id } },
        effectiveDate: '2026-10-02',
        adjustEmployeeDirectManager: false,
      },
    });
    expect(plain.status).toBe(200);
    expect(await plain.json()).toMatchObject({ revision: 2, directParentId: newParent.id });
  });
});

async function managerScenario(label: string, managerCount: number) {
  const { db } = testDb();
  const session = await jobSession(db, label);
  const org = await session.org('经理联动部门');
  const post = await session.create('posts', '经理联动职务');
  const oldParent = await session.create('positions', '原上级职位', { orgId: org.id, postId: post.id });
  const newParent = await session.create('positions', '新上级职位', { orgId: org.id, postId: post.id });
  const position = await session.create('positions', '员工职位', {
    orgId: org.id,
    postId: post.id,
    parents: { admin: { parentId: oldParent.id } },
  });
  const oldManager = await seedIncumbent(db, session, oldParent.id);
  const managers = [];
  for (let index = 0; index < managerCount; index++) managers.push(await seedIncumbent(db, session, newParent.id));
  const employees = [
    await seedIncumbent(db, session, position.id, oldManager.employeeId),
    await seedIncumbent(db, session, position.id, oldManager.employeeId),
  ];
  return { db, session, newParent, position, oldManager, managers, employees };
}

interface PositionChange {
  readonly id: string;
  readonly fingerprint: Record<string, unknown>;
  execute(tx: Tx, commandId: string, gateway: JobPersonnelGateway): Promise<JobRecord>;
}

function positionChange(ctx: JobWriteContext, positionId: string, patch: Record<string, unknown>): PositionChange {
  return {
    id: ctx.commandId,
    fingerprint: { action: 'test-position-change', id: positionId, patch },
    async execute(tx, commandId, gateway) {
      const service = await loadJobWriteService();
      return service.updateJobObject(tx, { ...ctx, commandId }, 'positions', positionId, patch, gateway);
    },
  };
}

async function runPositionChange(
  db: Db,
  ctx: JobWriteContext,
  change: PositionChange,
  gateway: JobPersonnelGateway,
  onTransaction: (tx: Tx) => void = () => undefined,
): Promise<unknown> {
  const result = await runCommand(db, ctx, {
    id: change.id,
    fingerprint: change.fingerprint,
    execute: async (tx, commandId) => {
      onTransaction(tx);
      return { status: 200, body: await change.execute(tx, commandId, gateway) };
    },
  });
  return result.body;
}
