/**
 * AC-TRF-F481-19 租户隔离（模板部分，设计 §12）：另一租户看不到、改不了本租户的模板；
 * 四张新表都 ENABLE + FORCE RLS；app_owner 普通角色下裸连接读 esign_tasks 为 0 行（超级用户 / PGlite 下跳过该断言）。
 */
import { esignTasks, sql, withTenant } from '@italent/db';
import { testDbMode, useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { esignWorld, type TemplateView } from './AC-TRF-F481-support.js';
import { rowsOf } from './support/f048.js';

const db = useTestDb();

describe('AC-TRF-F481-19 租户隔离（模板部分）', () => {
  it('租户 B 看不到 A 的模板，用 A 的模板 ID 改写也是 404，A 的模板不受影响', async () => {
    const a = await esignWorld(db().db, 'iso-a');
    const b = await esignWorld(db().db, 'iso-b');
    const mine = await a.create('mine');
    const list = await b.call('GET', '/templates');
    expect(((await list.json()) as { items: TemplateView[] }).items).toEqual([]);
    const touch = await b.call('PATCH', `/templates/${mine.id}`, {
      ifMatch: mine.revision,
      body: { status: 'disabled' },
    });
    expect(touch.status).toBe(404);
    const after = await a.call('GET', '/templates');
    expect(((await after.json()) as { items: TemplateView[] }).items[0]).toMatchObject({
      id: mine.id,
      status: 'enabled',
    });
  });

  it('esign_templates / esign_scene_settings / esign_tasks / esign_task_files 都开启并强制行级安全', async () => {
    const result = await db().db.execute(sql`
      SELECT relname, relrowsecurity AS enabled, relforcerowsecurity AS forced
      FROM pg_class WHERE relname IN ('esign_templates','esign_scene_settings','esign_tasks','esign_task_files',
        'transfer_linkage_esign_templates') ORDER BY relname`);
    const rows = rowsOf<{ relname: string; enabled: boolean; forced: boolean }>(result);
    expect(rows.map((r) => r.relname)).toEqual([
      'esign_scene_settings',
      'esign_task_files',
      'esign_tasks',
      'esign_templates',
      'transfer_linkage_esign_templates',
    ]);
    for (const row of rows) expect([row.relname, row.enabled, row.forced]).toEqual([row.relname, true, true]);
  });

  it('另一租户上下文读 esign_tasks 为 0 行；app_owner 下裸连接同样为 0 行', async (context) => {
    const a = await esignWorld(db().db, 'iso-task-a');
    const b = await esignWorld(db().db, 'iso-task-b');
    const dept = await a.session.org('ZZ_F481_O1', { establishedOn: '2000-01-01' });
    const employee = await a.session.employee();
    const hire = await a.session.business(
      employee.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2025-01-01', fields: { departmentId: dept.id } },
      employee.revision,
    );
    await withTenant(db().db, a.session.tenant.id, async (tx) => {
      await tx.execute(sql`
        INSERT INTO esign_tasks (tenant_id, scene, business_id, employee_id, initiator_user_id, origin, status,
          current_node, validity_days, expires_at, initiated_at)
        VALUES (${a.session.tenant.id}, 'transfer', ${hire.id}, ${employee.id}, ${a.session.user.id},
          'manual', 'signing', 'employee', 2, now() + interval '48 hours', now())`);
    });
    const own = await withTenant(db().db, a.session.tenant.id, (tx) => tx.select().from(esignTasks));
    expect(own).toHaveLength(1);
    const foreign = await withTenant(db().db, b.session.tenant.id, (tx) => tx.select().from(esignTasks));
    expect(foreign).toHaveLength(0);
    const role = rowsOf<{ bypass: boolean }>(
      await db().db.execute(
        sql`SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`,
      ),
    )[0]!;
    if (testDbMode() !== 'pg' || role.bypass)
      context.skip('当前连接绕过 RLS（PGlite / 超级用户），裸连接断言只在普通角色下成立');
    const bare = await db().db.transaction((tx) => tx.select().from(esignTasks));
    expect(bare).toHaveLength(0);
  });
});
