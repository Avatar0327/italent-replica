/**
 * R2 BE-8b1 / B64：离职交接事项是任职设置配置对象（同自动加黑规则页，DEC-203 配置日志）：租户管理员（配置写 = other_settings）
 * 可读写，没有管理员身份的普通成员读写都是 403 且不写入；写入留 exit_handover_item 审计。真实授权器。
 */
import { randomUUID } from 'node:crypto';
import { bootstrapTenantAdmin } from '@italent/api';
import { createUser, grantMembership, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { employmentSession } from './AC-EMP-support.js';
import { rowsOf } from './AC-DM-R2-blacklist-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const ITEM = {
  category: '财务',
  sequenceNo: 1,
  todoType: 'work_handover',
  title: '归还备用金',
  formRef: null,
  remark: null,
};

describe('AC-EXIT-handover-permission 离职交接事项（任职设置配置对象）', () => {
  it('租户管理员可读写并留 exit_handover_item 审计；普通成员读写 403 且不写入', async () => {
    const { db } = testDb();
    const session = await employmentSession(db, `handover-perm-${randomUUID()}`);
    const tenant = session.tenant.id;
    await bootstrapTenantAdmin(db, { tenantId: tenant, userId: session.user.id }, cmd());
    const real = tenantApi(db, { authorize: undefined, clock: () => new Date('2026-10-01T04:00:00Z') });
    const as =
      (user: string) =>
      (method: string, path: string, options: { ifMatch?: number; body?: unknown } = {}) =>
        real.request(method, `/api/tenant/employment${path}`, { ...options, user, tenant });
    const admin = as(session.user.id);

    const created = await admin('POST', '/exit-handover-items', { ifMatch: 0, body: ITEM });
    expect(created.status, await created.clone().text()).toBe(201);
    const item = (await created.json()) as { id: string; revision: number };
    expect((await admin('GET', '/exit-handover-items')).status).toBe(200);

    const member = await createUser(db, { email: `ho-${randomUUID()}@example.com`, displayName: '普通成员' }, cmd());
    await grantMembership(db, { tenantId: tenant, userId: member.id, expectedRevision: 0 }, cmd());
    const plain = as(member.id);
    expect((await plain('GET', '/exit-handover-items')).status).toBe(403);
    expect(
      (await plain('POST', '/exit-handover-items', { ifMatch: 0, body: { ...ITEM, title: '无权新增' } })).status,
    ).toBe(403);
    expect((await plain('PUT', `/exit-handover-items/${item.id}`, { ifMatch: item.revision, body: ITEM })).status).toBe(
      403,
    );
    expect((await plain('DELETE', `/exit-handover-items/${item.id}`, { ifMatch: item.revision })).status).toBe(403);

    const audits = await withTenant(db, tenant, async (tx) =>
      rowsOf<{ action: string }>(
        await tx.execute(sql`SELECT action FROM audit_events WHERE tenant_id=${tenant} AND object_id=${item.id}
          ORDER BY occurred_at, id`),
      ),
    );
    expect(audits.map((row) => row.action)).toEqual(['exit_handover_item.create']);
    const removed = await admin('DELETE', `/exit-handover-items/${item.id}`, { ifMatch: item.revision });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(((await (await admin('GET', '/exit-handover-items')).json()) as { items: unknown[] }).items).toEqual([]);
  });
});
