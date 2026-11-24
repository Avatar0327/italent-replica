/**
 * F-326-L §3.1 / §3.3 / §5.4（S7e1 返工，审查 P2-1）：发布中段的变量锁集合 = 被替换版本引用的全部自动变量 ∪ 草稿待生效变量，
 * 按 id 升序一批取 FOR UPDATE；集合为空则不取。旧实现只锁待生效项，且没有待生效项就直接返回，
 * 旧版独有的变量（新版不再引用）发布时没有被锁住，与保存收尾 / 管理员停用交错时没有互斥。
 * 强制交错（PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行）：另一事务先持有变量行 FOR UPDATE，
 * 发布必须在这行上等待、放行后成功；与旧版无关的变量被占用时，发布不等待（不多锁）。
 */
import { sql, withTenant, type Tx } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import type { NodeInput } from './AC-APV-support.js';
import {
  audits,
  autoAt,
  create,
  dispatch,
  draftOk,
  manager,
  newVersion,
  peopleOf,
  publishWith,
  readProcess,
  s4World,
  specified,
  varRow,
  type S4World,
} from './AC-APV-F326-S7a-support.js';
import { settledOrBlocked, withHeldLock } from './support/pg-interleave.js';

const database = useTestDb();
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);

const single = (key: string, userId: string): NodeInput => ({ key, name: `节点${key}`, approver: specified(userId) });
const viaManager = (key: string): NodeInput => ({ key, name: `节点${key}`, approver: manager });

/** 另一事务持有变量行 FOR UPDATE（不提交），期间执行 body；放锁后再返回 body 的结果。 */
function holdingVariable<T>(w: S4World, variableId: string, body: (release: () => Promise<void>) => Promise<T>) {
  return withHeldLock(
    {
      run: (fn) => withTenant(w.db, w.tenant.id, fn),
      take: (tx: Tx) =>
        tx.execute(sql`SELECT id FROM approval_variables
          WHERE tenant_id=${w.tenant.id}::uuid AND id=${variableId}::uuid FOR UPDATE`),
    },
    async (held) => body(held.release),
  );
}

/** 唯一在等锁的会话，其语句确实在 approval_variables 上等（而不是别处），且有阻塞者。 */
async function expectWaitingOnVariable(w: S4World) {
  const waiting = rowsOf<{ query: string; blockers: number }>(
    await w.db.execute(sql`SELECT query, cardinality(pg_blocking_pids(pid)) AS blockers FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'`),
  );
  expect(waiting).toHaveLength(1);
  expect(waiting[0]!.query).toMatch(/approval_variables/i);
  expect(waiting[0]!.blockers).toBeGreaterThan(0);
}

describe.runIf(realPostgres)('AC-APV-F326-54 发布中段锁集合含被替换版本引用的自动变量（真 PG 强制交错）', () => {
  it('无待生效项：旧版独有的 X 被另一事务持有 → 发布在 X 上等待，放行后 200，新版生效', async () => {
    const w = await s4World(database().db, 's7e1-54-publish-old-only');
    const a = await w.publish(await create(w, [single('n1', w.near.userId)]));
    const x = await autoAt(w, a.id, 'n1');
    // 旧版保留一单在途，新版本不引用 X 时仍应保持启用。
    await dispatch(w);
    // 新版不再引用 X（改走直属上级），草稿里没有任何待生效项
    const saved = await draftOk(w, await newVersion(w, a), [viaManager('n1')]);

    await holdingVariable(w, x.id, async (release) => {
      const publishing = publishWith(w, saved);
      expect(await settledOrBlocked(w.db, publishing, 1)).toBe('blocked');
      await expectWaitingOnVariable(w);
      await release();
      const done = await publishing;
      expect(done.status, await done.clone().text()).toBe(200);
    });

    expect((await readProcess(w, a.id)).currentVersion!.id).toBe(saved.latestVersion.id);
    expect((await varRow(w, x.id)).status).toBe('enabled');
    expect(await audits(w, a.id, 'approval.process.publish')).toHaveLength(2);
  });

  it('有待生效项：旧版独有的 X 被另一事务持有 → 发布仍在 X 上等待（锁集合是并集，不只是待生效的 Y），放行后 Y 落成', async () => {
    const w = await s4World(database().db, 's7e1-54-publish-union');
    const other = await w.person('合成设计器改选人', w.staff);
    const a = await w.publish(await create(w, [single('n1', w.head.userId), single('n2', w.near.userId)]));
    const x = await autoAt(w, a.id, 'n1');
    const y = await autoAt(w, a.id, 'n2');
    // 新版：n1 不再引用 X（旧版独有）；n2 改选他人 → Y 有待生效值
    const saved = await draftOk(w, await newVersion(w, a), [viaManager('n1'), single('n2', other.userId)]);

    await holdingVariable(w, x.id, async (release) => {
      const publishing = publishWith(w, saved);
      expect(await settledOrBlocked(w.db, publishing, 1)).toBe('blocked');
      await expectWaitingOnVariable(w);
      await release();
      const done = await publishing;
      expect(done.status, await done.clone().text()).toBe(200);
    });

    expect(peopleOf(await varRow(w, y.id))).toEqual([other.userId]);
    expect((await readProcess(w, a.id)).currentVersion!.id).toBe(saved.latestVersion.id);
  });

  it('对照：被占用的是与本流程无关的变量 Q → 发布不等待，直接 200（锁集合不多锁）', async () => {
    const w = await s4World(database().db, 's7e1-54-publish-unrelated');
    const a = await w.publish(await create(w, [single('n1', w.near.userId)]));
    const stranger = await w.publish(await create(w, [single('n1', w.head.userId)], { name: '无关流程' }));
    const q = await autoAt(w, stranger.id, 'n1');
    const saved = await draftOk(w, await newVersion(w, a), [viaManager('n1')]);

    await holdingVariable(w, q.id, async () => {
      const publishing = publishWith(w, saved);
      expect(await settledOrBlocked(w.db, publishing, 1)).toBe('settled');
      const done = await publishing;
      expect(done.status, await done.clone().text()).toBe(200);
    });
  });
});
