/**
 * AC-JOB-05（F-006）：真实人员数据端口的写入安全——经任职模块的写入函数追加版本，与职位变更同一事务；
 * 员工在读取在岗人与追加版本之间被他人修改时按 revision 返回 409，整单（职位版本、任职、审计、outbox）回滚。
 */
import { type Db, sql, type Tx, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../../apps/api/src/commands.js';
import { jobWriteContext, loadJobWriteService, type JobPersonnelGateway } from './AC-JOB-personnel-support.js';
import type { JobSession } from './AC-JOB-support.js';
import { orgPeopleWorld, resultRows, type JobObject, type OrgPeopleWorld } from './AC-ORG-people-support.js';
import { allowAll } from './support/tenant-api.js';

const testDb = useTestDb();
const D = '2026-10-02';
const ALL_SCOPE = { orgIds: [], personIds: [], all: true, hasDataPermission: true, source: 'identity' };

interface EmploymentPort {
  employmentJobPersonnel(access?: { scope: unknown; authorize: typeof allowAll }): JobPersonnelGateway;
}

// 动态路径：实现落地前用例因缺少端口而失败，而不是整个文件无法加载。
async function loadPort(): Promise<EmploymentPort> {
  const path = '../../apps/api/src/modules/job/employment-port.js';
  return (await import(path)) as EmploymentPort;
}

async function scenario(db: Db, label: string) {
  const world = await orgPeopleWorld(db, label);
  const org = await world.org('端口部门');
  const post = await world.job('posts', '端口职务');
  const position = (name: string) => world.job('positions', name, { orgId: org.id, postId: post.id });
  const newParent = await position('端口新上级');
  const target = await position('端口员工职位');
  await world.hire('端口新经理', { departmentId: org.id, positionId: newParent.id });
  const first = await world.hire('端口员工一', { departmentId: org.id, positionId: target.id });
  const second = await world.hire('端口员工二', { departmentId: org.id, positionId: target.id });
  return { world, newParent, target, employees: [first, second] };
}

async function synchronize(
  db: Db,
  world: OrgPeopleWorld,
  target: JobObject,
  parentId: string,
  gateway: JobPersonnelGateway,
) {
  const service = await loadJobWriteService();
  const ctx = jobWriteContext(world as unknown as JobSession, target.revision);
  return runCommand(db, ctx, {
    id: ctx.commandId,
    fingerprint: { action: 'test-real-port', id: target.id },
    execute: async (tx, commandId) => ({
      status: 200,
      body: await service.updateJobObject(
        tx,
        { ...ctx, commandId },
        'positions',
        target.id,
        { parents: { admin: { parentId } }, effectiveDate: D, adjustEmployeeDirectManager: true },
        gateway,
      ),
    }),
  });
}

async function recordCreateEvents(db: Db, tenantId: string, employeeIds: string[]) {
  return withTenant(db, tenantId, async (tx) =>
    resultRows<{ employeeId: string; events: number }>(
      await tx.execute(sql`SELECT employee_id AS "employeeId", count(*)::int AS events FROM employment_outbox
        WHERE event_type = 'employment.record.create'
          AND employee_id IN (${sql.join(
            employeeIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})
        GROUP BY employee_id ORDER BY employee_id`),
    ),
  );
}

describe('AC-JOB-05 真实人员端口的事务与并发', () => {
  it('员工 revision 在读取在岗人之后、追加之前被他人改动时 409，职位、任职、outbox 全部回滚', async () => {
    const { db } = testDb();
    const { world, newParent, target, employees } = await scenario(db, 'job05portrevision');
    const { employmentJobPersonnel } = await loadPort();
    const real = employmentJobPersonnel({ scope: ALL_SCOPE, authorize: allowAll });
    let appended = 0;
    const concurrent: JobPersonnelGateway = {
      listIncumbents: (tx, query) => real.listIncumbents(tx, query),
      async appendManagerVersion(tx: Tx, ctx, change) {
        if (appended === 1) {
          // 模拟他人在本命令读取在岗人之后修改了第二名员工（revision 前进）。
          await tx.execute(
            sql`UPDATE employment_employees SET revision = revision + 1 WHERE id = ${change.employeeId}`,
          );
        }
        await real.appendManagerVersion(tx, ctx, change);
        appended++;
      },
    };
    await expect(synchronize(db, world, target, newParent.id, concurrent)).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    expect(appended).toBe(1);
    for (const employee of employees) {
      expect((await world.employmentRecords(employee.id, D)).map((record) => record.kind)).toEqual(['hire']);
    }
    const position = await world.call('GET', `job/positions/${target.id}?asOf=${D}`);
    expect(await position.json()).toMatchObject({ revision: 1 });
    const events = await recordCreateEvents(
      db,
      world.tenant.id,
      employees.map((employee) => employee.id),
    );
    expect(events.map((row) => row.events)).toEqual([1, 1]);
  });

  it('未提供任职写入授权的端口拒绝追加（fail-closed），只读在岗人不受影响', async () => {
    const { db } = testDb();
    const { world, newParent, target, employees } = await scenario(db, 'job05portaccess');
    const { employmentJobPersonnel } = await loadPort();
    const readOnly = employmentJobPersonnel();
    await withTenant(db, world.tenant.id, async (tx) => {
      const incumbents = await readOnly.listIncumbents(tx, {
        tenantId: world.tenant.id,
        positionId: target.id,
        asOf: D,
      });
      expect(incumbents.map((row) => row.employeeId).sort()).toEqual(employees.map((row) => row.id).sort());
      expect(incumbents.every((row) => row.revision >= 1)).toBe(true);
    });
    await expect(synchronize(db, world, target, newParent.id, readOnly)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const employee of employees) {
      expect((await world.employmentRecords(employee.id, D)).map((record) => record.kind)).toEqual(['hire']);
    }
  });
});
