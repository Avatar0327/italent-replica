/**
 * AC-SC-01 并发（R3-T05 A2，设计 §7、R4-02；真 PostgreSQL 16——PGlite 单连接无法并发）：
 * 锁序 目标锁行 → 记录行（升序）下，写入口之间不死锁、不 500，结果只落在契约列出的几种：
 * - 同一目标同一继任者同一区间并发新增：恰好一个 201，另一个 409 SUCCESSION_DUPLICATE；
 * - 批量结束的记录顺序相反（[A,B] 与 [B,A]）并发：不死锁，一个 200，另一个 409（ALREADY_ENDED / REVISION_CONFLICT）；
 * - 批量结束 [A,B] 与删除 B 并发：不死锁、不 500，库里没有半结束的状态（A、B 要么都结束，要么 B 被删而整批 404）；
 * - 跨目标锁序：两个请求结束不同的记录集合、共同覆盖组织与职位两个目标，并控制双方先占不同目标的交错——
 *   去掉目标锁行升序后会交叉取锁而死锁；
 * - 确定性的失败回查重放：同键同 revision 两个编辑排队，先到者提交，后到者因 revision 变化失败后回查台账，返回相同结果，审计一次；
 * - 同一条记录同一 revision 并发编辑：一个 200，另一个 409 REVISION_CONFLICT；
 * - 任职交错（审查第 1 轮 P2-1）：办理离职与新增继任者排队等同一员工行锁，离职先提交；新增拿到锁后必须重读资格——
 *   400 SUCCESSOR_NOT_ACTIVE，不落生效记录（状态与 FOR SHARE 分开两条语句）。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { type SuccessionWorld, successionWorld } from './AC-SC-support.js';
import { rowsOf } from './support/f048.js';
import { waitForBlocked } from './support/pg-interleave.js';

const testDb = useTestDb();
const pg = describe.runIf(Boolean(process.env.TEST_DATABASE_URL));
type Failure = { error: { code: string; details?: { reason?: string } } };
const reasonOf = async (response: Response) => {
  const { error } = (await response.clone().json()) as Failure;
  return error.details?.reason ?? error.code;
};

pg('AC-SC-01 写入口并发（真 PG）', () => {
  let w: SuccessionWorld;
  let std: Awaited<ReturnType<SuccessionWorld['standard']>>;
  let seq = 0;

  beforeAll(async () => {
    w = await successionWorld(testDb().db, 'sc-write-pg');
    std = await w.standard();
  });

  const seed = async () => {
    const hired = await w.hire(`并发继任者${++seq}`, { departmentId: std.orgB.id });
    return w.insertRecord({ type: 'org', targetId: std.orgA.id, successorId: hired.id });
  };
  const end = (ids: string[]) =>
    w.request('POST', '/records/end', {
      body: { items: ids.map((id) => ({ id, expectedRevision: 1 })), endDate: '2026-09-30' },
    });
  const endDates = async (ids: string[]) =>
    rowsOf<{ id: string; end_date: string; deleted: boolean }>(
      await w.asTenant((tx) =>
        tx.execute(sql`SELECT id, end_date::text AS end_date, deleted_at IS NOT NULL AS deleted
          FROM succession_records WHERE id = ANY(${`{${ids.join(',')}}`}::uuid[])`),
      ),
    );

  it('同一区间并发新增：恰好一个 201，另一个 409 SUCCESSION_DUPLICATE', async () => {
    const hired = await w.hire(`并发新增${++seq}`, { departmentId: std.orgB.id });
    const body = {
      successionType: 'org',
      targetOrgId: std.orgA.id,
      successorEmployeeId: hired.id,
      startDate: '2026-09-01',
    };
    const results = await Promise.all([
      w.request('POST', '/records', { body }),
      w.request('POST', '/records', { body }),
    ]);
    const statuses = results.map((response) => response.status).sort();
    expect(statuses).toEqual([201, 409]);
    const loser = results.find((response) => response.status === 409)!;
    expect(await reasonOf(loser)).toBe('SUCCESSION_DUPLICATE');
  });

  it('批量结束的记录顺序相反并发：不死锁，一个 200，另一个 409', async () => {
    const [a, b] = [await seed(), await seed()];
    const results = await Promise.all([end([a, b]), end([b, a])]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    const loser = results.find((response) => response.status === 409)!;
    expect(['ALREADY_ENDED', 'REVISION_CONFLICT']).toContain(await reasonOf(loser));
    for (const row of await endDates([a, b])) expect(row.end_date).toBe('2026-09-30');
  });

  it('批量结束 [A,B] 与删除 B 并发：不死锁、不 500，没有半结束状态', async () => {
    const [a, b] = [await seed(), await seed()];
    const results = await Promise.all([end([a, b]), w.request('DELETE', `/records/${b}`, { ifMatch: 1 })]);
    for (const response of results) expect([200, 404, 409], await response.clone().text()).toContain(response.status);
    const rows = new Map((await endDates([a, b])).map((row) => [row.id, row]));
    const bothEnded = rows.get(a)!.end_date === '2026-09-30' && rows.get(b)!.end_date === '2026-09-30';
    const bDeleted = rows.get(b)!.deleted;
    // 要么两条都结束（删除排在后面，B 因 revision 已变 409 或在结束后被删），要么 B 先被删、整批 404 而 A 未结束
    expect(bothEnded || (bDeleted && rows.get(a)!.end_date !== '2026-09-30')).toBe(true);
  });

  /** 持有目标锁行（与写入口同一把锁）的事务：释放前其他请求在该目标上排队。 */
  const holdTargetLock = async (kind: 'org' | 'position', targetId: string) => {
    let locked!: () => void;
    let release!: () => void;
    const lockedSignal = new Promise<void>((resolve) => (locked = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const done = withTenant(w.db, w.tenant.id, async (tx) => {
      await tx.execute(sql`INSERT INTO succession_target_locks (tenant_id, target_kind, target_id)
        VALUES (${w.tenant.id}::uuid, ${kind}, ${targetId}::uuid) ON CONFLICT DO NOTHING`);
      await tx.execute(sql`SELECT 1 FROM succession_target_locks
        WHERE tenant_id = ${w.tenant.id}::uuid AND target_kind = ${kind} AND target_id = ${targetId}::uuid FOR UPDATE`);
      locked();
      await gate;
    });
    await lockedSignal;
    return async () => {
      release();
      await done;
    };
  };

  it('跨目标锁序（审查 P3）：两个请求结束不同记录集合、共同覆盖组织与职位两个目标，双方先占不同目标也不死锁', async () => {
    // 记录 ID 的大小决定无锁读出目标的顺序（按主键索引）：请求 1 先见组织目标，请求 2 先见职位目标——
    // 去掉目标排序就会交叉取锁
    const ids = ['00000001', '00000002', '00000003', '00000004'].map((head) => `${head}-0000-4000-8000-00000000cafe`);
    const hire = async () => (await w.hire(`跨目标${++seq}`, { departmentId: std.orgB.id })).id;
    const orgTarget = { type: 'org', targetId: std.orgA.id } as const;
    const posTarget = { type: 'position', targetId: std.keyPosition.id } as const;
    const a1 = await w.insertRecord({ ...orgTarget, id: ids[0], successorId: await hire() });
    const b1 = await w.insertRecord({ ...posTarget, id: ids[1], successorId: await hire() });
    const b2 = await w.insertRecord({ ...posTarget, id: ids[2], successorId: await hire() });
    const a2 = await w.insertRecord({ ...orgTarget, id: ids[3], successorId: await hire() });
    const releaseOrg = await holdTargetLock('org', std.orgA.id);
    const releasePosition = await holdTargetLock('position', std.keyPosition.id);
    const first = end([a1, b1]);
    await waitForBlocked(w.db, 1);
    const second = end([b2, a2]);
    await waitForBlocked(w.db, 2);
    // 先放开职位目标：若实现按“先见到的目标”取锁，请求 2 此时拿到职位锁并等组织锁；按升序取锁则两者仍都卡在第一把锁上
    await releasePosition();
    await new Promise((resolve) => setTimeout(resolve, 400));
    await releaseOrg();
    const results = await Promise.all([first, second]);
    expect(results.map((response) => response.status)).toEqual([200, 200]);
    for (const row of await endDates([a1, b1, a2, b2])) expect(row.end_date).toBe('2026-09-30');
  });

  it('确定性的失败回查重放（审查 P3）：同键同 revision 两个编辑排队，后到者因 revision 变化失败后回查台账，返回相同结果、审计一次', async () => {
    const id = await seed();
    const release = await holdTargetLock('org', std.orgA.id);
    const key = crypto.randomUUID();
    const edit = () =>
      w.request('PUT', `/records/${id}`, { ifMatch: 1, idempotencyKey: key, body: { backupType: 'deputy' } });
    const results = [edit(), edit()];
    await waitForBlocked(w.db, 2);
    await release();
    const [one, two] = await Promise.all(results);
    expect([one!.status, two!.status]).toEqual([200, 200]);
    const bodies = [(await one!.json()) as { revision: number }, (await two!.json()) as { revision: number }];
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]!.revision).toBe(2);
    const audits = rowsOf<{ n: number }>(
      await w.asTenant((tx) =>
        tx.execute(sql`SELECT count(*)::int AS n FROM audit_events
          WHERE object_id = ${id} AND action = 'succession.record.update'`),
      ),
    );
    expect(audits[0]!.n).toBe(1);
  });

  it('同一 revision 并发编辑：一个 200，另一个 409 REVISION_CONFLICT', async () => {
    const id = await seed();
    const edit = (backupType: string) => w.request('PUT', `/records/${id}`, { ifMatch: 1, body: { backupType } });
    const results = await Promise.all([edit('deputy'), edit('principal')]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    const loser = results.find((response) => response.status === 409)!;
    expect((await loser.json()) as Failure).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
  });

  it('任职交错：办理离职与新增继任者排队等同一员工行锁，离职先提交后新增必须重读资格 → 400，不落生效记录', async () => {
    const hired = await w.hire(`交错${++seq}`, {}, '2026-08-01');
    const detail = (await (await w.call('GET', `employment/employees/${hired.id}`)).json()) as { revision: number };
    let locked!: () => void;
    let release!: () => void;
    const lockedSignal = new Promise<void>((resolve) => (locked = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    // 持有员工行锁，让后面两个请求按顺序排队：先离职（FOR NO KEY UPDATE），再新增继任者（FOR SHARE，排在离职之后）
    const holding = withTenant(w.db, w.tenant.id, async (tx) => {
      await tx.execute(sql`SELECT id FROM employment_employees WHERE id = ${hired.id}::uuid FOR NO KEY UPDATE`);
      locked();
      await gate;
    });
    await lockedSignal;
    const leaving = w.call('POST', `employment/employees/${hired.id}/businesses`, {
      ifMatch: detail.revision,
      body: { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-01', fields: {} },
    });
    await waitForBlocked(w.db, 1);
    const creating = w.request('POST', '/records', {
      body: {
        successionType: 'org',
        targetOrgId: std.orgA.id,
        successorEmployeeId: hired.id,
        startDate: '2026-09-01',
      },
    });
    await waitForBlocked(w.db, 2);
    release();
    await holding;
    expect((await leaving).status).toBe(201);
    const response = await creating;
    expect([response.status, await reasonOf(response)]).toEqual([400, 'SUCCESSOR_NOT_ACTIVE']);
    const rows = rowsOf<{ n: number }>(
      await w.asTenant((tx) =>
        tx.execute(
          sql`SELECT count(*)::int AS n FROM succession_records WHERE successor_employee_id = ${hired.id}::uuid`,
        ),
      ),
    );
    expect(rows[0]!.n).toBe(0);
  });
});
