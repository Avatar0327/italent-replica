import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { approvalWorld, grantFieldAccess, permissionAdmin, type Person } from './AC-APV-support.js';
import { memberWithAdminRole } from './AC-PRM-users-support.js';
import { auditApi } from './AC-AUD-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
let w: Awaited<ReturnType<typeof approvalWorld>>;
let api: ReturnType<typeof tenantApi>;
let audit: ReturnType<typeof auditApi>;
let viewer: Awaited<ReturnType<typeof memberWithAdminRole>>;
let inside: string;
let outside: string;
let mine: { id: string; command: string };
let theirs: { id: string; command: string };
async function submit(person: Person, departmentId: string) {
  const command = randomUUID();
  const profile = await w.json<{ employee: { revision: number } }>(
    await api.request('GET', '/api/tenant/self-service/profile', w.as(person.userId)),
  );
  const options = {
    ...w.as(person.userId),
    ifMatch: profile.employee.revision,
    idempotencyKey: command,
    body: { effectiveDate: '2026-10-19', fields: { departmentId } },
  };
  const result = await w.json<{ id: string }>(
    await api.request('POST', '/api/tenant/self-service/transfer', options),
    201,
  );
  expect((await api.request('POST', '/api/tenant/self-service/transfer', options)).status).toBe(201);
  return { ...result, command };
}
beforeAll(async () => {
  w = await approvalWorld(database().db, 'self-audit');
  api = tenantApi(database().db, { authorize: undefined, clock: w.clock });
  audit = auditApi(database().db, w.clock, { authorize: undefined });
  inside = await w.org('合成审计范围内');
  outside = await w.org('合成审计范围外');
  const self = await w.person('合成本人', inside, { place: '隐藏原地址' });
  const other = await w.person('合成范围外本人', outside);
  await w.publishedProcess({ nodes: [{ key: 'review', approver: 'owner' }] });
  const admin = await permissionAdmin(w);
  viewer = await memberWithAdminRole(admin, 'audit_admin', 'self-auditor');
  await grantFieldAccess(admin, viewer.user.id, { view: ['effectiveDate', 'departmentId', 'transferTypeCode'] });
  await w.json(
    await admin.api.request('PUT', `/api/tenant/permission/scopes/${viewer.user.id}/TenantBase`, {
      ...admin.asAdmin,
      ifMatch: 0,
      body: { kind: 'org_range', orgRanges: [{ orgId: inside, includeDescendants: false }] },
    }),
  );
  mine = await submit(self, inside);
  theirs = await submit(other, outside);
});

describe('AC-TRF-46 / DEC-216 员工调动审计接入', () => {
  it('写入口记录任职与调动审计，命令重放不重复；有权可见', async () => {
    const rows = await withTenant(database().db, w.tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT action FROM audit_events
        WHERE tenant_id=${w.tenant.id} AND command_id=${mine.command}`);
      return (Array.isArray(result) ? result : result.rows) as { action: string }[];
    });
    for (const action of [
      'employment.business.create',
      'transfer.request.create',
      'employment.business.state.in_review',
    ])
      expect(rows.filter((row) => row.action === action)).toHaveLength(1);
    const logs = await audit.dataChanges(viewer.as, { objectId: mine.id });
    expect(logs.items.map((item) => item.objectType)).toEqual(
      expect.arrayContaining(['employment-business', 'transfer-request']),
    );
  });

  it('范围外申请不返回；已知日志 ID 的详情也不可读', async () => {
    expect((await audit.dataChanges(viewer.as, { objectId: theirs.id })).items).toEqual([]);
    const id = await withTenant(database().db, w.tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT id FROM audit_events WHERE object_id=${theirs.id} LIMIT 1`);
      return ((Array.isArray(result) ? result : result.rows) as { id: string }[])[0]!.id;
    });
    expect((await audit.get(`/data-changes/${id}`, viewer.as)).status).toBe(404);
  });

  it('隐藏字段不出现在差异、文本、前后值；筛选隐藏字段不可探测', async () => {
    const logs = await audit.dataChanges(viewer.as, { objectId: mine.id, action: 'employment.business.create' });
    expect(logs.items).toHaveLength(1);
    const detail = await audit.dataChange(viewer.as, logs.items[0]!.id);
    expect(JSON.stringify(detail)).not.toContain('隐藏原地址');
    expect(detail.changes.some((change) => change.field.endsWith('place'))).toBe(false);
    expect((await audit.dataChanges(viewer.as, { objectId: mine.id, field: 'place' })).items).toEqual([]);
  });
});
