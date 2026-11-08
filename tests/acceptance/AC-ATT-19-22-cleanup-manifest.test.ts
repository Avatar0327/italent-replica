/**
 * F-479 S3 / AC-ATT-19 ～ 22（设计 §2.5、§2.6）：过期清理、清理幂等与失败重试、受保护文件不清理、恢复校验。
 * 全部注入时钟直接调用 runAttachmentCleanup / verifyAttachmentManifest，不睡眠等待；文件走真实 HTTP 登记 / 上传 /
 * 本人申请入口，字节篡改用租户路径删除再写入（app_user 对 attachment_blobs 只有 SELECT / INSERT / DELETE）。
 */
import './support/exit-gate-enforced.js';
import { PgBlobStore } from '../../apps/api/src/modules/attachments/blob-store.js';
import type { AttachmentBlobStore } from '../../apps/api/src/modules/attachments/blob-store.js';
import { runAttachmentCleanup } from '../../apps/api/src/modules/attachments/cleanup.js';
import { startAttachmentCleanupScheduler } from '../../apps/api/src/modules/attachments/cleanup-scheduler.js';
import { verifyAttachmentManifest } from '../../apps/api/src/modules/attachments/manifest.js';
import { rowsOf } from '../../apps/api/src/modules/employment/record-store.js';
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { png, registration, type Receipt } from './AC-ATT-support.js';
import { exitWorld, type ExitWorld } from './AC-ATT-S2-support.js';

const database = useTestDb();
const HOUR = 3_600_000;
const at = (base: string | Date, ms: number) => new Date(new Date(base).getTime() + ms);

interface Row {
  id: string;
  status: string;
  revision: number;
  cleanup_at: string | null;
  created_at: string;
  purged_at: string | null;
  filename: string;
  sha256: string;
  byte_size: number;
}
const fileRow = async (db: Db, tenantId: string, id: string) =>
  rowsOf<Row>(
    await withTenant(db, tenantId, (tx) =>
      tx.execute(sql`SELECT id,status,revision,cleanup_at::text,created_at::text,purged_at::text,
        filename,sha256,byte_size
        FROM attachment_files WHERE tenant_id=${tenantId} AND id=${id}::uuid`),
    ),
  )[0]!;
const attemptRows = async (db: Db, tenantId: string, id: string) =>
  rowsOf<{ kind: string; status: string; attempts: number; reason: string | null; period: string }>(
    await withTenant(db, tenantId, (tx) =>
      tx.execute(sql`SELECT kind,status,attempts,reason,period FROM attachment_cleanup_attempts
        WHERE tenant_id=${tenantId} AND file_id=${id}::uuid ORDER BY kind`),
    ),
  );
const blobBytes = (db: Db, tenantId: string, id: string) =>
  withTenant(db, tenantId, (tx) => PgBlobStore.read(tx, tenantId, id));
const cleanupAudit = async (x: ExitWorld) =>
  (await x.a.auditActions()).filter((row) => /\.(expired|purged)$/.test(row.action));

/** 让 purge 阶段对指定文件抛出注入的存储异常，其余走真实 PgBlobStore。 */
function flakyStore(failing: () => ReadonlySet<string>): AttachmentBlobStore {
  return {
    ...PgBlobStore,
    async remove(tx, tenantId, fileId) {
      if (failing().has(fileId)) throw new Error('注入存储异常');
      return PgBlobStore.remove(tx, tenantId, fileId);
    },
  };
}

describe('AC-ATT-19 临时文件 24h 后转待清理，再过 1h 删字节', () => {
  it('24h 内不变；之后 pending_cleanup 且本人读不到；宽限 1h 内字节仍在；再过 1h 字节删除、purged、元数据保留；审计两条', async () => {
    const { db } = database();
    const x = await exitWorld(db, 'att19');
    const tenantId = x.w.tenant.id;
    const me = await x.a.person('合成本人甲');
    const uploaded = await x.a.stored(me, png(3, 3), '手写甲.png');
    const t0 = new Date(uploaded.uploadedAt!);
    const run = (at: Date, store?: AttachmentBlobStore) =>
      runAttachmentCleanup({ db, clock: () => at, tenantId, ...(store ? { store } : {}) });

    await run(at(t0, 24 * HOUR - 60_000));
    expect(await fileRow(db, tenantId, uploaded.id)).toMatchObject({ status: 'uploaded', revision: uploaded.revision });
    expect(await blobBytes(db, tenantId, uploaded.id)).not.toBeNull();
    expect(await cleanupAudit(x)).toHaveLength(0);

    const expireAt = at(t0, 24 * HOUR + 1000);
    await run(expireAt);
    const expired = await fileRow(db, tenantId, uploaded.id);
    expect(expired).toMatchObject({ status: 'pending_cleanup', revision: uploaded.revision + 1 });
    expect(new Date(expired.cleanup_at!).getTime()).toBe(expireAt.getTime());
    expect((await x.a.meta(me, uploaded.id)).status).toBe(404);
    expect((await x.a.content(me, uploaded.id)).status).toBe(404);
    expect(await blobBytes(db, tenantId, uploaded.id)).not.toBeNull();

    await run(at(expireAt, HOUR - 60_000));
    expect((await fileRow(db, tenantId, uploaded.id)).status).toBe('pending_cleanup');
    expect(await blobBytes(db, tenantId, uploaded.id)).not.toBeNull();

    const purgeAt = at(expireAt, HOUR + 1000);
    await run(purgeAt);
    const purged = await fileRow(db, tenantId, uploaded.id);
    expect(purged).toMatchObject({ status: 'purged', filename: '手写甲.png', sha256: uploaded.sha256 });
    expect(purged.byte_size).toBe(uploaded.byteSize);
    expect(new Date(purged.purged_at!).getTime()).toBe(purgeAt.getTime());
    expect(await blobBytes(db, tenantId, uploaded.id)).toBeNull();
    expect((await x.a.content(me, uploaded.id)).status).toBe(404);

    const audit = await cleanupAudit(x);
    expect(audit.map((row) => row.action)).toEqual(['attachment.file.expired', 'attachment.file.purged']);
    expect(audit.every((row) => row.object_type === 'attachment_file')).toBe(true);
    expect(JSON.stringify(audit)).not.toContain('base64');
    const events = (await x.a.outboxEvents()).map((row) => row.event_type);
    expect(events.filter((event) => /\.(expired|purged)$/.test(event))).toEqual([
      'attachment.file.expired',
      'attachment.file.purged',
    ]);
    expect((await attemptRows(db, tenantId, uploaded.id)).map((r) => [r.kind, r.status, r.attempts])).toEqual([
      ['expire', 'succeeded', 1],
      ['purge', 'succeeded', 1],
    ]);
  });

  it('只登记没上传的 registered 文件按登记时间满 24h 同样回收；本人删除的 pending_cleanup 满 1h 后删字节', async () => {
    const { db } = database();
    const x = await exitWorld(db, 'att19b');
    const tenantId = x.w.tenant.id;
    const me = await x.a.person('合成本人乙');
    const bytes = png(4, 4);
    const registered = (await x.w.json<Receipt>(await x.a.register(me, registration(bytes)), 201)) as Receipt;
    const base = new Date((await fileRow(db, tenantId, registered.id)).created_at);
    const deleted = await x.a.stored(me, png(5, 5), '手写乙.png');
    expect((await x.a.remove(me, deleted.id, deleted.revision)).status).toBe(200);
    const removedAt = new Date((await fileRow(db, tenantId, deleted.id)).cleanup_at!);

    const sweep = (offset: number) => runAttachmentCleanup({ db, clock: () => at(base, offset), tenantId });
    // 本人删除的文件宽限内不删字节；登记未上传的文件未满 24h 不回收
    await sweep(HOUR - 60_000);
    expect((await fileRow(db, tenantId, deleted.id)).status).toBe('pending_cleanup');
    expect(await blobBytes(db, tenantId, deleted.id)).not.toBeNull();
    await sweep(2 * HOUR);
    expect((await fileRow(db, tenantId, deleted.id)).status).toBe('purged');
    expect(await blobBytes(db, tenantId, deleted.id)).toBeNull();
    expect(new Date((await fileRow(db, tenantId, deleted.id)).purged_at!).getTime()).toBeGreaterThan(
      removedAt.getTime(),
    );
    await sweep(24 * HOUR - 60_000);
    expect((await fileRow(db, tenantId, registered.id)).status).toBe('registered');
    await sweep(24 * HOUR + 1000);
    expect((await fileRow(db, tenantId, registered.id)).status).toBe('pending_cleanup');
  });

  it('跨租户 fail-closed：只指定租户 A 时，租户 B 的过期文件不动；不指定租户时各租户各自清理', async () => {
    const { db } = database();
    const a = await exitWorld(db, 'att19c1');
    const b = await exitWorld(db, 'att19c2');
    const fileA = await a.a.stored(await a.a.person('合成本人丙'), png(3, 4));
    const fileB = await b.a.stored(await b.a.person('合成本人丁'), png(3, 5));
    const later = at(new Date(fileA.uploadedAt!), 25 * HOUR);

    await runAttachmentCleanup({ db, clock: () => later, tenantId: a.w.tenant.id });
    expect((await fileRow(db, a.w.tenant.id, fileA.id)).status).toBe('pending_cleanup');
    expect((await fileRow(db, b.w.tenant.id, fileB.id)).status).toBe('uploaded');
    expect((await b.a.auditActions()).filter((row) => row.action.endsWith('.expired'))).toHaveLength(0);

    const all = await runAttachmentCleanup({ db, clock: () => later });
    expect(all.runs.map((r) => r.tenantId)).toContain(b.w.tenant.id);
    expect((await fileRow(db, b.w.tenant.id, fileB.id)).status).toBe('pending_cleanup');
    // 租户 B 的行不会借租户 A 的事务被看到：在 A 的租户路径里查 B 的文件为空
    const seen = await withTenant(db, a.w.tenant.id, (tx) =>
      tx.execute(sql`SELECT id FROM attachment_files WHERE id=${fileB.id}::uuid`),
    );
    expect(rowsOf(seen)).toHaveLength(0);
  });
});

describe('AC-ATT-20 清理幂等；单条失败记 failed、次数、原因，下轮成功', () => {
  it('重复执行无额外变化；注入存储异常的那条记 failed 且不拖累其他条，修好后下一轮成功', async () => {
    const { db } = database();
    const x = await exitWorld(db, 'att20');
    const tenantId = x.w.tenant.id;
    const me = await x.a.person('合成本人戊');
    const bad = await x.a.stored(me, png(3, 3), '坏.png');
    const good = await x.a.stored(me, png(4, 3), '好.png');
    const t0 = new Date(bad.uploadedAt!);
    let failing = new Set([bad.id]);
    const store = flakyStore(() => failing);
    const run = (offsetMs: number) => runAttachmentCleanup({ db, clock: () => at(t0, offsetMs), tenantId, store });

    await run(25 * HOUR);
    await run(25 * HOUR); // 重复执行：过期阶段无额外变化
    expect((await fileRow(db, tenantId, bad.id)).status).toBe('pending_cleanup');
    const afterExpire = await fileRow(db, tenantId, bad.id);
    expect(afterExpire.revision).toBe(bad.revision + 1);
    expect((await cleanupAudit(x)).filter((row) => row.action.endsWith('.expired'))).toHaveLength(2);

    const first = await run(27 * HOUR);
    expect(first.runs[0]!.outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fileId: bad.id, kind: 'purge', state: 'failed' }),
        expect.objectContaining({ fileId: good.id, kind: 'purge', state: 'succeeded' }),
      ]),
    );
    expect(await fileRow(db, tenantId, bad.id)).toMatchObject({
      status: 'pending_cleanup',
      revision: afterExpire.revision,
    });
    expect(await blobBytes(db, tenantId, bad.id)).not.toBeNull();
    expect((await fileRow(db, tenantId, good.id)).status).toBe('purged');
    const purgeAttempt = async (id: string) => (await attemptRows(db, tenantId, id)).find((r) => r.kind === 'purge')!;
    expect(await purgeAttempt(bad.id)).toMatchObject({ status: 'failed', attempts: 1 });
    expect((await purgeAttempt(bad.id)).reason).toContain('注入存储异常');

    await run(27 * HOUR + 15 * 60_000); // 仍失败：次数累加
    expect(await purgeAttempt(bad.id)).toMatchObject({ status: 'failed', attempts: 2 });

    failing = new Set();
    await run(27 * HOUR + 30 * 60_000); // 下轮成功
    expect(await fileRow(db, tenantId, bad.id)).toMatchObject({ status: 'purged' });
    expect(await blobBytes(db, tenantId, bad.id)).toBeNull();
    expect(await purgeAttempt(bad.id)).toMatchObject({ status: 'succeeded', attempts: 3, reason: null });

    const settled = await Promise.all([bad.id, good.id].map((id) => fileRow(db, tenantId, id)));
    const auditCount = (await cleanupAudit(x)).length;
    expect(auditCount).toBe(4); // 每个文件各一条 expired + 一条 purged，重复执行不新增
    const rerun = await run(30 * HOUR);
    expect(rerun.runs.flatMap((r) => r.outcomes)).toEqual([]);
    expect(await Promise.all([bad.id, good.id].map((id) => fileRow(db, tenantId, id)))).toEqual(settled);
    expect((await cleanupAudit(x)).length).toBe(auditCount);
    expect(await purgeAttempt(bad.id)).toMatchObject({ attempts: 3 });
  });
});

describe('AC-ATT-21 已绑定、已封存、detached 的文件过 TTL 不被清理', () => {
  it('草稿里的未封存引用、已封存引用、已封存后被移除的 detached：30 天后仍原样；同时间点的未绑定临时文件被清理', async () => {
    const { db } = database();
    const x = await exitWorld(db, 'att21');
    const tenantId = x.w.tenant.id;
    const me = await x.a.person('合成本人己');
    const [keep, drop, extra] = await x.uploads(me, 3);
    const stray = await x.a.stored(me, png(9, 9), '游离.png');
    const { draft, instance, task } = await x.submitted(me, [keep!.id, drop!.id]);
    await x.w.taskAction(x.approver.userId, task.id, 'reject', instance.revision, { comment: '补充' });
    const returned = await x.read(me, draft.id);
    const saved = await x.w.json<{ revision: number }>(
      await x.patch(me, returned, { attachmentRefs: [keep!.id, extra!.id] }),
    );
    expect(saved.revision).toBeGreaterThan(returned.revision);
    const before = {
      keep: await x.fileState(keep!.id),
      drop: await x.fileState(drop!.id),
      extra: await x.fileState(extra!.id),
    };
    expect(before.keep).toMatchObject({ status: 'bound' });
    expect(before.keep.sealed_at).not.toBeNull();
    expect(before.drop).toMatchObject({ status: 'detached' });
    expect(before.extra).toMatchObject({ status: 'bound', sealed_at: null });

    const later = at(new Date(keep!.uploadedAt!), 30 * 24 * HOUR);
    const result = await runAttachmentCleanup({ db, clock: () => later, tenantId });
    await runAttachmentCleanup({ db, clock: () => at(later, 2 * HOUR), tenantId });

    expect(await x.fileState(keep!.id)).toEqual(before.keep);
    expect(await x.fileState(drop!.id)).toEqual(before.drop);
    expect(await x.fileState(extra!.id)).toEqual(before.extra);
    for (const file of [keep!, drop!, extra!]) {
      expect(await blobBytes(db, tenantId, file.id)).not.toBeNull();
      expect(await attemptRows(db, tenantId, file.id)).toEqual([]);
    }
    // 对照：同一轮里游离的临时文件确实被清理，说明任务跑了而不是空转
    expect((await fileRow(db, tenantId, stray.id)).status).toBe('purged');
    expect(result.runs.flatMap((r) => r.outcomes).map((o) => o.fileId)).toEqual([stray.id]);
  });
});

describe('AC-ATT-22 verifyAttachmentManifest', () => {
  it('篡改一条、截短一条、缺字节一条：报告逐条列出并置不可读，完好的不动；重复校验无额外变化', async () => {
    const { db } = database();
    const x = await exitWorld(db, 'att22');
    const tenantId = x.w.tenant.id;
    const me = await x.a.person('合成本人庚');
    const [ok, tampered, shortened, missing] = await x.uploads(me, 4);
    const tamper = (id: string, next: (bytes: Uint8Array) => Uint8Array | null) =>
      withTenant(db, tenantId, async (tx) => {
        const current = (await PgBlobStore.read(tx, tenantId, id))!;
        await PgBlobStore.remove(tx, tenantId, id);
        const changed = next(current);
        if (changed) await PgBlobStore.put(tx, tenantId, id, changed);
      });
    await tamper(tampered!.id, (bytes) => Uint8Array.from(bytes, (b, i) => (i === bytes.length - 1 ? b ^ 0xff : b)));
    await tamper(shortened!.id, (bytes) => bytes.slice(0, bytes.length - 1));
    await tamper(missing!.id, () => null);

    const now = new Date('2026-12-01T03:00:00.000Z');
    const report = await withTenant(db, tenantId, (tx) => verifyAttachmentManifest(tx, tenantId, { now }));
    expect(report.checked).toBe(4);
    expect([...report.corrupted].sort((l, r) => l.fileId.localeCompare(r.fileId))).toEqual(
      [
        { fileId: tampered!.id, problem: 'hash_mismatch' },
        { fileId: shortened!.id, problem: 'size_mismatch' },
        { fileId: missing!.id, problem: 'missing' },
      ].sort((l, r) => l.fileId.localeCompare(r.fileId)),
    );

    for (const bad of [tampered!, shortened!, missing!]) {
      expect(await fileRow(db, tenantId, bad.id)).toMatchObject({ status: 'pending_cleanup' });
      expect((await x.a.content(me, bad.id)).status).toBe(404);
      expect((await x.a.meta(me, bad.id)).status).toBe(404);
    }
    expect((await fileRow(db, tenantId, ok!.id)).status).toBe('uploaded');
    expect((await x.a.content(me, ok!.id)).status).toBe(200);
    const quarantined = (await x.a.auditActions()).filter((row) => row.action === 'attachment.file.quarantine');
    expect(quarantined).toHaveLength(3);
    expect(JSON.stringify(quarantined)).not.toContain('base64');

    const again = await withTenant(db, tenantId, (tx) => verifyAttachmentManifest(tx, tenantId, { now }));
    expect(again).toEqual({ checked: 1, corrupted: [] });
    expect((await x.a.auditActions()).filter((row) => row.action === 'attachment.file.quarantine')).toHaveLength(3);
  });

  it('已封存、已绑定与 detached 的文件同样校验；封存文件被置不可读后清理任务不删它的字节', async () => {
    const { db } = database();
    const x = await exitWorld(db, 'att22b');
    const tenantId = x.w.tenant.id;
    const me = await x.a.person('合成本人辛');
    const [sealed] = await x.uploads(me, 1);
    await x.submitted(me, [sealed!.id]);
    await withTenant(db, tenantId, async (tx) => {
      await PgBlobStore.remove(tx, tenantId, sealed!.id);
      await PgBlobStore.put(
        tx,
        tenantId,
        sealed!.id,
        Uint8Array.from(png(2, 2), (b, i) => (i === 20 ? b ^ 1 : b)),
      );
    });
    const report = await withTenant(db, tenantId, (tx) => verifyAttachmentManifest(tx, tenantId));
    expect(report.corrupted).toEqual([{ fileId: sealed!.id, problem: 'hash_mismatch' }]);
    expect((await x.fileState(sealed!.id)).status).toBe('pending_cleanup');
    expect((await x.fileState(sealed!.id)).sealed_at).not.toBeNull();

    await runAttachmentCleanup({ db, clock: () => at(new Date(), 400 * 24 * HOUR), tenantId });
    expect((await x.fileState(sealed!.id)).status).toBe('pending_cleanup');
    expect(await blobBytes(db, tenantId, sealed!.id)).not.toBeNull();
  });

  it('跨租户 fail-closed：在租户 A 的事务里按租户 B 的编号校验，看不到也改不了 B 的文件', async () => {
    const { db } = database();
    const a = await exitWorld(db, 'att22c1');
    const b = await exitWorld(db, 'att22c2');
    const fileB = await b.a.stored(await b.a.person('合成本人壬'), png(6, 6));
    await withTenant(db, b.w.tenant.id, async (tx) => {
      await PgBlobStore.remove(tx, b.w.tenant.id, fileB.id);
    });
    const report = await withTenant(db, a.w.tenant.id, (tx) => verifyAttachmentManifest(tx, b.w.tenant.id));
    expect(report).toEqual({ checked: 0, corrupted: [] });
    expect((await fileRow(db, b.w.tenant.id, fileB.id)).status).toBe('uploaded');
    await expect(withTenant(db, a.w.tenant.id, (tx) => verifyAttachmentManifest(tx, 'not-a-uuid'))).rejects.toThrow();
  });
});

describe('调度器接入（设计 §2.5 执行方式）', () => {
  it('启动即跑一轮、stop 等待在途轮次结束；按注入时钟清理，存储失败经 onError 上报；间隔下限 1000ms', async () => {
    const { db } = database();
    const x = await exitWorld(db, 'att23');
    const tenantId = x.w.tenant.id;
    const me = await x.a.person('合成本人癸');
    const file = await x.a.stored(me, png(7, 7));
    const t0 = new Date(file.uploadedAt!);
    const errors: unknown[] = [];

    const first = startAttachmentCleanupScheduler(db, {
      intervalMs: 3_600_000,
      clock: () => at(t0, 25 * HOUR),
      onError: (error) => errors.push(error),
    });
    await first.stop();
    expect((await fileRow(db, tenantId, file.id)).status).toBe('pending_cleanup');

    const failing = startAttachmentCleanupScheduler(db, {
      intervalMs: 3_600_000,
      clock: () => at(t0, 27 * HOUR),
      store: flakyStore(() => new Set([file.id])),
      onError: (error) => errors.push(error),
    });
    await failing.stop();
    expect((await fileRow(db, tenantId, file.id)).status).toBe('pending_cleanup');
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('附件清理失败');

    const ok = startAttachmentCleanupScheduler(db, { intervalMs: 3_600_000, clock: () => at(t0, 28 * HOUR) });
    await ok.stop();
    expect((await fileRow(db, tenantId, file.id)).status).toBe('purged');

    expect(() => startAttachmentCleanupScheduler(db, { intervalMs: 999 })).toThrow(RangeError);
  });
});
