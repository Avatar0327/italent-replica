import { type Tx } from '@italent/db';
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
} from './AC-JOB-personnel-support.js';
import { jobSession } from './AC-JOB-support.js';

const testDb = useTestDb();
beforeAll(async () => installJobPersonnelFixture(testDb().db));

describe('AC-JOB-03/05 职位停用与任职直线经理版本联动', () => {
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

  it('AC-JOB-05 开关开启后按新上级职位的在岗人追加任职经理版本，同命令重放不再追加', async () => {
    const { db } = testDb();
    const session = await jobSession(db, 'job05on');
    const org = await session.org('经理联动部门');
    const post = await session.create('posts', '经理联动职务');
    const firstParent = await session.create('positions', '原上级职位', { orgId: org.id, postId: post.id });
    const secondParent = await session.create('positions', '新上级职位', { orgId: org.id, postId: post.id });
    const position = await session.create('positions', '员工职位', {
      orgId: org.id,
      postId: post.id,
      parents: { admin: { parentId: firstParent.id } },
    });
    const oldManager = await seedIncumbent(db, session, firstParent.id);
    const newManager = await seedIncumbent(db, session, secondParent.id);
    const employee = await seedIncumbent(db, session, position.id, oldManager.employeeId);
    const settings = await session.request('PUT', '/settings', {
      ifMatch: 0,
      body: { allowDuplicatePositionNames: false, adjustEmployeeDirectManager: true },
    });
    expect(settings.status).toBe(200);
    const service = await loadJobWriteService();
    const observed: Tx[] = [];
    const gateway = personnelFixtureGateway(observed);
    const ctx = jobWriteContext(session, position.revision);
    let writeTransaction: Tx | undefined;
    const command = {
      id: ctx.commandId,
      fingerprint: { action: 'test-position-manager', id: position.id, parentId: secondParent.id },
      execute: async (tx: Tx, commandId: string) => {
        writeTransaction = tx;
        const body = await service.updateJobObject(
          tx,
          { ...ctx, commandId },
          'positions',
          position.id,
          { parents: { admin: { parentId: secondParent.id } }, effectiveDate: '2026-10-02' },
          gateway,
        );
        return { status: 200 as const, body };
      },
    };
    await runCommand(db, ctx, command);
    const history = await assignmentVersions(db, session.tenant.id, employee.assignmentId);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ revision: 1, directManagerId: oldManager.employeeId });
    expect(history[1]).toMatchObject({
      revision: 2,
      directManagerId: newManager.employeeId,
      effectiveDate: '2026-10-02',
      previousVersionId: history[0]!.id,
    });
    expect(observed.length).toBeGreaterThanOrEqual(3);
    expect(observed.every((tx) => tx === writeTransaction)).toBe(true);
    const calls = observed.length;
    await runCommand(db, ctx, command);
    expect(observed).toHaveLength(calls);
    expect(await assignmentVersions(db, session.tenant.id, employee.assignmentId)).toHaveLength(2);
  });

  it('AC-JOB-05 开关关闭时变更职位上级不调用人员端口，保留原经理及任职版本', async () => {
    const { db } = testDb();
    const session = await jobSession(db, 'job05off');
    const org = await session.org('经理不联动部门');
    const post = await session.create('posts', '经理不联动职务');
    const firstParent = await session.create('positions', '旧职位上级', { orgId: org.id, postId: post.id });
    const secondParent = await session.create('positions', '新职位上级', { orgId: org.id, postId: post.id });
    const position = await session.create('positions', '保留经理职位', {
      orgId: org.id,
      postId: post.id,
      parents: { admin: { parentId: firstParent.id } },
    });
    const oldManager = await seedIncumbent(db, session, firstParent.id);
    const employee = await seedIncumbent(db, session, position.id, oldManager.employeeId);
    const service = await loadJobWriteService();
    const observed: Tx[] = [];
    const gateway = personnelFixtureGateway(observed);
    const ctx = jobWriteContext(session, position.revision);
    await runCommand(db, ctx, {
      id: ctx.commandId,
      fingerprint: { action: 'test-position-no-manager-sync', id: position.id },
      execute: async (tx, commandId) => ({
        status: 200,
        body: await service.updateJobObject(
          tx,
          { ...ctx, commandId },
          'positions',
          position.id,
          { parents: { admin: { parentId: secondParent.id } }, effectiveDate: '2026-10-02' },
          gateway,
        ),
      }),
    });
    expect(observed).toEqual([]);
    const history = await assignmentVersions(db, session.tenant.id, employee.assignmentId);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ revision: 1, directManagerId: oldManager.employeeId });
    expect(await session.detail('positions', position.id, '2026-10-02')).toMatchObject({ revision: 2 });
  });
});
