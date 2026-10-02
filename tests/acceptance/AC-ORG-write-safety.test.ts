/** AC-ORG-01/03/07 与 DEC-067：组织写命令的权限、幂等、并发和事务边界。 */
import { auditEvents, eq, sql, withTenant } from '@italent/db';
import { pgErrorCode, useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { orgSession, resultRows } from './AC-ORG-support.js';
import { errorCode, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

describe('AC-ORG 写命令安全边界', () => {
  it('同一创建命令重放保持组织 ID 与响应，异内容重用命令键返回 409', async () => {
    const session = await orgSession(testDb().db, 'org-replay');
    const options = {
      ifMatch: 0,
      idempotencyKey: 'org-create-replay',
      body: { name: '幂等创建', parents: { admin: { parentId: session.tenant.id } } },
    };
    const first = await session.request('POST', '/organizations', options);
    const replay = await session.request('POST', '/organizations', options);
    expect([first.status, replay.status]).toEqual([201, 201]);
    expect(await replay.json()).toEqual(await first.json());
    expect(await session.list('幂等创建')).toHaveLength(1);
    const events = await withTenant(testDb().db, session.tenant.id, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, 'org.create')),
    );
    expect(events).toHaveLength(1);
    const conflict = await session.request('POST', '/organizations', {
      ...options,
      body: { ...options.body, name: '不得重放不同内容' },
    });
    expect(conflict.status).toBe(409);
    expect(await errorCode(conflict)).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('同一 Idempotency-Key 并发重放只产生一个组织', async () => {
    const session = await orgSession(testDb().db, 'org-concurrent-replay');
    const options = {
      ifMatch: 0,
      idempotencyKey: 'same-concurrent-command',
      body: { name: '并发幂等部门', parents: { admin: { parentId: session.tenant.id } } },
    };
    const responses = await Promise.all([
      session.request('POST', '/organizations', options),
      session.request('POST', '/organizations', options),
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(await responses[0]!.json()).toEqual(await responses[1]!.json());
    expect(await session.list('并发幂等部门')).toHaveLength(1);
  });

  it('同一旧 revision 并发改名只有一次成功，失败方不留业务与审计副作用', async () => {
    const session = await orgSession(testDb().db, 'org-concurrent-update');
    const org = await session.create('并发原名');
    const responses = await Promise.all(
      ['并发新名甲', '并发新名乙'].map((name) =>
        session.request('PATCH', `/organizations/${org.id}`, {
          ifMatch: org.revision,
          body: { name, effectiveDate: '2026-10-01' },
        }),
      ),
    );
    expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(await errorCode(responses.find((res) => res.status === 409)!)).toBe('REVISION_CONFLICT');
    const events = await withTenant(testDb().db, session.tenant.id, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, 'org.update')),
    );
    expect(events).toHaveLength(1);
    expect((await session.list()).find((item) => item.id === org.id)?.revision).toBe(2);
  });

  it('缺少 revision 或命令 ID 的写请求被拒绝，没有组织写入', async () => {
    const session = await orgSession(testDb().db, 'org-write-headers');
    const body = { name: '不得无前置条件保存', parents: { admin: { parentId: session.tenant.id } } };
    const missingRevision = await session.request('POST', '/organizations', { body });
    expect(missingRevision.status).toBe(400);
    expect(await errorCode(missingRevision)).toBe('REVISION_REQUIRED');
    const missingCommand = await session.request('POST', '/organizations', { body, ifMatch: 0, idempotencyKey: null });
    expect(missingCommand.status).toBe(400);
    expect(await errorCode(missingCommand)).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(await session.list()).toEqual([]);
  });

  it('未接授权时组织读取、预占和新建均拒绝，不自动赋予管理员全范围', async () => {
    const session = await orgSession(testDb().db, 'org-default-deny');
    const locked = tenantApi(testDb().db, { authorize: undefined });
    const asMember = { user: session.user.id, tenant: session.tenant.id, ifMatch: 0 };
    for (const [method, path, body] of [
      ['GET', '/organizations', undefined],
      ['POST', '/code-reservations', {}],
      ['POST', '/organizations', { name: '不得越权创建', parents: { admin: { parentId: session.tenant.id } } }],
    ] as const) {
      const response = await locked.request(method, `/api/tenant/org${path}`, { ...asMember, body });
      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe('FORBIDDEN');
    }
    expect(await session.list()).toEqual([]);
  });

  it('组织版本、层级记录不可修改或删除，数据库属主也被只追加触发器拦截', async () => {
    const { db } = testDb();
    const session = await orgSession(db, 'org-immutable');
    await session.create('永久保留历史');
    for (const table of ['org_versions', 'org_hierarchy_links'] as const) {
      const update = table === 'org_versions' ? 'name = name' : 'dimension = dimension';
      for (const statement of [`UPDATE ${table} SET ${update}`, `DELETE FROM ${table}`, `TRUNCATE ${table} CASCADE`]) {
        const error = await db.execute(sql.raw(statement)).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(pgErrorCode(error)).toBe('55000');
      }
    }
    const versions = await withTenant(db, session.tenant.id, (tx) =>
      tx.execute(sql`SELECT version_no FROM org_versions WHERE org_id != ${session.tenant.id}`),
    );
    expect(resultRows<{ version_no: number }>(versions)).toEqual([{ version_no: 1 }]);
  });
});
