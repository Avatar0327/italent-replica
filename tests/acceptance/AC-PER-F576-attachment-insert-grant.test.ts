import { and, eq, personnelAttachments, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { personnelSession } from './AC-SUB-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();

// F-576：personnel_attachments 缺 app_user INSERT 授权（0024 建表后从未授权）。
// PG16 普通角色（app_owner，NOBYPASSRLS）与 PGlite 的应用角色下，附件登记路由在员工行锁之后返回 503；超级用户连接返回 200，
// 把缺口掩盖掉。本用例走 HTTP 入口，断言 200 且在本租户落一行、他租户看不到（RLS 不变）。
it('AC-PER-F576 附件登记在应用角色下返回 200 且落库，他租户不可见', async () => {
  const s = await personnelSession(database().db, 'att-grant');
  const other = await personnelSession(database().db, 'att-grant-other');
  const filename = `合成附件-${uniqueSuffix()}.pdf`;
  const body = {
    purpose: 'idPhoto',
    filename,
    contentType: 'application/pdf',
    byteSize: 1024,
    sha256: uniqueSuffix(32) + uniqueSuffix(32),
  };
  const response = await s.request('POST', `/employees/${s.employee.id}/attachments`, {
    ifMatch: s.employee.revision,
    body,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const created = (await response.json()) as { id: string };

  // 走查询构造器：PGlite 与 node-postgres 的 execute 返回形状不同
  const find = (tenantId: string) =>
    withTenant(database().db, tenantId, (tx) =>
      tx
        .select({
          id: personnelAttachments.id,
          filename: personnelAttachments.filename,
          status: personnelAttachments.status,
        })
        .from(personnelAttachments)
        .where(and(eq(personnelAttachments.id, created.id))),
    );
  expect(await find(s.tenant.id)).toEqual([{ id: created.id, filename, status: 'registered' }]);
  expect(await find(other.tenant.id)).toEqual([]);
});
