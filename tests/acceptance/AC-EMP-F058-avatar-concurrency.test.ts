/**
 * AC-EMP（补）/ F-058：真实 PostgreSQL 用成员行锁强制写请求交错，验证 revision、幂等与撤成员边界。
 * 未设置 TEST_DATABASE_URL 时明确跳过：PGlite 单连接无法证明真实事务锁等待，不能将跳过当作并发通过。
 */
import { randomUUID } from 'node:crypto';
import { createUser, type Db, grantMembership, revokeMembership, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { imageFixture } from './AC-TC-model-image-support.js';
import { cmd, seedTenantWithMember, tenantApi, type RequestOptions } from './support/tenant-api.js';

const testDb = useTestDb();
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);
const BASE = '/api/tenant/account/avatar';

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function json<T>(response: Promise<Response> | Response, status = 200): Promise<T> {
  const resolved = await response;
  expect(resolved.status, await resolved.clone().text()).toBe(status);
  return (await resolved.json()) as T;
}

/** 以数据库实际锁等待为屏障；请求提前完成是错误，不按固定延迟猜事务已进入。 */
async function waitForBlocked(db: Db, count: number, finished: () => boolean) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (finished()) throw new Error('头像写请求未等待真实成员行锁或命令锁便已结束');
    const result = await db.execute(sql`SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'`);
    if (rowsOf<{ count: number }>(result)[0]!.count >= count) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error(`未观测到 ${count} 个头像事务实际等待锁`);
}

async function scene(label: string) {
  const db = testDb().db;
  const { tenant, user: admin } = await seedTenantWithMember(db, label);
  const owner = await createUser(
    db,
    { email: `${randomUUID()}@example.com`, displayName: '合成头像成员' },
    cmd(admin.id),
  );
  await grantMembership(db, { tenantId: tenant.id, userId: owner.id, expectedRevision: 0 }, cmd(admin.id));
  const api = tenantApi(db, { authorize: undefined });
  const request = (method: string, path: string, options: RequestOptions = {}) =>
    api.request(method, path, { ...options, user: owner.id, tenant: tenant.id });
  expect(await json(request('GET', BASE))).toEqual({ revision: 1, name: owner.displayName, avatar: null });
  return { db, tenant, admin, owner, request };
}

async function holdMember(db: Db, tenantId: string, userId: string) {
  const acquired = signal();
  const release = signal();
  const complete = withTenant(db, tenantId, async (tx) => {
    const result = await tx.execute(sql`SELECT user_id FROM tenant_memberships
      WHERE tenant_id=${tenantId} AND user_id=${userId}::uuid FOR UPDATE`);
    expect(rowsOf(result)).toHaveLength(1);
    acquired.resolve();
    await release.promise;
  });
  await Promise.race([
    acquired.promise,
    complete.then(() => {
      throw new Error('成员行锁未到持锁屏障');
    }),
  ]);
  return { complete, release: release.resolve };
}

async function evidence(db: Db, tenantId: string, userId: string, commandIds: readonly string[]) {
  return withTenant(db, tenantId, async (tx) => ({
    audit: rowsOf(
      await tx.execute(sql`SELECT action, "before", "after", changes FROM audit_events
        WHERE tenant_id=${tenantId} AND object_type='Account.Avatar' AND object_id=${userId}`),
    ),
    ledger: rowsOf(
      await tx.execute(sql`SELECT command_id, response_status, response_body FROM command_ledger
        WHERE tenant_id=${tenantId} AND command_id=ANY(${`{${commandIds.join(',')}}`}::text[])`),
    ),
  }));
}

async function avatarSnapshot(db: Db, tenantId: string) {
  return withTenant(db, tenantId, async (tx) => ({
    settings: rowsOf(
      await tx.execute(sql`SELECT row_to_json(s) AS data FROM account_avatar_settings s
        WHERE tenant_id=${tenantId}`),
    ),
    attachments: rowsOf(
      await tx.execute(sql`SELECT row_to_json(a) AS data FROM account_avatar_attachments a
        WHERE tenant_id=${tenantId} ORDER BY id`),
    ),
  }));
}

describe.skipIf(!realPostgres)(
  realPostgres
    ? 'AC-EMP（补）F-058 PostgreSQL 真实交错'
    : 'AC-EMP（补）F-058 PostgreSQL 真实交错（未设 TEST_DATABASE_URL，PGlite 单连接不支持锁交错）',
  () => {
    it('两个 revision=1 登记均进入锁等待，释放后仅一次 201，另一请求 409且无第二次审计', async () => {
      const s = await scene('f058-pg-revision');
      const keys = [randomUUID(), randomUUID()] as const;
      const fixtures = [imageFixture(), imageFixture('bmp')] as const;
      const gate = await holdMember(s.db, s.tenant.id, s.owner.id);
      let finished = false;
      const first = s
        .request('POST', `${BASE}/attachments`, {
          ifMatch: 1,
          body: fixtures[0].metadata,
          idempotencyKey: keys[0],
        })
        .finally(() => {
          finished = true;
        });
      const second = s
        .request('POST', `${BASE}/attachments`, {
          ifMatch: 1,
          body: fixtures[1].metadata,
          idempotencyKey: keys[1],
        })
        .finally(() => {
          finished = true;
        });
      try {
        await waitForBlocked(s.db, 2, () => finished);
        gate.release();
        await gate.complete;
        const results = await Promise.all([first, second]);
        expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
        const success = results.find((result) => result.status === 201)!;
        const conflict = results.find((result) => result.status === 409)!;
        expect(await conflict.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
        const body = await success.json();
        expect(body).toMatchObject({ revision: 2, attachment: { status: 'registered' } });
        expect(await json(s.request('GET', BASE))).toEqual({ revision: 2, name: s.owner.displayName, avatar: null });
        const snapshot = await avatarSnapshot(s.db, s.tenant.id);
        expect(snapshot.settings).toHaveLength(1);
        expect(snapshot.attachments).toHaveLength(1);
        const after = await evidence(s.db, s.tenant.id, s.owner.id, keys);
        expect(after.audit).toHaveLength(1);
        expect(after.ledger).toHaveLength(1);
      } finally {
        gate.release();
        await Promise.allSettled([gate.complete, first, second]);
      }
    });

    it('同命令并发登记均进入锁等待，释放后同响应；附件、成功审计与命令台账各只有一条', async () => {
      const s = await scene('f058-pg-idempotency');
      const key = randomUUID();
      const options = { ifMatch: 1, body: imageFixture().metadata, idempotencyKey: key };
      const gate = await holdMember(s.db, s.tenant.id, s.owner.id);
      let finished = false;
      const write = () =>
        s.request('POST', `${BASE}/attachments`, options).finally(() => {
          finished = true;
        });
      const first = write();
      const second = write();
      try {
        await waitForBlocked(s.db, 2, () => finished);
        gate.release();
        await gate.complete;
        const [left, right] = await Promise.all([first, second]);
        expect([left.status, right.status]).toEqual([201, 201]);
        expect(await left.json()).toEqual(await right.json());
        expect(await json(s.request('GET', BASE))).toEqual({ revision: 2, name: s.owner.displayName, avatar: null });
        expect((await avatarSnapshot(s.db, s.tenant.id)).attachments).toHaveLength(1);
        const after = await evidence(s.db, s.tenant.id, s.owner.id, [key]);
        expect(after.audit).toHaveLength(1);
        expect(after.ledger).toHaveLength(1);
      } finally {
        gate.release();
        await Promise.allSettled([gate.complete, first, second]);
      }
    });

    it('管理员撤成员先排队，本人上传后排队；撤权提交后上传403且不关联图片、不记成功审计', async () => {
      const s = await scene('f058-pg-revoke');
      const fixture = imageFixture();
      const registered = await json<{ revision: number; attachment: { id: string } }>(
        s.request('POST', `${BASE}/attachments`, { ifMatch: 1, body: fixture.metadata }),
        201,
      );
      const before = await avatarSnapshot(s.db, s.tenant.id);
      const uploadKey = randomUUID();
      const gate = await holdMember(s.db, s.tenant.id, s.owner.id);
      let revokeFinished = false;
      let uploadFinished = false;
      const revoke = revokeMembership(
        s.db,
        { tenantId: s.tenant.id, userId: s.owner.id, expectedRevision: 1 },
        cmd(s.admin.id),
      ).finally(() => {
        revokeFinished = true;
      });
      let uploaded: Promise<Response> | undefined;
      try {
        // 实际撤成员命令先在成员行上排队；随后上传通过旧已提交状态的中间件，再进入事务重新验权。
        await waitForBlocked(s.db, 1, () => revokeFinished);
        uploaded = s
          .request('POST', `${BASE}/attachments/${registered.attachment.id}/upload`, {
            ifMatch: registered.revision,
            idempotencyKey: uploadKey,
            body: { base64: fixture.base64 },
          })
          .finally(() => {
            uploadFinished = true;
          });
        await waitForBlocked(s.db, 2, () => revokeFinished || uploadFinished);
        gate.release();
        await gate.complete;
        expect(await revoke).toMatchObject({ status: 'revoked', revision: 2 });
        const rejected = await uploaded;
        expect(rejected.status, await rejected.clone().text()).toBe(403);
        expect(await rejected.json()).toMatchObject({ error: { code: 'TENANT_NOT_MEMBER' } });
        expect(await avatarSnapshot(s.db, s.tenant.id)).toEqual(before);
        const after = await evidence(s.db, s.tenant.id, s.owner.id, [uploadKey]);
        expect(after.audit).toHaveLength(1);
        expect(after.ledger).toHaveLength(0);
      } finally {
        gate.release();
        await Promise.allSettled([gate.complete, revoke, ...(uploaded ? [uploaded] : [])]);
      }
    });
  },
);
