/** AC-SC-02 真 PG：员工 → 目标 → 记录行锁，与 A2 编辑 / 新增串行，无死锁和半写。 */
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { waitForBlocked, withRelease } from './support/pg-interleave.js';
import { exitWorld, runner, type ExitWorld } from './AC-SC-02-support.js';

const testDb = useTestDb();
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-SC-02 离职与编辑交错（PG）', () => {
  let w: ExitWorld;
  beforeAll(async () => {
    w = await exitWorld(testDb().db, 'sc-exit-pg');
    await runner(w);
  });
  async function hold(kind: 'employee' | 'org' | 'position', id: string) {
    // 先提交锁行，避免两个 INSERT 在同一未提交唯一键上等醒后争抢，保证断言的先后顺序。
    if (kind !== 'employee')
      await w.asTenant((tx) =>
        tx.execute(sql`
      INSERT INTO succession_target_locks (tenant_id,target_kind,target_id)
      VALUES (${w.tenant.id}::uuid,${kind},${id}::uuid) ON CONFLICT DO NOTHING`),
      );
    let ready!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((r) => (ready = r));
    const gate = new Promise<void>((r) => (release = r));
    const done = w.asTenant(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout='10s'`);
      if (kind === 'employee') {
        await tx.execute(sql`SELECT id FROM employment_employees WHERE id=${id}::uuid FOR NO KEY UPDATE`);
      } else {
        await tx.execute(sql`SELECT 1 FROM succession_target_locks
          WHERE tenant_id=${w.tenant.id}::uuid AND target_kind=${kind} AND target_id=${id}::uuid FOR UPDATE`);
      }
      ready();
      await gate;
    });
    await locked;
    return async () => {
      release();
      await done;
    };
  }
  it.each(['exit_first', 'edit_first', 'sweep_first'] as const)('%s：等待目标锁后重读修订与状态', async (order) => {
    const e = await w.hire();
    const type = order === 'sweep_first' ? 'org' : 'position';
    const id = await w.seedRecord(e.id, type);
    if (order === 'sweep_first') await w.leave(e);
    const release = await hold(type, type === 'org' ? w.targetOrg.id : w.targetPosition.id);
    w.setNow('2026-10-02T01:00:00Z');
    const edit = () => w.request('PUT', `/records/${id}`, { ifMatch: 1, body: { backupType: 'deputy' } });
    const exit = () =>
      order === 'sweep_first'
        ? w.sweep('2026-10-02T01:00:00Z')
        : w.requestEmployment('POST', `/employees/${e.id}/businesses`, {
            ifMatch: e.revision,
            body: { kind: 'leave', mode: 'direct', lastWorkDate: '2026-10-01' },
          });
    const first = order === 'edit_first' ? edit() : exit();
    let second!: ReturnType<typeof edit> | ReturnType<typeof exit>;
    await withRelease(release, async (cleanup) => {
      cleanup.track(first);
      await waitForBlocked(w.db, 1);
      second = order === 'edit_first' ? cleanup.track(exit()) : cleanup.track(edit());
      await waitForBlocked(w.db, 2);
    });
    const [a, b] = await Promise.all([first, second]);
    const editResult = (order === 'edit_first' ? a : b) as Response;
    expect(editResult.status, await editResult.clone().text()).toBe(order === 'edit_first' ? 200 : 409);
    if (order !== 'edit_first') {
      expect(await editResult.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
    }
    if (order !== 'sweep_first') expect(((order === 'edit_first' ? b : a) as Response).status).toBe(201);
    expect(await w.read(id)).toMatchObject({
      end_source: 'exit',
      end_date: '2026-10-02',
      revision: order === 'edit_first' ? 3 : 2,
      backup_type: order === 'edit_first' ? 'deputy' : 'principal',
    });
  });
  it('离职先持员工锁，新增等待后重读资格：400 SUCCESSOR_NOT_ACTIVE，没有新增记录', async () => {
    const e = await w.hire();
    const existing = await w.seedRecord(e.id);
    const release = await hold('employee', e.id);
    w.setNow('2026-10-02T01:00:00Z');
    const exit = w.requestEmployment('POST', `/employees/${e.id}/businesses`, {
      ifMatch: e.revision,
      body: { kind: 'leave', mode: 'direct', lastWorkDate: '2026-10-01' },
    });
    let added!: Promise<Response>;
    await withRelease(release, async (cleanup) => {
      cleanup.track(exit);
      await waitForBlocked(w.db, 1);
      const { tenantApi } = await import('./support/tenant-api.js');
      const api = tenantApi(w.db, { clock: () => new Date('2026-10-02T01:00:00Z') });
      added = cleanup.track(
        api.request('POST', '/api/tenant/succession/records', {
          user: w.user.id,
          tenant: w.tenant.id,
          body: {
            successionType: 'org',
            targetOrgId: w.targetOrg.id,
            successorEmployeeId: e.id,
            startDate: '2026-10-01',
          },
        }),
      );
      await waitForBlocked(w.db, 2);
    });
    expect((await exit).status).toBe(201);
    const rejected = await added;
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: { details: { reason: 'SUCCESSOR_NOT_ACTIVE' } } });
    expect(await w.read(existing)).toMatchObject({ end_source: 'exit', revision: 2 });
  });
});
