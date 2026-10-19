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
import { lockOrganizationSettings } from '../../apps/api/src/modules/org/locks.js';
import { tenantApi } from './support/tenant-api.js';
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

  /**
   * 锁序（第 1 轮返工 P2-1）：测试会话先持住组织设置锁，发出作废在途转正的请求（它必须先停在组织锁上，此时不能已持有成员行的外键锁），
   * 再由测试会话对发起人的成员行 FOR UPDATE——这是“先持组织锁、再锁成员行”的路径（入职等）的锁序。
   * 作废请求若在取组织锁之前就发了站内消息（成员行 KEY SHARE），两边成环，PG 判死锁（40P01）。
   */
  async function orgLockedThenMemberLocked<T>(w: EndWorld, request: () => Promise<T>) {
    let release!: () => void;
    let held!: () => void;
    const hold = new Promise<void>((done) => (release = done));
    const locked = new Promise<void>((done) => (held = done));
    let memberLocked: unknown;
    const holder = withTenant(w.db, w.tenantId, async (tx) => {
      await lockOrganizationSettings(tx, w.tenantId);
      held();
      await hold;
      try {
        await tx.execute(sql`SELECT 1 FROM tenant_memberships WHERE tenant_id=${w.tenantId}
          AND user_id=${w.session.user.id}::uuid FOR UPDATE`);
      } catch (error) {
        memberLocked = error;
      }
    });
    await locked;
    const running = request().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await waitForBlocked(w.db, 1);
    release();
    await holder;
    return { result: await running, memberLocked };
  }

  it('锁序：直接转正作废在途申请时先取组织锁再发消息——与“组织锁 → 成员行”路径交错不死锁，两边都成功', async () => {
    const w = await endWorld(testDb().db, 'pg-lock-order-direct');
    const intern = await w.hire('锁序直接转正合成实习生', 'intern');
    const applicationId = await w.applyRegularization(intern.employee.id, '2026-10-20');
    const { result, memberLocked } = await orgLockedThenMemberLocked(w, () =>
      w.regularize(intern.employee.id, { effectiveDate: '2026-10-16', departmentId: w.org.id, probation: false }),
    );
    expect(memberLocked).toBeUndefined();
    const response = (result as { value: Response }).value;
    expect(response.status, await response.clone().text()).toBe(201);
    expect(await w.statusOf(applicationId)).toBe('voided');
  });

  it('锁序：结束实习（离职生效步骤 1 作废）同一交错也不死锁', async () => {
    const w = await endWorld(testDb().db, 'pg-lock-order-end');
    const intern = await w.hire('锁序结束实习合成实习生', 'intern');
    const applicationId = await w.applyRegularization(intern.employee.id, '2026-10-20');
    const { result, memberLocked } = await orgLockedThenMemberLocked(w, () =>
      w.terminate(intern.employee.id, { endDate: '2026-09-30', confirmed: true }),
    );
    expect(memberLocked).toBeUndefined();
    const response = (result as { value: Response }).value;
    expect(response.status, await response.clone().text()).toBe(201);
    expect(await w.statusOf(applicationId)).toBe('voided');
  });

  it('同人重复结束（同一 revision 并发两次）：恰一次 201、另一次确定的 409；只产生一条离职', async () => {
    const w = await endWorld(testDb().db, 'pg-duplicate-end');
    const intern = await w.hire('重复结束合成实习生', 'intern');
    const revision = await w.revision(intern.employee.id);
    const end = () => w.terminate(intern.employee.id, { endDate: '2026-09-30' }, revision);
    const result = await interleave(w, intern.employee.id, end, end);
    const [winner, loser] = [result.first, result.second].map((outcome) => (outcome as { value: Response }).value);
    expect(winner!.status, await winner!.clone().text()).toBe(201);
    expect(loser!.status).toBe(409);
    expect(await loser!.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
    expect(await counts(w, intern.employee.id)).toEqual({ regularized: 0, leaves: 1 });
    // 用最新 revision 再结束一次：已结束实习，确定的业务拒绝
    const again = await w.terminate(intern.employee.id, { endDate: '2026-09-30' });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { details: { reason: 'ACTIVE_EMPLOYMENT_REQUIRED' } } });
  });

  it('跨租户负例：别的租户的 HR 不能结束本租户的实习生（不论带哪个租户头），目标租户没有任何写入', async () => {
    const mine = await endWorld(testDb().db, 'pg-tenant-a');
    const other = await endWorld(testDb().db, 'pg-tenant-b');
    const victim = await other.hire('跨租户合成实习生', 'intern');
    const revision = await other.revision(victim.employee.id);
    const api = tenantApi(testDb().db, { clock: () => new Date('2026-10-01T01:00:00.000Z') });
    const call = (tenant: string) =>
      api.request('POST', `/api/tenant/employment/interns/${victim.employee.id}/terminate`, {
        user: mine.session.user.id,
        tenant,
        ifMatch: revision,
        body: { endDate: '2026-09-30' },
      });
    const inOwnTenant = await call(mine.session.tenant.id);
    expect(inOwnTenant.status, await inOwnTenant.clone().text()).toBe(404);
    const inTargetTenant = await call(other.session.tenant.id);
    expect([403, 404], await inTargetTenant.clone().text()).toContain(inTargetTenant.status);
    expect(await counts(other, victim.employee.id)).toEqual({ regularized: 0, leaves: 0 });
    expect(await other.timeline(victim.employee.id)).toHaveLength(1);
    expect(await other.revision(victim.employee.id)).toBe(revision);
  });
});
