/**
 * PR #75 第二轮 P2-3 / P2-4：0049 之前写入的审计行（没有 operation / changes，对象 ID 大小写不一）升级后
 * 与新写入一样可查：字段筛选、操作类型筛选与展示一致，UUID 对象 ID 大小写不影响查询；
 * 创建人最小元数据（DEC-198）同样从历史新增事件回填。
 */
import { randomUUID } from 'node:crypto';
import { sql, withPlatform, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { creatorOf } from '../../apps/api/src/modules/permission/scope-audit.js';
import { auditApi } from './AC-AUD-support.js';

const testDb = useTestDb({ migrateBefore: '_audit_log' });
const NOW = '2026-10-01T01:00:00.000Z';

it('升级前的日志：字段 / 操作类型 / 对象 ID 筛选与展示一致，创建人元数据已回填', async () => {
  const handle = testDb();
  const db = handle.db;
  const tenantId = randomUUID();
  const userId = randomUUID();
  const recordId = randomUUID();
  const orgId = randomUUID();
  await withPlatform(db, async (tx) => {
    await tx.execute(sql`INSERT INTO tenants (id,code,name) VALUES (${tenantId},${`legacy-${tenantId.slice(0, 8)}`},
      '升级前租户')`);
    await tx.execute(sql`INSERT INTO users (id,email,display_name)
      VALUES (${userId},${`legacy-${userId.slice(0, 8)}@example.com`},'升级前管理员')`);
  });
  await withTenant(db, tenantId, async (tx) => {
    await tx.execute(sql`INSERT INTO tenant_memberships (tenant_id,user_id) VALUES (${tenantId},${userId})`);
    await tx.execute(sql`INSERT INTO audit_events (tenant_id,actor_user_id,action,object_type,object_id,before,after,
        occurred_at,command_id)
      VALUES (${tenantId},${userId},'employment.record.edit','employment-record',${recordId.toUpperCase()},
        '{"place":"旧地点","remarks":"同值"}'::jsonb,'{"place":"新地点","remarks":"同值"}'::jsonb,
        '2026-09-30T02:00:00Z','legacy-edit'),
      (${tenantId},${userId},'org.create','organization',${orgId},NULL,'{"name":"升级前部门"}'::jsonb,
        '2026-09-30T01:00:00Z','legacy-create')`);
  });
  await handle.migrate();

  const audit = auditApi(db, NOW);
  const as = { user: userId, tenant: tenantId };
  const all = await audit.dataChanges(as, { objectType: 'employment-record' });
  expect(all.items).toHaveLength(1);
  expect(all.items[0]).toMatchObject({
    objectId: recordId,
    operation: 'update',
    content: '工作地点:从【旧地点】修改为【新地点】',
  });
  const queries: Record<string, string>[] = [
    { field: 'place' },
    { operation: 'update' },
    { objectId: recordId },
    { objectId: recordId.toUpperCase() },
  ];
  for (const query of queries) {
    const filtered = await audit.dataChanges(as, { objectType: 'employment-record', ...query });
    expect(
      filtered.items.map((item) => item.id),
      JSON.stringify(query),
    ).toEqual([all.items[0]!.id]);
  }
  expect((await audit.dataChanges(as, { objectType: 'employment-record', field: 'remarks' })).items).toEqual([]);
  expect((await audit.dataChanges(as, { operation: 'create', objectId: orgId })).items).toHaveLength(1);

  await withTenant(db, tenantId, async (tx) => {
    expect(await creatorOf(tx, tenantId, orgId, 'org.create', 'organization')).toBe(userId);
  });
});
