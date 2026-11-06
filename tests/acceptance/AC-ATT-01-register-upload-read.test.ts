import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Person } from './AC-APV-support.js';
import { ATTACHMENTS, attachmentWorld, png, registration, sha256, type Receipt } from './AC-ATT-support.js';

const database = useTestDb();
let a: Awaited<ReturnType<typeof attachmentWorld>>;
let other: Awaited<ReturnType<typeof attachmentWorld>>;
let actor: Person;
let colleague: Person;

beforeAll(async () => {
  a = await attachmentWorld(database().db, 'att-a');
  other = await attachmentWorld(database().db, 'att-b');
  actor = await a.person('测试员工甲');
  colleague = await a.person('测试员工乙');
});

describe('AC-ATT-01 登记 → 上传 → 读元数据与内容', () => {
  it('员工登记并上传合法 PNG：回执顶层有 id / revision / kind，无 base64；内容与哈希一致，响应头防内联', async () => {
    const bytes = png();
    const registered = await a.w.json<Receipt>(await a.register(actor, registration(bytes)), 201);
    expect(registered).toMatchObject({
      kind: 'attachment_file',
      revision: 1,
      status: 'registered',
      purpose: 'exit.handwritten_application',
      filename: 'note.png',
      byteSize: bytes.length,
      sha256: sha256(bytes),
    });
    expect(registered.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(registered).not.toHaveProperty('base64');

    // registered 只给元数据，内容 404
    expect((await a.meta(actor, registered.id)).status).toBe(200);
    expect((await a.content(actor, registered.id)).status).toBe(404);

    const uploaded = await a.w.json<Receipt>(await a.upload(actor, registered.id, bytes, registered.revision), 200);
    expect(uploaded).toMatchObject({ id: registered.id, kind: 'attachment_file', status: 'uploaded', revision: 2 });
    expect(uploaded.contentType).toBe('image/png');
    expect(uploaded.expiresAt).toBeTruthy();
    expect(uploaded.uploadedAt).toBeTruthy();
    expect(uploaded).not.toHaveProperty('base64');

    const meta = await a.meta(actor, registered.id);
    expect(meta.headers.get('cache-control')).toBe('private, no-store');
    expect(await a.w.json<Receipt>(meta)).toMatchObject({ id: registered.id, status: 'uploaded', revision: 2 });

    const content = await a.content(actor, registered.id);
    expect(content.status).toBe(200);
    const body = Buffer.from(await content.arrayBuffer());
    expect(body.equals(bytes)).toBe(true);
    expect(sha256(body)).toBe(registered.sha256);
    expect(content.headers.get('content-type')).toBe('image/png');
    expect(content.headers.get('x-content-type-options')).toBe('nosniff');
    expect(content.headers.get('cache-control')).toBe('private, no-store');
    expect(content.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(content.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(content.headers.get('content-disposition')).toMatch(
      /^attachment; filename="note\.png"; filename\*=UTF-8''note\.png$/,
    );
    expect(content.headers.get('content-length')).toBe(String(bytes.length));
  });

  it('同一内容请求去掉 X-Tenant-Id → 400 TENANT_CONTEXT_REQUIRED', async () => {
    const receipt = await a.stored(actor, png());
    for (const path of [`${ATTACHMENTS}/${receipt.id}`, `${ATTACHMENTS}/${receipt.id}/content`]) {
      const res = await a.api.request('GET', path, { user: actor.userId });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('TENANT_CONTEXT_REQUIRED');
    }
  });

  it('含中文文件名的下载头带 filename* 编码，ASCII 回退名不含引号与非 ASCII', async () => {
    const bytes = png();
    const registered = await a.w.json<Receipt>(await a.register(actor, registration(bytes, '手写申请"一".png')), 201);
    await a.w.json(await a.upload(actor, registered.id, bytes, registered.revision), 200);
    const disposition = (await a.content(actor, registered.id)).headers.get('content-disposition')!;
    expect(disposition).toBe(
      `attachment; filename="_______.png"; filename*=UTF-8''${encodeURIComponent('手写申请"一".png')}`,
    );
  });
});

describe('AC-ATT-07 非本人与跨租户 fail-closed', () => {
  it('同租户员工乙读、删甲的临时文件 → 404，不泄露元数据；甲自己仍可读', async () => {
    const mine = await a.stored(actor, png());
    for (const res of [await a.meta(colleague, mine.id), await a.content(colleague, mine.id)]) {
      expect(res.status).toBe(404);
      expect(JSON.stringify(await res.json())).not.toContain('note.png');
    }
    expect((await a.remove(colleague, mine.id, mine.revision)).status).toBe(404);
    expect((await a.upload(colleague, mine.id, png(), mine.revision)).status).toBe(404);
    expect((await a.meta(actor, mine.id)).status).toBe(200);
    expect((await a.fileRows()).find((r) => r.id === mine.id)).toMatchObject({ status: 'uploaded' });
  });

  it('租户 2 的员工读、删、传租户 1 的文件 → 404；随机 UUID 与非 UUID', async () => {
    const mine = await a.stored(actor, png());
    const foreign = await other.person('测试员工丙');
    for (const res of [
      await other.meta(foreign, mine.id),
      await other.content(foreign, mine.id),
      await other.remove(foreign, mine.id, mine.revision),
      await other.upload(foreign, mine.id, png(), mine.revision),
      await other.meta(foreign, randomUUID()),
    ])
      expect(res.status).toBe(404);
    expect((await other.meta(foreign, 'not-a-uuid')).status).toBe(400);
    // 租户 1 的行仍在，租户 2 看不到
    expect((await other.fileRows()).length).toBe(0);
    expect((await a.fileRows()).some((r) => r.id === mine.id)).toBe(true);
  });

  it('删除：本人可删 registered / uploaded（revision 不符 409），删除后元数据与内容 404，字节不再可读', async () => {
    const mine = await a.stored(actor, png());
    expect((await a.remove(actor, mine.id, mine.revision + 5)).status).toBe(409);
    const removed = await a.w.json<Receipt>(await a.remove(actor, mine.id, mine.revision), 200);
    expect(removed).toMatchObject({ id: mine.id, kind: 'attachment_file', status: 'pending_cleanup' });
    expect((await a.meta(actor, mine.id)).status).toBe(404);
    expect((await a.content(actor, mine.id)).status).toBe(404);
    expect((await a.remove(actor, mine.id, removed.revision)).status).toBe(404);
  });

  it('所有写入口需同源：跨站来源 403', async () => {
    const res = await a.api.request('POST', ATTACHMENTS, {
      ...a.w.as(actor.userId),
      body: registration(png()),
      headers: { origin: 'https://evil.example.com' },
    });
    expect(res.status).toBe(403);
  });
});

describe('AC-ATT-25 登记响应丢失后的恢复', () => {
  it('登记成功后丢弃响应 → 命令结果接口 succeeded 且 businessType / businessId / revision → 同键同体重发返回同一 id，只有一行', async () => {
    const mine = await a.person('测试员工丁');
    const body = registration(png(), 'lost.png');
    const key = randomUUID();
    const first = await a.register(mine, body, key); // 故意不读响应体
    expect(first.status).toBe(201);
    const result = await a.w.json<{ status: string; businessType: string; businessId: string; revision: number }>(
      await a.api.request('GET', `/api/tenant/commands/${key}/result`, a.w.as(mine.userId)),
    );
    expect(result).toMatchObject({ status: 'succeeded', businessType: 'attachment_file', revision: 1 });
    const replay = await a.w.json<Receipt>(await a.register(mine, body, key), 201);
    expect(replay.id).toBe(result.businessId);
    expect(await a.fileRows(mine.userId)).toHaveLength(1);
    // 同键异体 409
    const changed = await a.register(mine, registration(png(), 'other.png'), key);
    expect(changed.status).toBe(409);
    expect(await a.fileRows(mine.userId)).toHaveLength(1);
  });
});

describe('AC-ATT-25 登记事务提交前失败（结果未知）后同键重发', () => {
  it('注入失败 → 5xx 且无行 → 同键重发成功，最终只有一行', async () => {
    const mine = await a.person('测试员工戊');
    const body = registration(png(), 'inject-fail.png');
    const key = randomUUID();
    const db = database().db;
    // 放行表为空时，该文件名的插入失败（登记事务在提交前失败）；放行后正常。表不存在时跳过装配（红灯阶段走 404 断言）。
    await db.execute(sql`CREATE TABLE IF NOT EXISTS att_inject_allow (ok boolean)`);
    await db.execute(sql`DELETE FROM att_inject_allow`);
    await db.execute(sql`
      DO $$ BEGIN
        IF to_regclass('attachment_files') IS NOT NULL THEN
          CREATE OR REPLACE FUNCTION att_inject_fail() RETURNS trigger LANGUAGE plpgsql AS $f$
          BEGIN
            IF NEW.filename = 'inject-fail.png' AND NOT EXISTS (SELECT 1 FROM att_inject_allow) THEN
              RAISE EXCEPTION 'injected failure';
            END IF;
            RETURN NEW;
          END $f$;
          DROP TRIGGER IF EXISTS att_inject_fail ON attachment_files;
          CREATE TRIGGER att_inject_fail BEFORE INSERT ON attachment_files
            FOR EACH ROW EXECUTE FUNCTION att_inject_fail();
        END IF;
      END $$`);
    try {
      expect((await a.register(mine, body, key)).status).toBeGreaterThanOrEqual(500);
      expect(await a.fileRows(mine.userId)).toHaveLength(0);
      await db.execute(sql`INSERT INTO att_inject_allow VALUES (true)`);
      const replay = await a.w.json<Receipt>(await a.register(mine, body, key), 201);
      expect(replay.status).toBe('registered');
      expect(await a.fileRows(mine.userId)).toHaveLength(1);
    } finally {
      await db.execute(sql`DROP TRIGGER IF EXISTS att_inject_fail ON attachment_files`).catch(() => undefined);
      await db.execute(sql`DROP TABLE IF EXISTS att_inject_allow`);
    }
  });
});

describe('AC-ATT-01 审计与 outbox 与业务写同一事务，不含字节', () => {
  it('登记 / 上传 / 删除各写一条 attachment.file.*，快照不含 base64', async () => {
    const mine = await a.person('测试员工己');
    const receipt = await a.stored(mine, png(), 'audit.png');
    await a.remove(mine, receipt.id, receipt.revision);
    const actions = await a.auditActions();
    const names = actions.map((row) => row.action);
    for (const expected of ['attachment.file.register', 'attachment.file.upload', 'attachment.file.delete'])
      expect(names).toContain(expected);
    for (const row of actions) {
      expect(row.object_type).toBe('attachment_file');
      expect(JSON.stringify(row.after)).not.toMatch(/base64|iVBOR/);
    }
  });
});
