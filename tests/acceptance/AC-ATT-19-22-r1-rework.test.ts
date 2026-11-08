/**
 * F-479 S3 第 1 轮返工（审查 P2-1～3，针对 82409d6b4）：
 * P2-1 恢复隔离件不得被清理任务自动删字节；P2-2 失败记录与回报不带 SQL / 参数 / 文件内容；
 * P2-3 迟到的失败记录不得覆盖成功记录（真 PG 屏障测试）。关联 AC-ATT-20、AC-ATT-22。
 */
import './support/exit-gate-enforced.js';
import { PgBlobStore } from '../../apps/api/src/modules/attachments/blob-store.js';
import type { AttachmentBlobStore } from '../../apps/api/src/modules/attachments/blob-store.js';
import { runAttachmentCleanup } from '../../apps/api/src/modules/attachments/cleanup.js';
import { startAttachmentCleanupScheduler } from '../../apps/api/src/modules/attachments/cleanup-scheduler.js';
import { verifyAttachmentManifest } from '../../apps/api/src/modules/attachments/manifest.js';
import { rowsOf } from '../../apps/api/src/modules/employment/record-store.js';
import { sql, withTenant, type Db, type Tx } from '@italent/db';
import { testDbMode, useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { png } from './AC-ATT-support.js';
import { exitWorld } from './AC-ATT-S2-support.js';

const database = useTestDb();
const HOUR = 3_600_000;
const at = (base: string | Date, ms: number) => new Date(new Date(base).getTime() + ms);
const SENSITIVE = ['Failed query', 'delete from', 'attachment_blobs_missing', 'PARAM-SECRET', 'CONTENT-FRAGMENT'];

const statusOf = async (db: Db, tenantId: string, id: string) =>
  rowsOf<{ status: string }>(
    await withTenant(db, tenantId, (tx) =>
      tx.execute(sql`SELECT status FROM attachment_files WHERE tenant_id=${tenantId} AND id=${id}::uuid`),
    ),
  )[0]!.status;
const attempts = async (db: Db, tenantId: string, id: string) =>
  rowsOf<{ kind: string; status: string; attempts: number; reason: string | null }>(
    await withTenant(db, tenantId, (tx) =>
      tx.execute(sql`SELECT kind,status,attempts,reason FROM attachment_cleanup_attempts
        WHERE tenant_id=${tenantId} AND file_id=${id}::uuid ORDER BY kind`),
    ),
  );
const bytesOf = (db: Db, tenantId: string, id: string) =>
  withTenant(db, tenantId, (tx) => PgBlobStore.read(tx, tenantId, id));
const corrupt = (db: Db, tenantId: string, id: string) =>
  withTenant(db, tenantId, async (tx) => {
    const current = (await PgBlobStore.read(tx, tenantId, id))!;
    await PgBlobStore.remove(tx, tenantId, id);
    await PgBlobStore.put(
      tx,
      tenantId,
      id,
      Uint8Array.from(current, (b, i) => (i === current.length - 1 ? b ^ 1 : b)),
    );
  });

describe('R1 P2-1 恢复隔离件不被自动删字节（AC-ATT-22 / AC-ATT-21）', () => {
  it('已绑定但未封存的草稿附件损坏 → 隔离 → 推进时钟清理 → 仍不可读、字节保留、无 purged 事件；正常解绑的照常回收', async () => {
    const { db } = database();
    const x = await exitWorld(db, 'att-r1-1');
    const tenantId = x.w.tenant.id;
    const me = await x.a.person('合成本人子');
    const [damaged, kept, unbound] = await x.uploads(me, 3);
    const draft = await x.createDraft(me, [damaged!.id, kept!.id, unbound!.id]);
    const saved = await x.w.json<{ revision: number }>(
      await x.patch(me, draft, { attachmentRefs: [damaged!.id, kept!.id] }),
    );
    expect(saved.revision).toBeGreaterThan(draft.revision);
    expect(await x.fileState(damaged!.id)).toMatchObject({ status: 'bound', sealed_at: null });
    expect((await x.fileState(unbound!.id)).status).toBe('pending_cleanup'); // 正常解绑：仍保留 business_id

    await corrupt(db, tenantId, damaged!.id);
    const now = new Date('2026-12-01T03:00:00.000Z');
    const report = await withTenant(db, tenantId, (tx) => verifyAttachmentManifest(tx, tenantId, { now }));
    expect(report.corrupted).toEqual([{ fileId: damaged!.id, problem: 'hash_mismatch' }]);
    expect((await x.a.content(me, damaged!.id)).status).toBe(404);

    await runAttachmentCleanup({ db, clock: () => at(now, 5 * HOUR), tenantId });
    await runAttachmentCleanup({ db, clock: () => at(now, 400 * 24 * HOUR), tenantId });

    expect((await x.fileState(damaged!.id)).status).toBe('pending_cleanup');
    expect(await bytesOf(db, tenantId, damaged!.id)).not.toBeNull();
    expect((await x.a.content(me, damaged!.id)).status).toBe(404);
    expect(await attempts(db, tenantId, damaged!.id)).toEqual([]);
    // 整个租户里只有“正常解绑”那一件产生 purged 事件，隔离件没有
    const purged = (await x.a.auditActions()).filter((row) => row.action === 'attachment.file.purged');
    expect(purged).toHaveLength(1);
    // 对照：正常解绑的未封存文件满 1h 后照常回收，说明排除的是“隔离件”而不是 business_id 非空的文件
    expect((await x.fileState(unbound!.id)).status).toBe('purged');
    expect(await bytesOf(db, tenantId, unbound!.id)).toBeNull();
    expect((await x.fileState(kept!.id)).status).toBe('bound');
  });
});

describe('R1 P2-2 失败记录与回报不带 SQL / 参数 / 内容（AC-ATT-20）', () => {
  it('数据库驱动错误与带文件内容的异常：attempts.reason、outcome.error、调度器 onError 都只含白名单码', async () => {
    const { db } = database();
    const x = await exitWorld(db, 'att-r1-2');
    const tenantId = x.w.tenant.id;
    const me = await x.a.person('合成本人丑');
    const [sqlFail, contentFail] = await x.uploads(me, 2);
    const t0 = new Date(sqlFail!.uploadedAt!);
    const store: AttachmentBlobStore = {
      ...PgBlobStore,
      async remove(tx: Tx, tid, fileId) {
        // 真实的驱动错误：Failed query: <SQL> + params，正是 DrizzleQueryError 的形态
        if (fileId === sqlFail!.id)
          await tx.execute(sql`delete from attachment_blobs_missing where marker = ${'PARAM-SECRET'}`);
        if (fileId === contentFail!.id) throw new Error('写入失败，片段 CONTENT-FRAGMENT-89504e47');
        return PgBlobStore.remove(tx, tid, fileId);
      },
    };
    await runAttachmentCleanup({ db, clock: () => at(t0, 25 * HOUR), tenantId });
    const run = await runAttachmentCleanup({ db, clock: () => at(t0, 27 * HOUR), tenantId, store });
    const outcomes = run.runs.flatMap((r) => r.outcomes);
    expect(outcomes.map((o) => [o.fileId, o.state]).sort()).toEqual(
      [
        [sqlFail!.id, 'failed'],
        [contentFail!.id, 'failed'],
      ].sort(),
    );

    const reported: unknown[] = [];
    const scheduler = startAttachmentCleanupScheduler(db, {
      intervalMs: 3_600_000,
      clock: () => at(t0, 28 * HOUR),
      store,
      onError: (error) => reported.push(error),
    });
    await scheduler.stop();
    expect(reported.length).toBeGreaterThan(0);

    const rows = [...(await attempts(db, tenantId, sqlFail!.id)), ...(await attempts(db, tenantId, contentFail!.id))];
    const purgeRows = rows.filter((r) => r.kind === 'purge');
    expect(purgeRows).toHaveLength(2);
    for (const row of purgeRows) {
      expect(row.status).toBe('failed');
      expect(row.reason).toMatch(/^(blob_delete_failed|db_error|unknown)\b/);
    }
    const everything = JSON.stringify([
      rows,
      outcomes,
      reported.map((e) => String(e)),
      reported.map((e) => (e as Error).stack),
    ]);
    for (const fragment of SENSITIVE) expect(everything).not.toContain(fragment);
  });
});

/** 给查询构造器套一层：被 await 完成后先执行 hook，再把结果交还调用方（用来在“读之后、写之前”插入屏障）。 */
function afterAwait<T extends object>(builder: T, hook: () => Promise<void>): T {
  return new Proxy(builder, {
    get(target, prop) {
      if (prop === 'then')
        return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(target)
            .then(async (value) => {
              await hook();
              return value;
            })
            .then(resolve, reject);
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const next = (value as (...a: unknown[]) => unknown).apply(target, args);
        return next && typeof next === 'object' ? afterAwait(next, hook) : next;
      };
    },
  });
}

type Interleave = { at: 'start' } | { at: 'after-first-select' };

/**
 * 代理 db：实例 A 的存储抛错（armed）之后，在它“记失败”的事务里按 at 指定的位置先执行 hook。
 * start = 事务开始前；after-first-select = 该事务的第一条 select 返回之后（读到状态、尚未写入）。
 */
function interleavedDb(db: Db, mode: Interleave, hook: () => Promise<void>) {
  const state = { armed: false };
  const proxied = new Proxy(db, {
    get(target, prop) {
      if (prop !== 'transaction') {
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (cb: (tx: Tx) => Promise<unknown>, ...rest: unknown[]) => {
        const fire = state.armed;
        if (fire) state.armed = false;
        if (fire && mode.at === 'start') await hook();
        const wrapped = async (tx: Tx) => {
          let pending = fire && mode.at === 'after-first-select';
          const spy = new Proxy(tx, {
            get(inner, key) {
              const value = Reflect.get(inner, key, inner) as unknown;
              if (key !== 'select' || !pending || typeof value !== 'function') {
                return typeof value === 'function' ? value.bind(inner) : value;
              }
              return (...args: unknown[]) => {
                pending = false;
                return afterAwait((value as (...a: unknown[]) => object).apply(inner, args), hook);
              };
            },
          });
          return cb(spy);
        };
        return (target.transaction as (...a: unknown[]) => Promise<unknown>).call(target, wrapped, ...rest);
      };
    },
  });
  return { proxied, state };
}

const failingStore = (state: { armed: boolean }): AttachmentBlobStore => ({
  ...PgBlobStore,
  async remove() {
    state.armed = true;
    throw new Error('实例 A 的存储异常');
  },
});

async function pendingPurgeWorld(db: Db, suffix: string) {
  const x = await exitWorld(db, suffix);
  const tenantId = x.w.tenant.id;
  const me = await x.a.person('合成本人寅');
  const file = await x.a.stored(me, png(3, 3), '迟到失败.png');
  const t0 = new Date(file.uploadedAt!);
  await runAttachmentCleanup({ db, clock: () => at(t0, 25 * HOUR), tenantId });
  expect(await statusOf(db, tenantId, file.id)).toBe('pending_cleanup');
  return { tenantId, file, purgeTime: at(t0, 27 * HOUR) };
}

/** 文件状态与尝试记录必须一致：purged ⇔ purge 记录为 succeeded，且字节已删；不能是“已删 + 失败”。 */
async function expectAgree(db: Db, tenantId: string, id: string) {
  const status = await statusOf(db, tenantId, id);
  const purge = (await attempts(db, tenantId, id)).find((r) => r.kind === 'purge');
  if (status === 'purged') {
    expect(purge).toMatchObject({ status: 'succeeded', attempts: 1, reason: null });
    expect(await bytesOf(db, tenantId, id)).toBeNull();
  } else {
    expect(purge?.status ?? 'failed').toBe('failed');
    expect(await bytesOf(db, tenantId, id)).not.toBeNull();
  }
  return status;
}

describe.skipIf(testDbMode() !== 'pg')('R1 P2-3 迟到的失败记录不覆盖成功记录（真 PG 屏障，AC-ATT-20）', () => {
  it('A 清理失败回滚；A 记失败时读到状态后、写入前，B 完成清理并提交 → 成功记录不被覆盖，状态与记录一致', async () => {
    const { db } = database();
    const { tenantId, file, purgeTime } = await pendingPurgeWorld(db, 'att-r1-3a');
    let instanceB: Promise<unknown> = Promise.resolve();
    const { proxied, state } = interleavedDb(db, { at: 'after-first-select' }, async () => {
      instanceB = runAttachmentCleanup({ db, clock: () => purgeTime, tenantId });
      // 修复后 A 持有文件行锁，B 会跳过该行而不会推进；修复前 B 不受阻，会在 A 写入前提交
      await Promise.race([instanceB, new Promise((resolve) => setTimeout(resolve, 1500))]);
    });
    const result = await runAttachmentCleanup({
      db: proxied,
      clock: () => purgeTime,
      tenantId,
      store: failingStore(state),
    });
    await instanceB;

    const status = await expectAgree(db, tenantId, file.id);
    // 不论 B 与 A 谁先办成，对外报告也不能出现“文件已删但记失败”的自相矛盾
    if (status === 'purged') expect(result.runs.flatMap((r) => r.outcomes).map((o) => o.state)).not.toContain('failed');
  });

  it('B 持文件行锁期间 A 的失败记录必须等锁（与正常推进串行），放锁后重读状态不写失败', async () => {
    const { db } = database();
    const { tenantId, file, purgeTime } = await pendingPurgeWorld(db, 'att-r1-3b');
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockedFlag = new Promise<void>((resolve) => (locked = resolve));
    let instanceB: Promise<void> = Promise.resolve();
    const stamp = purgeTime.toISOString();
    const { proxied, state } = interleavedDb(db, { at: 'start' }, async () => {
      instanceB = withTenant(db, tenantId, async (tx) => {
        await tx.execute(
          sql`SELECT id FROM attachment_files WHERE tenant_id=${tenantId} AND id=${file.id}::uuid FOR UPDATE`,
        );
        locked();
        await hold;
        await PgBlobStore.remove(tx, tenantId, file.id);
        await tx.execute(sql`UPDATE attachment_files SET status='purged', purged_at=${stamp}::timestamptz,
          revision=revision+1 WHERE tenant_id=${tenantId} AND id=${file.id}::uuid`);
        await tx.execute(sql`INSERT INTO attachment_cleanup_attempts
          (tenant_id,file_id,kind,period,status,attempts,updated_at)
          VALUES (${tenantId},${file.id}::uuid,'purge','2026-12-01','succeeded',1,${stamp}::timestamptz)`);
      });
      await lockedFlag;
    });
    const instanceA = runAttachmentCleanup({
      db: proxied,
      clock: () => purgeTime,
      tenantId,
      store: failingStore(state),
    });
    let phase: string;
    try {
      phase = await Promise.race([
        instanceA.then(() => 'done'),
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 800)),
      ]);
    } finally {
      release();
    }
    await instanceB;
    const result = await instanceA;

    expect(phase).toBe('blocked');
    expect(result.runs.flatMap((r) => r.outcomes)).toEqual([]);
    expect(await expectAgree(db, tenantId, file.id)).toBe('purged');
  });
});
