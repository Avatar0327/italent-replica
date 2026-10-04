import { AppError } from '@italent/api';
import { type Db, sql, type Tx, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { runCommand } from '../../apps/api/src/commands.js';
import {
  assignmentVersions,
  installJobPersonnelFixture,
  jobWriteContext,
  loadJobWriteService,
  personnelFixtureGateway,
  resultRows,
  seedIncumbent,
  type JobPersonnelGateway,
} from './AC-JOB-personnel-support.js';
import { jobSession, type JobRecord, type JobSession } from './AC-JOB-support.js';

const testDb = useTestDb();
beforeAll(async () => installJobPersonnelFixture(testDb().db));

async function managerScenario(label: string, managerCount: number) {
  const { db } = testDb();
  const session = await jobSession(db, label);
  const org = await session.org('经理端口事务部门');
  const post = await session.create('posts', '经理端口事务职务');
  const parent = await session.create('positions', '经理端口事务上级', { orgId: org.id, postId: post.id });
  const position = await session.create('positions', '经理端口事务员工', { orgId: org.id, postId: post.id });
  const employee = await seedIncumbent(db, session, position.id);
  for (let index = 0; index < managerCount; index++) await seedIncumbent(db, session, parent.id);
  return { db, session, parent, position, employee };
}

describe('AC-JOB-03/05 可信人员校验与失败事务回滚', () => {
  it('可信端口确认没有在岗人员后允许停用，旧时点仍然启用', async () => {
    const { db } = testDb();
    const session = await jobSession(db, 'jobemptystop');
    const org = await session.org('无人职位部门');
    const post = await session.create('posts', '无人职位职务');
    const position = await session.create('positions', '无人职位', { orgId: org.id, postId: post.id });
    const service = await loadJobWriteService();
    const ctx = jobWriteContext(session, position.revision);
    await runCommand(db, ctx, {
      id: ctx.commandId,
      fingerprint: { action: 'test-empty-position-stop', id: position.id },
      execute: async (tx, commandId) => ({
        status: 200,
        body: await service.updateJobObject(
          tx,
          { ...ctx, commandId },
          'positions',
          position.id,
          { enabled: false, effectiveDate: '2026-10-02' },
          personnelFixtureGateway(),
        ),
      }),
    });
    expect(await session.detail('positions', position.id, '2026-10-01')).toMatchObject({ enabled: true });
    expect(await session.detail('positions', position.id, '2026-10-02')).toMatchObject({ enabled: false, revision: 2 });
    expect(await session.list('positions', { asOf: '2026-10-02' })).toEqual([]);
  });

  it.each([0, 2])('新上级职位有 %i 名在岗人员时经理来源不唯一，只读不写任职，职位变更照常保存', async (count) => {
    const { db, session, parent, position, employee } = await managerScenario(`jobmanagercount${count}`, count);
    const service = await loadJobWriteService();
    const base = personnelFixtureGateway();
    let appended = 0;
    const gateway: JobPersonnelGateway = {
      ...base,
      async appendManagerVersion(tx, ctx, change) {
        appended++;
        await base.appendManagerVersion(tx, ctx, change);
      },
    };
    const ctx = jobWriteContext(session, position.revision);
    await runCommand(db, ctx, {
      id: ctx.commandId,
      fingerprint: { action: 'test-ambiguous-manager', id: position.id },
      execute: async (tx, commandId) => ({
        status: 200,
        body: await service.updateJobObject(
          tx,
          { ...ctx, commandId },
          'positions',
          position.id,
          {
            parents: { admin: { parentId: parent.id } },
            effectiveDate: '2026-10-02',
            adjustEmployeeDirectManager: true,
          },
          gateway,
        ),
      }),
    });
    expect(appended).toBe(0);
    expect(await session.detail('positions', position.id, '2026-10-02')).toMatchObject({
      revision: 2,
      directParentId: parent.id,
    });
    expect(await assignmentVersions(db, session.tenant.id, employee.assignmentId)).toHaveLength(1);
  });

  it('DEC-131 员工本人即新上级唯一在岗人时跳过并在保存结果逐人列出原因，其他员工照常同步', async () => {
    const { db, session, parent, position, employee } = await managerScenario('jobmanagerself', 0);
    const manager = await seedIncumbent(db, session, parent.id);
    const self = await seedIncumbent(db, session, position.id, null, manager.employeeId);
    const saved = await synchronizePosition(db, session, position, parent.id, personnelFixtureGateway());
    expect(saved).toMatchObject({
      revision: 2,
      managerSync: {
        skipped: [
          { employeeId: manager.employeeId, assignmentId: self.assignmentId, reason: 'EMPLOYEE_IS_SOLE_MANAGER' },
        ],
      },
    });
    expect((saved as { managerSync: { skipped: unknown[] } }).managerSync.skipped).toHaveLength(1);
    expect(await assignmentVersions(db, session.tenant.id, self.assignmentId)).toHaveLength(1);
    const synced = await assignmentVersions(db, session.tenant.id, employee.assignmentId);
    expect(synced).toHaveLength(2);
    expect(synced[1]).toMatchObject({ directManagerId: manager.employeeId, effectiveDate: '2026-10-02' });
  });

  it('DEC-132 员工直线经理本来就是新上级唯一在岗人时仍新增一条组织调整版本', async () => {
    const { db, session, parent, position } = await managerScenario('jobmanagersame', 0);
    const manager = await seedIncumbent(db, session, parent.id);
    const already = await seedIncumbent(db, session, position.id, manager.employeeId);
    const saved = await synchronizePosition(db, session, position, parent.id, personnelFixtureGateway());
    expect(saved).toMatchObject({ revision: 2, managerSync: { skipped: [] } });
    const synced = await assignmentVersions(db, session.tenant.id, already.assignmentId);
    expect(synced).toHaveLength(2);
    expect(synced[1]).toMatchObject({
      revision: 2,
      directManagerId: manager.employeeId,
      effectiveDate: '2026-10-02',
      businessKind: 'org_adjustment',
      changeType: 'position_adjustment',
      previousVersionId: synced[0]!.id,
    });
  });

  it('已写入首名员工任职版本与经理审计后人员端口报故障，整个命令撤销任职、审计、职位版本与 revision', async () => {
    const { db, session, parent, position, employee } = await managerScenario('jobmanagerrollback', 1);
    const second = await seedIncumbent(db, session, position.id);
    const base = personnelFixtureGateway();
    let appended = 0;
    let auditsBeforeFailure = -1;
    const failedGateway: JobPersonnelGateway = {
      ...base,
      async appendManagerVersion(tx, ctx, change) {
        if (appended === 1) {
          auditsBeforeFailure = await managerAudits(tx, ctx.commandId);
          throw new AppError('SERVICE_UNAVAILABLE', '测试夹具模拟人员端口存储故障');
        }
        await base.appendManagerVersion(tx, ctx, change);
        appended++;
      },
    };
    await expect(synchronizePosition(db, session, position, parent.id, failedGateway)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(appended).toBe(1);
    expect(auditsBeforeFailure).toBe(1);
    expect(await session.detail('positions', position.id, '2026-10-02')).toMatchObject({ revision: 1 });
    for (const assignment of [employee, second]) {
      const history = await assignmentVersions(db, session.tenant.id, assignment.assignmentId);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ revision: 1, directManagerId: null });
    }
    const audits = await withTenant(db, session.tenant.id, async (tx) =>
      resultRows(await tx.execute(sql`SELECT id FROM audit_events WHERE action = 'job.manager.synchronize'`)),
    );
    expect(audits).toEqual([]);
  });
});

async function synchronizePosition(
  db: Db,
  session: JobSession,
  position: JobRecord,
  parentId: string,
  gateway: JobPersonnelGateway,
): Promise<unknown> {
  const service = await loadJobWriteService();
  const ctx = jobWriteContext(session, position.revision);
  const result = await runCommand(db, ctx, {
    id: ctx.commandId,
    fingerprint: { action: 'test-manager-sync', id: position.id, parentId },
    execute: async (tx, commandId) => ({
      status: 200,
      body: await service.updateJobObject(
        tx,
        { ...ctx, commandId },
        'positions',
        position.id,
        { parents: { admin: { parentId } }, effectiveDate: '2026-10-02', adjustEmployeeDirectManager: true },
        gateway,
      ),
    }),
  });
  return result.body;
}

async function managerAudits(tx: Tx, commandId: string): Promise<number> {
  const rows = resultRows(
    await tx.execute(sql`SELECT id FROM audit_events
      WHERE action = 'job.manager.synchronize' AND command_id = ${commandId}`),
  );
  return rows.length;
}
