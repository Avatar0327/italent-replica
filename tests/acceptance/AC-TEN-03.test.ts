/**
 * AC-TEN-03（REQ-TEN-001 R3；docs/02_业务建模/11 §13.1）：租户覆盖一条系统预置配置后“恢复” → 回到系统级配置。
 * 同时覆盖平台约定（AGENTS.md §10）：revision 乐观锁 409、命令 ID 幂等、业务与审计同事务、审计只追加。
 */
import { asc, auditEvents, eq, sql, upsertSystemSetting, withTenant } from '@italent/db';
import { pgErrorCode, useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { cmd, errorCode, seedTenantWithMember, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

// 迁移预置的系统配置：日志保留期（docs/02_业务建模/20 §5 第 4 条，原站“查询 3 个月、保留 6 个月”）
const KEY = 'audit.retention';
const SYSTEM_VALUE = { queryMonths: 3, retainMonths: 6 };
const PATH = `/api/tenant/settings/${KEY}`;

interface SettingBody {
  key: string;
  value: unknown;
  source: 'system' | 'tenant';
  revision: number;
}

describe('AC-TEN-03 预置配置的租户覆盖与恢复', () => {
  let a: Awaited<ReturnType<typeof seedTenantWithMember>>;
  let b: Awaited<ReturnType<typeof seedTenantWithMember>>;
  let api: ReturnType<typeof tenantApi>;
  let asA: { user: string; tenant: string };

  beforeAll(async () => {
    const { db } = testDb();
    a = await seedTenantWithMember(db, 'a');
    b = await seedTenantWithMember(db, 'b');
    api = tenantApi(db);
    asA = { user: a.user.id, tenant: a.tenant.id };
  });

  /** 当前 revision（取 GET 的 ETag）；写请求必须携带它。 */
  async function currentRevision(): Promise<number> {
    const res = await api.request('GET', PATH, asA);
    return Number(res.headers.get('etag')?.replaceAll('"', ''));
  }

  it('覆盖 → 有效值来源 tenant；恢复 → 回到 system 值；两次操作都写入审计', async () => {
    const initial = await api.request('GET', PATH, asA);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({ key: KEY, value: SYSTEM_VALUE, source: 'system', revision: 0 });

    const override = { queryMonths: 12, retainMonths: 24 };
    const put = await api.request('PUT', PATH, { ...asA, ifMatch: 0, body: { value: override } });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ value: override, source: 'tenant', revision: 1 });
    expect(put.headers.get('etag')).toBe('"1"');

    const otherTenant = await api.request('GET', PATH, { user: b.user.id, tenant: b.tenant.id });
    expect(((await otherTenant.json()) as SettingBody).source).toBe('system');

    const restore = await api.request('DELETE', `${PATH}/override`, { ...asA, ifMatch: 1 });
    expect(restore.status).toBe(200);
    expect(await restore.json()).toMatchObject({ value: SYSTEM_VALUE, source: 'system', revision: 2 });
    const afterRestore = await api.request('GET', PATH, asA);
    expect(afterRestore.headers.get('etag')).toBe('"2"');
    expect(await afterRestore.json()).toMatchObject({ value: SYSTEM_VALUE, source: 'system', revision: 2 });

    const events = await withTenant(testDb().db, a.tenant.id, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.objectId, KEY)).orderBy(asc(auditEvents.occurredAt)),
    );
    expect(events.map((e) => e.action)).toEqual(['tenant_setting.override', 'tenant_setting.restore']);
    expect(events[0]).toMatchObject({ actorUserId: a.user.id, objectType: 'tenant_setting', before: null });
    expect(events[0]?.after).toMatchObject({ value: override, revision: 1 });
    expect(events[1]?.before).toMatchObject({ value: override, revision: 1 });
    expect(events[1]?.after).toBeNull();
  });

  it('revision 单调递增（无 ABA）：覆盖 r1 → 恢复 r2 后，持旧 ETag（1）写入 → 409', async () => {
    expect(await currentRevision()).toBe(2);
    const stale = await api.request('PUT', PATH, { ...asA, ifMatch: 1, body: { value: { queryMonths: 7 } } });
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe('REVISION_CONFLICT');

    const again = await api.request('PUT', PATH, { ...asA, ifMatch: 2, body: { value: { queryMonths: 7 } } });
    expect(await again.json()).toMatchObject({ source: 'tenant', revision: 3, value: { queryMonths: 7 } });
    const restored = await api.request('DELETE', `${PATH}/override`, { ...asA, ifMatch: 3 });
    expect(await restored.json()).toMatchObject({ source: 'system', revision: 4 });

    // 本就取系统值时恢复是空操作：revision 不变、不写审计
    const noop = await api.request('DELETE', `${PATH}/override`, { ...asA, ifMatch: 4 });
    expect(await noop.json()).toMatchObject({ source: 'system', revision: 4 });
    const restores = await withTenant(testDb().db, a.tenant.id, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, 'tenant_setting.restore')),
    );
    expect(restores).toHaveLength(2);
  });

  it('审计不可修改、不可删除：应用角色与连接角色（表属主 / 超级用户）都被拒绝', async () => {
    const { db } = testDb();
    const asAppUser = withTenant(db, a.tenant.id, (tx) => tx.update(auditEvents).set({ action: 'forged' }));
    await expect(asAppUser).rejects.toThrow();

    for (const statement of [
      sql`UPDATE audit_events SET action = 'forged'`,
      sql`DELETE FROM audit_events`,
      sql`TRUNCATE audit_events`,
    ]) {
      const error = await db.execute(statement).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(pgErrorCode(error)).toBe('55000');
    }
    const count = await withTenant(db, a.tenant.id, (tx) => tx.select().from(auditEvents));
    expect(count.length).toBeGreaterThanOrEqual(2);
  });

  it('revision 不一致 → 409 REVISION_CONFLICT；缺少 If-Match → 400 REVISION_REQUIRED', async () => {
    const rev = await currentRevision();
    const first = await api.request('PUT', PATH, { ...asA, ifMatch: rev, body: { value: { queryMonths: 6 } } });
    expect(first.status).toBe(200);

    const stale = await api.request('PUT', PATH, { ...asA, ifMatch: rev, body: { value: { queryMonths: 9 } } });
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe('REVISION_CONFLICT');

    const staleRestore = await api.request('DELETE', `${PATH}/override`, { ...asA, ifMatch: 99 });
    expect(staleRestore.status).toBe(409);

    const missing = await api.request('PUT', PATH, { ...asA, body: { value: { queryMonths: 9 } } });
    expect(missing.status).toBe(400);
    expect(await errorCode(missing)).toBe('REVISION_REQUIRED');

    const cleanup = await api.request('DELETE', `${PATH}/override`, { ...asA, ifMatch: rev + 1 });
    expect(cleanup.status).toBe(200);
  });

  it('同一 Idempotency-Key 同内容重放返回原结果且只执行一次；同键异内容 → 409', async () => {
    const rev = await currentRevision();
    const body = { value: { queryMonths: 4, retainMonths: 8 } };
    const opts = { ...asA, ifMatch: rev, body, idempotencyKey: 'cmd-0001' };
    const first = await api.request('PUT', PATH, opts);
    const replay = await api.request('PUT', PATH, opts);
    expect([first.status, replay.status]).toEqual([200, 200]);
    expect(await replay.json()).toEqual(await first.json());
    expect(await currentRevision()).toBe(rev + 1);

    const different = await api.request('PUT', PATH, { ...opts, body: { value: { queryMonths: 5 } } });
    expect(different.status).toBe(409);
    expect(await errorCode(different)).toBe('IDEMPOTENCY_CONFLICT');

    const events = await withTenant(testDb().db, a.tenant.id, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.commandId, 'cmd-0001')),
    );
    expect(events).toHaveLength(1);
    await api.request('DELETE', `${PATH}/override`, { ...asA, ifMatch: rev + 1 });
  });

  it('写请求缺少 Idempotency-Key → 400 IDEMPOTENCY_KEY_REQUIRED，不存在绕过命令台账的写路径', async () => {
    const rev = await currentRevision();
    const put = await api.request('PUT', PATH, { ...asA, ifMatch: rev, idempotencyKey: null, body: { value: 1 } });
    const del = await api.request('DELETE', `${PATH}/override`, { ...asA, ifMatch: rev, idempotencyKey: null });
    expect([put.status, del.status]).toEqual([400, 400]);
    expect(await errorCode(put)).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(await errorCode(del)).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(await currentRevision()).toBe(rev);
  });

  it('同键同内容的并发重复请求：都得到相同的成功响应，只执行一次、只写一次审计', async () => {
    const rev = await currentRevision();
    const opts = { ...asA, ifMatch: rev, body: { value: { queryMonths: 2 } }, idempotencyKey: 'cmd-concurrent' };
    const [first, second] = await Promise.all([api.request('PUT', PATH, opts), api.request('PUT', PATH, opts)]);
    expect([first.status, second.status]).toEqual([200, 200]);
    const [body1, body2] = await Promise.all([first.json(), second.json()]);
    expect(body2).toEqual(body1);
    expect(body1).toMatchObject({ source: 'tenant', revision: rev + 1 });

    const events = await withTenant(testDb().db, a.tenant.id, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.commandId, 'cmd-concurrent')),
    );
    expect(events).toHaveLength(1);
    await api.request('DELETE', `${PATH}/override`, { ...asA, ifMatch: rev + 1 });
  });

  it('系统预置且只读的配置不可覆盖 → 403 SETTING_READ_ONLY；未知配置 → 404', async () => {
    const { db } = testDb();
    await upsertSystemSetting(
      db,
      { key: 'test.read_only', value: true, description: '测试用只读预置', overridable: false, expectedVersion: 0 },
      cmd(),
    );
    const readOnly = await api.request('PUT', '/api/tenant/settings/test.read_only', {
      ...asA,
      ifMatch: 0,
      body: { value: false },
    });
    expect(readOnly.status).toBe(403);
    expect(await errorCode(readOnly)).toBe('SETTING_READ_ONLY');

    const unknown = await api.request('GET', '/api/tenant/settings/no.such.key', asA);
    expect(unknown.status).toBe(404);
  });

  it('未接入授权（R1-T01 之前的默认钩子）时读写一律 fail-closed → 403', async () => {
    const { db } = testDb();
    const locked = tenantApi(db, { authorize: undefined });
    const write = await locked.request('PUT', PATH, { ...asA, ifMatch: 0, body: { value: { queryMonths: 1 } } });
    expect(write.status).toBe(403);
    expect(await errorCode(write)).toBe('FORBIDDEN');
    const read = await locked.request('GET', PATH, asA);
    expect(read.status).toBe(403);
    expect(await errorCode(read)).toBe('FORBIDDEN');
  });
});
