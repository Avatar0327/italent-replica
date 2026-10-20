/**
 * BE-5d2 意向申请的真 PG 并发（AC-RT-20，设计 §2.5 / §11.1；第 1 轮审查 P2-5 返工）。
 * ① 两次同时创建：员工行锁串行，败者 409 RETIREMENT_INTENTION_IN_PROGRESS；
 * ② 部分唯一索引竞争（绕过员工锁的并发写入）：事务 A 插入未办结申请但未提交，HTTP 创建通过“已有未办结”预检后在索引上等待，
 *    A 提交后唯一冲突映射为 409；去掉唯一性（普通索引）本用例必须判红——HTTP 会得到 201，且库里有两张未办结；
 * ③ 同一草稿同时提交与撤回：只有一个生效，终态与审批实例一致。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { intentionWorld, reasonOf } from './AC-RT-intention-support.js';
import { uniqueSuffix } from './support/unique.js';
import { waitForBlocked } from './support/pg-interleave.js';

const database = useTestDb();
const CREATE = (employeeId: string) => `/api/tenant/employment/retirement-intentions/employees/${employeeId}`;

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-RT-20 意向申请并发（真 PG）', () => {
  it('两次同时创建：恰一张成功，另一次 409 RETIREMENT_INTENTION_IN_PROGRESS，库里只有一张未办结', async () => {
    const w = await intentionWorld(database().db, `race-create-${uniqueSuffix()}`);
    const revision = await w.revisionOf();
    const send = (intendedDate: string) =>
      w.request(w.hr.id, 'POST', CREATE(w.subject.employeeId), { ifMatch: revision, body: { intendedDate } });
    const results = await Promise.all([send('2030-03-01'), send('2030-03-02')]);
    expect(results.map((response) => response.status).sort()).toEqual([201, 409]);
    const loser = results.find((response) => response.status === 409)!;
    expect((await reasonOf(loser)).reason).toBe('RETIREMENT_INTENTION_IN_PROGRESS');
    const open = await w.rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM retirement_intentions WHERE tenant_id=${w.tenant.id}
        AND employee_id=${w.subject.employeeId}::uuid AND state IN ('draft','in_review','rejected')`,
    );
    expect(open[0]!.n).toBe(1);
  });

  it('部分唯一索引竞争：第二次写入等待首次提交后撞唯一冲突 → HTTP 409；索引定义不得弱化', async () => {
    const db = database().db;
    const w = await intentionWorld(db, `race-index-${uniqueSuffix()}`);
    const [index] = await w.rows<{ indexdef: string }>(
      sql`SELECT indexdef FROM pg_indexes WHERE indexname='retirement_intentions_open'`,
    );
    expect(index?.indexdef).toMatch(/CREATE UNIQUE INDEX/);
    expect(index?.indexdef).toMatch(/WHERE .*state.*draft.*in_review.*rejected/s);

    let release!: () => void;
    let inserted!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const written = new Promise<void>((resolve) => (inserted = resolve));
    // 事务 A：绕过员工锁直接写一张未办结申请，不提交
    const holder = withTenant(db, w.tenant.id, async (tx) => {
      await tx.execute(sql`INSERT INTO retirement_intentions(id, tenant_id, employee_id, staff_id, intended_date,
          initiator, initiator_user_id, state, revision, command_id)
        VALUES (${randomUUID()}::uuid, ${w.tenant.id}, ${w.subject.employeeId}::uuid, ${randomUUID()}::uuid,
          '2030-01-01'::date, 'hr', ${w.hr.id}::uuid, 'draft', 1, 'fixture')`);
      inserted();
      await gate;
    });
    await written;
    // 事务 B（HTTP）：预检看不到 A 的未提交行，INSERT 在唯一索引上等待
    const pending = w.createRaw({ intendedDate: '2030-03-01' });
    await waitForBlocked(db, 1);
    release();
    await holder;
    const response = await pending;
    expect(await reasonOf(response)).toMatchObject({ status: 409, reason: 'RETIREMENT_INTENTION_IN_PROGRESS' });
    const open = await w.rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM retirement_intentions WHERE tenant_id=${w.tenant.id}
        AND employee_id=${w.subject.employeeId}::uuid AND state IN ('draft','in_review','rejected')`,
    );
    expect(open[0]!.n).toBe(1);
  });

  it('同一草稿同时提交与撤回：只有一个生效，终态与审批实例一致', async () => {
    const w = await intentionWorld(database().db, `race-act-${uniqueSuffix()}`);
    const draft = await w.create({ intendedDate: '2030-03-01' });
    const results = await Promise.all([
      w.actionRaw(draft.id, 'submit', draft.revision),
      w.actionRaw(draft.id, 'withdraw', draft.revision),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    const final = await w.get(draft.id);
    const instances = await w.instanceOfAll(draft.id);
    if (final.status === 'withdrawn') expect(instances.every((item) => item.status !== 'running')).toBe(true);
    else {
      expect(final.status).toBe('in_review');
      expect(instances).toHaveLength(1);
    }
  });
});
