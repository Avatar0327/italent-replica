/**
 * BE-6b 真 PostgreSQL 并发（DEC-593；普通角色 app_owner）：两条连接强制交错——测试会话先持住员工行锁，再依次发出两个请求，
 * 用 pg_stat_activity 屏障确认第一个已在锁上等待、第二个才发出，放锁后按锁队列先后执行（不靠 Promise.all 碰运气）。
 * 所有写路径都先取员工行锁（审批通过：员工 → 业务头；结束实习 / 直接转正：员工 → 业务头 → 审批实例），所以只能二选一、无双写：
 * ① 结束实习 vs 同一人转正申请审批通过：先结束 → 申请被作废、迟到的审批被拒；先审批 → 转正落地、结束实习被拒。
 * ② 直接实习转正 vs 结束实习：恰一方成功，另一方得到确定的 409。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { endWorld, type EndWorld } from './AC-INTERN-end-support.js';
import { waitForBlocked } from './support/pg-interleave.js';

const testDb = useTestDb();

/** 测试会话持住员工行锁，依次发出 first / second（各自确认已在锁上等待），放锁后等两者结束。 */
async function interleave<A, B>(w: EndWorld, employeeId: string, first: () => Promise<A>, second: () => Promise<B>) {
  let release!: () => void;
  let locked!: () => void;
  const hold = new Promise<void>((done) => (release = done));
  const held = new Promise<void>((done) => (locked = done));
  const holder = withTenant(w.db, w.tenantId, async (tx) => {
    await tx.execute(sql`SELECT 1 FROM employment_employees WHERE tenant_id=${w.tenantId}
      AND id=${employeeId}::uuid FOR NO KEY UPDATE`);
    locked();
    await hold;
  });
  await held;
  const settle = <T>(run: () => Promise<T>) =>
    run().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  const firstResult = settle(first);
  await waitForBlocked(w.db, 1);
  const secondResult = settle(second);
  await waitForBlocked(w.db, 2);
  release();
  await holder;
  return { first: await firstResult, second: await secondResult };
}

const codeOf = (outcome: object) => ((outcome as { error?: unknown }).error as { code?: string } | undefined)?.code;

async function counts(w: EndWorld, employeeId: string) {
  const [row] = await w.rows<{ regularized: number; leaves: number }>(sql`SELECT
    (SELECT count(*)::integer FROM employment_records WHERE tenant_id=${w.tenantId}
      AND employee_id=${employeeId}::uuid AND kind='intern_regularization') AS regularized,
    (SELECT count(*)::integer FROM employment_records WHERE tenant_id=${w.tenantId}
      AND employee_id=${employeeId}::uuid AND kind='leave') AS leaves`);
  return row!;
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-INTERN-end-pg 结束实习并发（真 PG，app_owner）', () => {
  /** 转正计划日 = 今天（10-01）：审批通过当场落地；结束日 09-30 的结束实习也当场生效。 */
  async function racers(label: string) {
    const w = await endWorld(testDb().db, label);
    const intern = await w.hire(`${label}合成实习生`, 'intern');
    const applicationId = await w.applyRegularization(intern.employee.id, '2026-10-01');
    const revision = await w.revision(intern.employee.id);
    const end = async () => w.terminate(intern.employee.id, { endDate: '2026-09-30', confirmed: true }, revision);
    const approve = () => w.approveAt(applicationId, '2026-10-01T01:00:00Z');
    return { w, intern, applicationId, end, approve };
  }

  it('① 结束实习先得锁：申请被作废、结束实习生效；迟到的审批通过被拒（revision 冲突，非死锁）', async () => {
    const { w, intern, applicationId, end, approve } = await racers('pg-end-first');
    const result = await interleave(w, intern.employee.id, end, approve);
    const ended = (result.first as { value: Response }).value;
    expect(ended.status, await ended.clone().text()).toBe(201);
    expect(codeOf(result.second)).toBe('REVISION_CONFLICT');
    expect(await w.statusOf(applicationId)).toBe('voided');
    expect(await counts(w, intern.employee.id)).toEqual({ regularized: 0, leaves: 1 });
  });

  it('① 审批先得锁：转正落地；结束实习得到确定的 409（员工 revision 已变），不产生离职', async () => {
    const { w, intern, applicationId, end, approve } = await racers('pg-approve-first');
    const result = await interleave(w, intern.employee.id, approve, end);
    expect((result.first as { value: string }).value).toBe('effective');
    const ended = (result.second as { value: Response }).value;
    expect(ended.status).toBe(409);
    expect(await ended.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
    expect(await w.statusOf(applicationId)).toBe('effective');
    expect(await counts(w, intern.employee.id)).toEqual({ regularized: 1, leaves: 0 });
  });

  async function directVsEnd(label: string, endFirst: boolean) {
    const w = await endWorld(testDb().db, label);
    const intern = await w.hire(`${label}合成实习生`, 'intern');
    const revision = await w.revision(intern.employee.id);
    const end = () => w.terminate(intern.employee.id, { endDate: '2026-09-30' }, revision);
    const regularize = () =>
      w.regularize(
        intern.employee.id,
        { effectiveDate: '2026-10-01', departmentId: w.org.id, probation: false },
        revision,
      );
    const result = endFirst
      ? await interleave(w, intern.employee.id, end, regularize)
      : await interleave(w, intern.employee.id, regularize, end);
    const [winner, loser] = [result.first, result.second].map((outcome) => (outcome as { value: Response }).value);
    expect(winner!.status, await winner!.clone().text()).toBe(201);
    expect(loser!.status).toBe(409);
    expect(await loser!.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
    return counts(w, intern.employee.id);
  }

  it('② 结束实习先得锁：恰一方成功（离职），直接转正得到 409', async () => {
    expect(await directVsEnd('pg-direct-end-first', true)).toEqual({ regularized: 0, leaves: 1 });
  });

  it('② 直接转正先得锁：恰一方成功（转正），结束实习得到 409', async () => {
    expect(await directVsEnd('pg-direct-reg-first', false)).toEqual({ regularized: 1, leaves: 0 });
  });
});
