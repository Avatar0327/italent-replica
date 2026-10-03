/**
 * PR #35 第三轮“测试质量”：清单 11（统一加锁顺序）与 X-21（并发创建同编码）用强制锁竞争验证。
 * 屏障事务先占住两条请求都要用的锁，确认两条请求都已阻塞在该锁上再放行，保证二者真正重叠；
 * 换成旧代码（先锁实例 / 先查重再普通插入）会出现死锁或唯一约束冲突。只在真 PostgreSQL 上运行（PGlite 单连接无法并发）。
 */
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, TRANSFER_NODES, transferScene, type InstanceView } from './AC-APV-support.js';

const database = useTestDb();
const BASE = '/api/tenant/approval';
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);

function rowsOf<T>(value: unknown): T[] {
  return (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];
}

/** 等到恰有 expected 个会话在等锁（屏障之外不应有别的锁等待）。 */
async function waitForBlocked(db: Db, expected: number) {
  for (let i = 0; i < 200; i++) {
    const [row] = rowsOf<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'`),
    );
    if (Number(row?.n) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const activity = rowsOf<{ state: string; wait: string | null; query: string }>(
    await db.execute(sql`SELECT state, wait_event_type || ':' || wait_event AS wait, left(query, 160) AS query
      FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()`),
  );
  throw new Error(`等待 ${expected} 个会话阻塞超时：${JSON.stringify(activity)}`);
}

async function reasonOf(response: Response) {
  const body = (await response.json()) as { error?: { details?: { reason?: string } } };
  return { status: response.status, reason: body.error?.details?.reason };
}

describe.runIf(realPostgres)('真 PostgreSQL 强制锁竞争', () => {
  it('X-21：两条同编码创建都阻塞在插入前，放行后一个 201、一个 409，不出现 500', async () => {
    const w = await approvalWorld(database().db, 'apv-pg-create');
    const body = {
      code: 'SameCode',
      name: '同编码流程',
      approvalType: 'transfer',
      exceptionAdminUserId: w.exceptionAdmin,
      conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'TransferProcessNew' }] },
      nodes: [TRANSFER_NODES[0]!],
    };
    const responses = await w.db.transaction(async (barrier) => {
      await barrier.execute(sql`LOCK TABLE approval_processes IN SHARE ROW EXCLUSIVE MODE`);
      const pending = [1, 2].map(() => w.request(w.hr.id, 'POST', `${BASE}/processes`, { ifMatch: 0, body }));
      await waitForBlocked(w.db, 2);
      return pending;
    });
    const results = await Promise.all((await Promise.all(responses)).map(reasonOf));
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
  });

  it('清单 11：最后节点同意与业务单撤回都先锁员工，放行后一方成功、另一方按状态 409，不发生死锁', async () => {
    const w = await approvalWorld(database().db, 'apv-pg-lock-order');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!] });
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
    const view: InstanceView = await w.submit(draft);
    const task = view.tasks.find((item) => item.status === 'pending')!;
    const business = await w.business(draft.id);
    // 员工行受 RLS 保护：屏障须在租户上下文里锁行，否则看不到行、锁不住。
    const responses = await withTenant(w.db, w.tenant.id, async (barrier) => {
      const locked = await barrier.execute(sql`SELECT id FROM employment_employees
        WHERE tenant_id=${w.tenant.id} AND id=${s.subject.employeeId}::uuid FOR UPDATE`);
      expect(rowsOf(locked)).toHaveLength(1);
      const pending = [
        w.taskAction(s.outHead.userId, task.id, 'approve', view.revision),
        w.request(w.hr.id, 'POST', `/api/tenant/employment/businesses/${draft.id}/withdraw`, {
          ifMatch: business.revision,
        }),
      ];
      await waitForBlocked(w.db, 2);
      return pending;
    });
    const results = await Promise.all((await Promise.all(responses)).map(reasonOf));
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    // 死锁会被映射为 APPROVAL_CONCURRENT_CONFLICT；统一锁序下失败方只会因单据状态已变而被拒。
    expect(results.map((result) => result.reason)).not.toContain('APPROVAL_CONCURRENT_CONFLICT');
  });
});
