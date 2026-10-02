import { AppError } from '@italent/api';
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
} from './AC-JOB-personnel-support.js';
import { jobSession } from './AC-JOB-support.js';

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
  const settings = await session.request('PUT', '/settings', {
    ifMatch: 0,
    body: { allowDuplicatePositionNames: false, adjustEmployeeDirectManager: true },
  });
  expect(settings.status).toBe(200);
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

  it.each([0, 2])('新上级职位有 %i 名在岗人员时经理来源不唯一，拒绝并保留职位及任职版本', async (count) => {
    const { db, session, parent, position, employee } = await managerScenario(`jobmanagercount${count}`, count);
    const service = await loadJobWriteService();
    const ctx = jobWriteContext(session, position.revision);
    await expect(
      runCommand(db, ctx, {
        id: ctx.commandId,
        fingerprint: { action: 'test-ambiguous-manager', id: position.id },
        execute: async (tx, commandId) => ({
          status: 200,
          body: await service.updateJobObject(
            tx,
            { ...ctx, commandId },
            'positions',
            position.id,
            { parents: { admin: { parentId: parent.id } }, effectiveDate: '2026-10-02' },
            personnelFixtureGateway(),
          ),
        }),
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(await session.detail('positions', position.id, '2026-10-02')).toMatchObject({ revision: 1 });
    expect(await assignmentVersions(db, session.tenant.id, employee.assignmentId)).toHaveLength(1);
  });

  it('人员端口追加任职后报存储故障，整个命令撤销任职、职位版本与 revision', async () => {
    const { db, session, parent, position, employee } = await managerScenario('jobmanagerrollback', 1);
    const service = await loadJobWriteService();
    const base = personnelFixtureGateway();
    let appended = 0;
    const failedGateway: JobPersonnelGateway = {
      ...base,
      async appendManagerVersion(tx, ctx, change) {
        await base.appendManagerVersion(tx, ctx, change);
        appended++;
        throw new AppError('SERVICE_UNAVAILABLE', '测试夹具模拟人员端口存储故障');
      },
    };
    const ctx = jobWriteContext(session, position.revision);
    await expect(
      runCommand(db, ctx, {
        id: ctx.commandId,
        fingerprint: { action: 'test-manager-rollback', id: position.id },
        execute: async (tx, commandId) => ({
          status: 200,
          body: await service.updateJobObject(
            tx,
            { ...ctx, commandId },
            'positions',
            position.id,
            { parents: { admin: { parentId: parent.id } }, effectiveDate: '2026-10-02' },
            failedGateway,
          ),
        }),
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(appended).toBe(1);
    expect(await session.detail('positions', position.id, '2026-10-02')).toMatchObject({ revision: 1 });
    const history = await assignmentVersions(db, session.tenant.id, employee.assignmentId);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ revision: 1, directManagerId: null });
  });
});
