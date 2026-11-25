import { and, eq, personnelAttachments, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { personnelSession } from './AC-SUB-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();

// F-576：personnel_attachments 缺 app_user 授权（0024 建表后从未授权）。租户事务内执行身份是 app_user
// （连接身份无论 postgres 还是 app_owner），基线上附件登记路由返回 503。
// 本用例走 HTTP 入口，断言 200 且在本租户落一行、他租户看不到（RLS 不变）。
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

// DEC-067 / AGENTS.md §10：同键同内容视为幂等，同键异内容报冲突。附件登记入口的命令指纹必须带解析后的请求体，
// 否则同员工、同 revision、同 Idempotency-Key 下改文件名 / 摘要仍返回首次回执（误报成功）。
it('AC-PER-F576 附件登记同键同体重放、同键异体 409 且零新增、新键正常登记', async () => {
  const s = await personnelSession(database().db, 'att-idem');
  const make = (name: string) => ({
    purpose: 'idPhoto',
    filename: `${name}-${uniqueSuffix()}.pdf`,
    contentType: 'application/pdf',
    byteSize: 2048,
    sha256: uniqueSuffix(32) + uniqueSuffix(32),
  });
  const register = (body: object, idempotencyKey: string) =>
    s.request('POST', `/employees/${s.employee.id}/attachments`, {
      ifMatch: s.employee.revision,
      idempotencyKey,
      body,
    });
  const count = async () =>
    (
      await withTenant(database().db, s.tenant.id, (tx) =>
        tx
          .select({ id: personnelAttachments.id })
          .from(personnelAttachments)
          .where(eq(personnelAttachments.employeeId, s.employee.id)),
      )
    ).length;
  const key = `att-${uniqueSuffix()}`;
  const first = make('first');
  const created = await register(first, key);
  expect(created.status, await created.clone().text()).toBe(200);
  const firstReceipt = (await created.json()) as { id: string; filename: string };
  expect(await count()).toBe(1);

  const replay = await register(first, key);
  expect(replay.status, await replay.clone().text()).toBe(200);
  expect(await replay.json()).toMatchObject({ id: firstReceipt.id, filename: first.filename });
  expect(await count()).toBe(1);

  const changed = await register(make('second'), key);
  const changedText = await changed.clone().text();
  expect(changed.status, changedText).toBe(409);
  expect(changedText).toContain('IDEMPOTENCY_CONFLICT');
  expect(await count()).toBe(1);

  const second = make('third');
  const fresh = await register(second, `att-${uniqueSuffix()}`);
  expect(fresh.status, await fresh.clone().text()).toBe(200);
  const freshReceipt = (await fresh.json()) as { id: string; filename: string };
  expect(freshReceipt.id).not.toBe(firstReceipt.id);
  expect(freshReceipt.filename).toBe(second.filename);
  expect(await count()).toBe(2);
});
