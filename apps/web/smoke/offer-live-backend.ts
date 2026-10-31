/** F-298 浏览器集成专用：全新隔离数据库、合成数据、真实 Offer 路由；不连接开发库。 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { sql, withTenant } from '@italent/db';
import { createTestDb } from '../../../packages/testkit/src/test-db.js';
import { seedTenantWithMember, tenantApi } from '../../../tests/acceptance/support/tenant-api.js';

export async function startOfferBackend() {
  const handle = await createTestDb();
  try {
    const { tenant, user } = await seedTenantWithMember(handle.db, 'F298-browser');
    const api = tenantApi(handle.db);
    const identity = { user: user.id, tenant: tenant.id };
    const departmentId = randomUUID();
    const positionId = randomUUID();
    const postId = randomUUID();
    const id = randomUUID();
    await withTenant(handle.db, tenant.id, async (tx) => {
      await tx.execute(sql`INSERT INTO org_objects(id, tenant_id) VALUES (${departmentId}, ${tenant.id})`);
      await tx.execute(sql`INSERT INTO org_versions(tenant_id, org_id, version_no, code, name, full_name, start_date)
        VALUES (${tenant.id}, ${departmentId}, 1, 'F298-DEPT', '合成联调部门', '合成联调集团/合成联调部门', '2020-01-01')`);
      await tx.execute(sql`INSERT INTO job_post_objects(id, tenant_id) VALUES (${postId}, ${tenant.id})`);
      await tx.execute(sql`INSERT INTO job_post_versions(tenant_id, object_id, version_no, code, name, start_date)
        VALUES (${tenant.id}, ${postId}, 1, 'F298-POST', '合成联调职务', '2020-01-01')`);
      await tx.execute(sql`INSERT INTO job_position_objects(id, tenant_id) VALUES (${positionId}, ${tenant.id})`);
      await tx.execute(sql`INSERT INTO job_position_versions
        (tenant_id, object_id, version_no, code, name, start_date, org_id, post_id)
        VALUES (${tenant.id}, ${positionId}, 1, 'F298-POS', '合成联调职位', '2020-01-01', ${departmentId}, ${postId})`);
      await tx.execute(sql`INSERT INTO offers(id, tenant_id, entry, name, personal_email, status,
        department_id, position_id, post_id, sent_by, planned_entry_date, created_by)
        VALUES (${id}, ${tenant.id}, 'offer', '合成数据库候选人', 'db-offer@example.com', 'sent',
          ${departmentId}, ${positionId}, ${postId}, ${user.id}, '2026-11-01', ${user.id})`);
      await tx.execute(sql`INSERT INTO offer_send_records(tenant_id, offer_id, recipient, sent_by, kind, command_id)
        VALUES (${tenant.id}, ${id}, 'db-recipient@example.com', ${user.id}, 'send', ${randomUUID()})`);
    });
    const server = createServer(async (req, res) => {
      try {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }
        const response = await api.request('GET', req.url!, identity);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
      } catch {
        res.writeHead(500);
        res.end('F298 test backend failed');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    return {
      manifest: { id, tenant: tenant.id, user: user.id, url: `http://127.0.0.1:${address.port}` },
      async close() {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await handle.close();
      },
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
