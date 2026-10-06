/**
 * PR #75 第二轮 P2-3 / P2-4：0056 之前写入的审计行（没有 operation / changes，对象 ID 大小写不一）升级后
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

it('PR #75 第三轮 P1-1：升级前只存变化字段的人员类日志按对象 ID / 记录关系回填所属人员，推导不出的保持为空', async () => {
  const handle = testDb();
  const db = handle.db;
  const tenantId = randomUUID();
  const employeeId = randomUUID();
  const subsetRecord = randomUUID();
  const orphanRecord = randomUUID();
  await withPlatform(db, (tx) =>
    tx.execute(sql`INSERT INTO tenants (id,code,name) VALUES (${tenantId},${`legacy-p-${tenantId.slice(0, 8)}`},
      '升级前人员租户')`),
  );
  await withTenant(db, tenantId, async (tx) => {
    await tx.execute(sql`INSERT INTO employment_employees (id,tenant_id,code,name)
      VALUES (${employeeId},${tenantId},'LEGACY-E','合成员工')`);
    // 旧版人员写入：审计只存变化字段（没有 employeeId），同事务的 personnel_outbox 记有所属人员
    await tx.execute(sql`INSERT INTO personnel_outbox (tenant_id,employee_id,object_type,object_id,event_type,revision,
        command_id)
      VALUES (${tenantId},${employeeId},'TenantBase.Education',${subsetRecord},'personnel.changed',2,'legacy-subset')`);
    await tx.execute(sql`INSERT INTO audit_events (tenant_id,action,object_type,object_id,before,after,occurred_at)
      VALUES (${tenantId},'personnel.update','TenantBase.EmployeeInformation',${employeeId},
        '{"gender":"男"}'::jsonb,'{"gender":"女"}'::jsonb,'2026-09-30T01:00:00Z'),
      (${tenantId},'personnel.update','TenantBase.Education',${subsetRecord},
        '{"school":"旧"}'::jsonb,'{"school":"新"}'::jsonb,'2026-09-30T01:00:00Z'),
      (${tenantId},'personnel.update','TenantBase.Education',${orphanRecord},
        '{"school":"旧"}'::jsonb,'{"school":"新"}'::jsonb,'2026-09-30T01:00:00Z')`);
  });
  await handle.migrate();
  const anchors = await withTenant(db, tenantId, async (tx) => {
    const result = await tx.execute(sql`SELECT object_id, scope_employee_id FROM audit_events ORDER BY object_id`);
    return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
      object_id: string;
      scope_employee_id: string | null;
    }[];
  });
  const byObject = Object.fromEntries(anchors.map((row) => [row.object_id, row.scope_employee_id]));
  expect(byObject[employeeId]).toBe(employeeId);
  expect(byObject[subsetRecord]).toBe(employeeId);
  expect(byObject[orphanRecord]).toBeNull();
});
