/** AC-APV-32 / AC-TRF-15：合席推进调动时，整批参与者必须先于业务/实例统一取锁。 */
import type * as Crypto from 'node:crypto';
import { bootstrapTenantAdmin } from '@italent/api';
import { revokeMembership, sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import { approvalWorld, transferScene, type InstanceView } from './AC-APV-support.js';
import { cmd } from './support/tenant-api.js';
const prefix = vi.hoisted(() => ({ value: '' }));
vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof Crypto>();
  return {
    ...actual,
    randomUUID: () => {
      const id = actual.randomUUID();
      return prefix.value ? prefix.value + id.slice(8) : id;
    },
  };
});
const database = useTestDb();
const BASE = '/api/tenant/approval';
const rows = <T>(r: unknown) => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];
async function blocked(db: Db, count: number) {
  for (let i = 0; i < 200; i++) {
    const [row] = rows<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%employment_employees%'`),
    );
    if (row!.n >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('未观察到预期的员工锁等待');
}
async function scene(takeover: boolean) {
  const w = await approvalWorld(database().db, 'f017-handover');
  const s = await transferScene(w);
  await bootstrapTenantAdmin(w.db, { tenantId: w.tenant.id, userId: w.hr.id }, cmd());
  await w.setOrgRoles(s.to, { hrbp: null });
  prefix.value = '00000001';
  const subordinate = await w.person('低序号下属', s.from);
  prefix.value = 'ffffff01';
  const sources = [await w.person('高序号主管甲', s.from), await w.person('高序号主管乙', s.from)];
  prefix.value = '';
  await w.publishedProcess({
    nodes: [
      { key: 'first', name: '调出审批', approver: 'latest_record_department_head' },
      {
        key: 'joint',
        kind: 'countersign',
        name: '最终会签',
        approvers: ['record_department_head', 'record_department_hrbp'],
        transitionRule: { type: 'all' },
      },
    ],
  });
  const config = await w.member('配置管理员');
  const businesses: string[] = [];
  for (const source of sources) {
    const draft = await w.application(source.employeeId, {
      departmentId: s.to,
      addedSubordinateIds: [subordinate.employeeId],
    });
    const submitted = await w.submit(draft);
    const first = submitted.tasks.find((t) => t.status === 'pending')!;
    const view = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, first.id, 'approve', submitted.revision),
    );
    const task = view.tasks.find((t) => t.status === 'pending' && t.assigneeUserId === s.inHead.userId)!;
    await w.json<InstanceView>(await w.taskAction(s.inHead.userId, task.id, 'approve', view.revision));
    businesses.push(draft.id);
  }
  const handover = (actor: string) =>
    w.request(actor, 'POST', `${BASE}/exception-admins/handover`, {
      ifMatch: 0,
      body: { fromUserId: w.exceptionAdmin, toUserId: s.inHead.userId },
    });
  if (takeover) await w.json(await handover(w.hr.id)); // 本人发起被跳过，只指定接管人并替换流程异常管理员。
  const advance = async () => {
    if (!takeover) return w.json(await handover(config));
    const [member] = await withTenant(w.db, w.tenant.id, async (tx) =>
      rows<{ revision: number }>(
        await tx.execute(sql`
      SELECT revision FROM tenant_memberships WHERE tenant_id=${w.tenant.id} AND user_id=${w.exceptionAdmin}::uuid`),
      ),
    );
    return revokeMembership(
      w.db,
      { tenantId: w.tenant.id, userId: w.exceptionAdmin, expectedRevision: member!.revision },
      cmd(),
    );
  };
  return { w, s, subordinate, sources, businesses, advance };
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('F-017 真 PostgreSQL 会签合席批次锁闭包', () => {
  it.each([false, true])('交接/接管=%s 与反向联动强制交错，无实例锁后的低序号补锁', async (takeover) => {
    const { w, s, subordinate, sources, businesses, advance } = await scene(takeover);
    const employee = await w.json<{ revision: number }>(
      await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${subordinate.employeeId}`),
    );
    let advancing: Promise<unknown> | undefined;
    let competing: Promise<Response> | undefined;
    try {
      await withTenant(w.db, w.tenant.id, async (barrier) => {
        await barrier.execute(sql`SELECT id FROM employment_employees WHERE tenant_id=${w.tenant.id}
          AND id=${subordinate.employeeId}::uuid FOR NO KEY UPDATE`);
        advancing = advance();
        await blocked(w.db, 1);
        competing = w.request(
          w.hr.id,
          'POST',
          `/api/tenant/employment/employees/${subordinate.employeeId}/businesses`,
          {
            ifMatch: employee.revision,
            body: {
              kind: 'transfer',
              mode: 'direct',
              effectiveDate: '2026-10-01',
              fields: { departmentId: s.to, addedSubordinateIds: sources.map((p) => p.employeeId) },
            },
          },
        );
        await blocked(w.db, 2);
        // 旧实现已持高序号源员工锁再等下属；这里 NOWAIT 必失败，而新协议尚未锁任何高序号员工。
        for (const source of sources)
          await barrier.execute(sql`SELECT id FROM employment_employees
          WHERE tenant_id=${w.tenant.id} AND id=${source.employeeId}::uuid FOR NO KEY UPDATE NOWAIT`);
      });
      await advancing;
      expect((await competing!).status).toBe(409);
      for (const id of businesses) expect((await w.business(id)).status).toBe('effective');
    } finally {
      await Promise.allSettled([advancing, competing]);
    }
  });
});

it('F-017 会签交接合席确实会落地两笔含下属联动的调动', async () => {
  const { w, businesses, advance } = await scene(false);
  await advance();
  for (const id of businesses) expect((await w.business(id)).status).toBe('effective');
});
