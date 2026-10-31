import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { eq, setUserStatus, sql, users, withPlatform, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, definition, view, world } from './AC-EXIT-F316-support.js';
import { tenantApi, pinExitGate } from './support/tenant-api.js';

const database = useTestDb();
const path = '/api/tenant/approval/designer/person-candidates';
let x: Awaited<ReturnType<typeof world>>;
let external: string;
let departed: string;
let disabled: string;
let noAccount: string;
let globalDisabled: string;
let linkedExternal: string;
beforeAll(async () => {
  x = await world(database().db, 'f304');
  external = (await x.otherUser()).id;
  const left = await x.person('合成已离职');
  departed = left.userId;
  pinExitGate('seed');
  const employee = await x.session.getEmployee(left.employeeId);
  await x.session.business(
    left.employeeId,
    { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-02' },
    employee.revision,
  );
  const inactive = await x.person('合成停用账号');
  disabled = inactive.userId;
  noAccount = (await x.colleague('合成无账号')).id;
  globalDisabled = (await x.person('合成全局停用')).userId;
  linkedExternal = (await x.person('合成改为外部')).userId;
  const [account] = await withPlatform(x.db, (tx) => tx.select().from(users).where(eq(users.id, globalDisabled)));
  await setUserStatus(
    x.db,
    { userId: globalDisabled, status: 'disabled', expectedRevision: account!.revision },
    { actorUserId: x.processAdmin.id, commandId: randomUUID() },
  );
  // 合成资格反例；不通过真实外部账号或员工造数，租户写入均在 withTenant 中。
  await withTenant(x.db, x.tenantId, async (tx) => {
    await tx.execute(sql`DELETE FROM permission_user_person_links
      WHERE tenant_id=${x.tenantId} AND user_id=${linkedExternal}::uuid`);
    await tx.execute(sql`UPDATE tenant_memberships SET user_type='external', business_identity='合成外部人员'
      WHERE tenant_id=${x.tenantId} AND user_id IN (${external}::uuid, ${linkedExternal}::uuid)`);
    await tx.execute(sql`UPDATE tenant_memberships SET status='revoked'
      WHERE tenant_id=${x.tenantId} AND user_id=${disabled}::uuid`);
    await tx.execute(sql`DELETE FROM permission_user_person_links
      WHERE tenant_id=${x.tenantId} AND employee_id=${noAccount}::uuid`);
  });
});

function candidateApi(allowed = true, at = '2026-10-06T01:00:00Z') {
  return tenantApi(x.db, {
    clock: () => new Date(at),
    authorize: (request) => allowed && request.action === 'admin.process_matrix',
  });
}
const get = (query = '', allowed = true) =>
  candidateApi(allowed).request('GET', `${path}${query}`, x.tenantAs(x.processAdmin.id));
const save = (ids: string[]) =>
  api(x, 'POST', '', 0, {
    ...definition(x, { work_handover: { fallbackUserIds: ids } }),
    code: `F304_${randomUUID().replaceAll('-', '')}`,
    approvalType: 'exit_handover',
  });

describe('AC-APV-F304 DEC-686① 设计器候选与保存同口径', () => {
  it('01 只有流程矩阵能力可读取全租户候选，字段白名单及资格过滤', async () => {
    const response = await get('?page=1&pageSize=200');
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json();
    const ids = body.items.map((item: { userId: string }) => item.userId);
    expect(ids).toContain(x.workOwner.userId);
    expect(ids).toContain(x.hrbp.userId);
    for (const id of [external, linkedExternal, departed, disabled, globalDisabled, noAccount])
      expect(ids).not.toContain(id);
    expect(body.items.map((item: { name: string }) => item.name)).not.toContain('合成无账号');
    for (const item of body.items)
      expect(Object.keys(item).sort()).toEqual(['code', 'departmentId', 'departmentName', 'name', 'userId']);
    expect((await get('', false)).status).toBe(403);
  });
  it('02 搜索、稳定分页和按 userId 回显；无效或异租户 ID 不披露', async () => {
    const first = await get('?page=1&pageSize=1');
    expect(first.status).toBe(200);
    const a = await first.json();
    const b = await (await get('?page=2&pageSize=1')).json();
    expect(a.items).toHaveLength(1);
    expect(b.items).toHaveLength(1);
    expect(a.items[0].userId).not.toBe(b.items[0].userId);
    const search = await (await get(`?keyword=${encodeURIComponent('工作交接人')}`)).json();
    expect(search.items.map((item: { userId: string }) => item.userId)).toEqual([x.workOwner.userId]);
    const stranger = await world(x.db, 'f304-other');
    const ids = [x.workOwner.userId, departed, external, stranger.workOwner.userId];
    const selected = await (await get(`?userIds=${ids.join(',')}`)).json();
    expect(selected.items.map((item: { userId: string }) => item.userId)).toEqual([x.workOwner.userId]);
    expect((await save([stranger.workOwner.userId])).status).toBe(400);
    for (const query of ['?page=0', '?pageSize=201', '?userIds=invalid']) expect((await get(query)).status).toBe(400);
  });
  it('04 租户时区日期边界：候选与保存同时从在职切为离职', async () => {
    for (const [at, eligible] of [
      ['2026-09-02T15:59:59Z', true],
      ['2026-09-02T16:00:00Z', false],
    ] as const) {
      const read = await candidateApi(true, at).request(
        'GET',
        `${path}?userIds=${departed}`,
        x.tenantAs(x.processAdmin.id),
      );
      expect(read.status).toBe(200);
      expect((await read.json()).items).toHaveLength(eligible ? 1 : 0);
      const response = await tenantApi(x.db, { clock: () => new Date(at) }).request(
        'POST',
        '/api/tenant/approval/processes',
        {
          ...x.tenantAs(x.processAdmin.id),
          ifMatch: 0,
          body: {
            ...definition(x, { work_handover: { fallbackUserIds: [departed] } }),
            code: `F304_${randomUUID().replaceAll('-', '')}`,
            approvalType: 'exit_handover',
          },
        },
      );
      expect(response.status, await response.clone().text()).toBe(eligible ? 201 : 400);
    }
  });
  it('03 保存拒绝外部、离职、停用、未知账号，沿用错误码；合格账号可保存重读', async () => {
    for (const id of [external, linkedExternal, departed, disabled, globalDisabled, randomUUID()]) {
      const response = await save([id]);
      expect(response.status, await response.clone().text()).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: 'VALIDATION_FAILED', details: { reason: 'APPROVAL_FALLBACK_USER_INVALID' } },
      });
    }
    const created = await view(await save([x.workOwner.userId]), 201);
    const loaded = await view(await api(x, 'GET', `/${created.id}`));
    expect(loaded.latestVersion.nodes[0]?.fallbackUserIds).toEqual([x.workOwner.userId]);
    expect((await save([x.workOwner.userId, x.workOwner.userId])).status).toBe(400);
    expect((await save(Array.from({ length: 21 }, () => randomUUID()))).status).toBe(400);
  });
});
