/**
 * AC-JOB-05（F-006 第二轮，PR #54 astra 首审 P3）：职位变更同步直线经理与普通任职业务的取锁顺序。
 * 真 PostgreSQL 强制交错（PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行）：
 * - 普通任职先锁员工，写入任职时经外键对职位对象头取 KEY SHARE；
 * - 职位变更先锁职位对象头，同步时再锁员工。
 * 职位对象头若用 FOR UPDATE 锁住，两者成环死锁；改为 FOR NO KEY UPDATE 后外键的 KEY SHARE 不再等待，
 * 普通任职先完成，职位变更随后拿到员工锁，按员工 revision 已变返回 409 并整单回滚（真实双连接竞争）。
 */
import { type Db, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { orgPeopleWorld, resultRows } from './AC-ORG-people-support.js';

const database = useTestDb();
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);
const D = '2026-10-02';

/** 等到恰有 expected 个会话在等锁。 */
async function waitForBlocked(db: Db, expected: number) {
  for (let i = 0; i < 200; i++) {
    const [row] = resultRows<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'`),
    );
    if (Number(row?.n) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待 ${expected} 个会话阻塞超时`);
}

describe.runIf(realPostgres)('真 PostgreSQL：职位同步与普通任职的取锁顺序', () => {
  it('普通任职持有员工锁并经外键取职位头 KEY SHARE 时不与职位同步成环；职位变更随后 409 整单回滚', async () => {
    const db = database().db;
    const world = await orgPeopleWorld(db, 'job05lockorder');
    const department = await world.org('取锁顺序部门');
    const post = await world.job('posts', '取锁顺序职务');
    const position = (name: string, extra: Record<string, unknown> = {}) =>
      world.job('positions', name, { orgId: department.id, postId: post.id, ...extra });
    const newParent = await position('新上级职位');
    const target = await position('本职位');
    await world.hire('新上级唯一在岗', { departmentId: department.id, positionId: newParent.id });
    const employee = await world.hire('本职位员工', { departmentId: department.id, positionId: target.id });

    let pending: Promise<Response> | undefined;
    await withTenant(db, world.tenant.id, async (barrier) => {
      // 普通任职：先锁员工……
      await barrier.execute(sql`SELECT id FROM employment_employees
        WHERE tenant_id=${world.tenant.id} AND id=${employee.id}::uuid FOR UPDATE`);
      pending = world.call('PATCH', `job/positions/${target.id}`, {
        ifMatch: target.revision,
        body: { parents: { admin: { parentId: newParent.id } }, effectiveDate: D, adjustEmployeeDirectManager: true },
      });
      // 职位变更已锁住职位头，正等员工锁。
      await waitForBlocked(db, 1);
      // ……再像写入任职时的外键检查一样对职位头取 KEY SHARE：旧实现（FOR UPDATE）在此成环死锁。
      await barrier.execute(sql`SELECT id FROM job_position_objects
        WHERE tenant_id=${world.tenant.id} AND id=${target.id}::uuid FOR KEY SHARE`);
      await barrier.execute(sql`UPDATE employment_employees SET revision = revision + 1
        WHERE tenant_id=${world.tenant.id} AND id=${employee.id}::uuid`);
    });
    const response = await pending!;
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
    const current = await world.call('GET', `job/positions/${target.id}?asOf=${D}`);
    expect(await current.json()).toMatchObject({ revision: target.revision, directParentId: null });
    expect((await world.employmentRecords(employee.id, D)).map((record) => record.kind)).toEqual(['hire']);
  });
});
