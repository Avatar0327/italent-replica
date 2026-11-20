/**
 * AC-ESIGN-F505-02 升级与 RLS（设计 §4.3、§12）：停在 F-505 迁移之前造 transfer 签署中 / 已完成任务，升级后原样保留；
 * 升级后可建 Offer / 入职任务；新表 ENABLE + FORCE RLS，app_owner 裸连接 0 行；租户 B 造不出 A 的锚点。
 * 旧结构夹具只写旧列（原生 SQL，不引用新列，不调用依赖新列的新写接口）；DEC-913：本文件与仓库全部 migrateBefore
 * 升级用例一起在 PG16 app_owner 下跑。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { testDbMode, useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { linkageWorld } from './AC-LNK-support.js';
import { UNIQUE_VIOLATION, insertTask, rowsOf, sourceWorld, sqlState } from './AC-ESIGN-F505-support.js';

const database = useTestDb({ migrateBefore: '_f505_esign_offer_entry' });
const db = () => database().db;

async function legacyTask(tenantId: string, userId: string, businessId: string, employeeId: string, status: string) {
  const id = randomUUID();
  await withTenant(db(), tenantId, (tx) =>
    tx.execute(sql`INSERT INTO esign_tasks(id, tenant_id, scene, business_id, employee_id, initiator_user_id, origin,
        status, current_node, validity_days, expires_at, initiated_at, completed_at)
      VALUES (${id}, ${tenantId}, 'transfer', ${businessId}::uuid, ${employeeId}::uuid, ${userId}::uuid, 'manual',
        ${status}, ${status === 'signing' ? 'employee' : null}, 2, now() + interval '2 days', now(),
        ${status === 'completed' ? sql`now()` : null})`),
  );
  return id;
}

describe('AC-ESIGN-F505-02 升级与 RLS', () => {
  it('迁移前 transfer signing / completed 升级后原样保留，新列取默认；升级后新 Offer / 入职任务可建', async () => {
    const old = await linkageWorld(db(), 'f505-up');
    const tenantId = old.session.tenant.id;
    const person = await old.hire('ZZ_F505_UP_EMP');
    const signing = await legacyTask(tenantId, old.session.user.id, person.hire.id, person.employee.id, 'signing');
    const person2 = await old.hire('ZZ_F505_UP_EMP2');
    const done = await legacyTask(tenantId, old.session.user.id, person2.hire.id, person2.employee.id, 'completed');
    await database().migrate();
    const rows = rowsOf<Record<string, unknown>>(
      await withTenant(db(), tenantId, (tx) =>
        tx.execute(sql`SELECT id, scene, status, business_id, offer_id, source_revision, variable_read_fields
          FROM esign_tasks ORDER BY id`),
      ),
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(rows).toHaveLength(2);
    expect(byId.get(signing)).toMatchObject({ scene: 'transfer', status: 'signing', business_id: person.hire.id });
    expect(byId.get(done)).toMatchObject({ scene: 'transfer', status: 'completed', business_id: person2.hire.id });
    for (const row of rows)
      expect([row.offer_id, row.source_revision, row.variable_read_fields]).toEqual([null, null, []]);
    // 升级后：同租户新 Offer 与入职任务；transfer 在途不阻塞同人的 entry
    const world = await sourceWorld(db(), 'up-after');
    const offerId = await world.offer();
    await world.anchor(offerId);
    await world.task({ scene: 'offer', offerId, employeeId: world.person.employee.id, sourceRevision: 1 });
    const entry = { scene: 'entry', businessId: person.hire.id, employeeId: person.employee.id, sourceRevision: 1 };
    await insertTask(db(), tenantId, old.session.user.id, entry);
    expect(await world.taskCount()).toBe(1);
    expect(await sqlState(() => insertTask(db(), tenantId, old.session.user.id, entry))).toBe(UNIQUE_VIOLATION);
  });

  it('新表 ENABLE + FORCE RLS；租户 B 造不出 A 的锚点，也不能给 A 的 Offer 建自己的锚点', async () => {
    await database().migrate();
    const a = await sourceWorld(db(), 'rls-a');
    const b = await sourceWorld(db(), 'rls-b');
    const offerA = await a.offer();
    const flags = rowsOf<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      await db().execute(sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname = 'esign_offer_sources'`),
    );
    expect(flags).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    // B 上下文写 A 的 tenant_id：存在性触发器 / RLS WITH CHECK 先到者拒绝；写自己的 tenant_id 但 Offer 是 A 的：存在性触发器拒绝
    expect(
      await sqlState(() =>
        withTenant(db(), b.tenantId, (tx) =>
          tx.execute(sql`INSERT INTO esign_offer_sources(tenant_id, offer_id) VALUES (${a.tenantId}, ${offerA}::uuid)`),
        ),
      ),
    ).not.toBe('ok');
    expect(await sqlState(() => b.anchor(offerA))).not.toBe('ok');
    await a.anchor(offerA);
    expect(await a.anchorCount()).toBe(1);
    expect(await b.anchorCount()).toBe(0);
  });

  it('app_owner 裸连接读新表为 0 行（PGlite / 超级用户跳过）', async (context) => {
    await database().migrate();
    const a = await sourceWorld(db(), 'bare');
    await a.anchor(await a.offer());
    const role = rowsOf<{ bypass: boolean }>(
      await db().execute(sql`SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`),
    )[0]!;
    if (testDbMode() !== 'pg' || role.bypass) context.skip('当前连接绕过 RLS，裸连接断言只在普通角色下成立');
    const bare = rowsOf<{ n: number }>(await db().execute(sql`SELECT count(*)::int AS n FROM esign_offer_sources`));
    expect(bare[0]!.n).toBe(0);
  });
});
