/**
 * F-474-5 #27（R1bd §2.15，转03）：数据变更日志增加「TraceID」「应用（来源模块）」筛选。
 * 筛选只在查看人当前可见的范围内生效（DEC-197）：范围外的日志不因筛选命中而泄露；
 * 保持游标分页；租户隔离。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { addMember, BASE, type PermissionWorld, seedPermissionWorld } from './AC-PRM-support.js';
import { hrApi, memberWithAdminRole } from './AC-PRM-users-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const LIVE = () => new Date();

async function adminWith(world: PermissionWorld, traceId: string, role: 'user_admin' | 'matrix_admin') {
  const member = await addMember(world, `f474-5-${role}`);
  const response = await world.api.request('POST', `${BASE}/admins`, {
    ...world.asAdmin,
    headers: { 'x-trace-id': traceId },
    body: { userId: member.id, role, grantableAdminRoles: [], grantableProfileIds: [] },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return member;
}

describe('F-474-5 #27 数据变更日志：TraceID / 应用筛选', () => {
  let world: PermissionWorld;
  let auditor: Awaited<ReturnType<typeof memberWithAdminRole>>;
  let audit: ReturnType<typeof auditApi>;
  const traceA = `trace-a-${uniqueSuffix()}`;
  const traceB = `trace-b-${uniqueSuffix()}`;

  beforeAll(async () => {
    world = await seedPermissionWorld(database().db);
    auditor = await memberWithAdminRole(world, 'audit_admin', 'f474-5-auditor');
    audit = auditApi(world.db, LIVE, { authorize: undefined });
    await adminWith(world, traceA, 'user_admin');
    await adminWith(world, traceA, 'matrix_admin');
    await adminWith(world, traceB, 'user_admin');
    // 同一 TraceID 下另有一条人员档案日志：审计管理员没有人员数据范围，必须一直看不到（不因筛选泄露）
    const hr = hrApi(world);
    const created = await hr.api.request('POST', '/api/tenant/employment/employees', {
      ...world.asAdmin,
      ifMatch: 0,
      headers: { 'x-trace-id': traceA },
      body: { code: `E_${randomUUID().replaceAll('-', '')}`, name: '范围外人员' },
    });
    expect(created.status, await created.clone().text()).toBe(201);
  });

  it('按 TraceID 精确筛选：只返回命中且可见的日志，范围外同 TraceID 的日志不出现', async () => {
    const a = await audit.dataChanges(auditor.as, { traceId: traceA, limit: '100' });
    expect(a.items.length).toBeGreaterThanOrEqual(2);
    expect(a.items.every((item) => item.traceId === traceA)).toBe(true);
    expect(a.items.every((item) => item.app === '企业设置')).toBe(true);
    const b = await audit.dataChanges(auditor.as, { traceId: traceB, limit: '100' });
    expect(b.items.length).toBeGreaterThanOrEqual(1);
    expect(b.items.every((item) => item.traceId === traceB)).toBe(true);
    expect((await audit.dataChanges(auditor.as, { traceId: `none-${uniqueSuffix()}` })).items).toEqual([]);
  });

  it('TraceID 不合法 → 400；不是模糊匹配（前缀不命中）', async () => {
    const bad = await audit.get(`/data-changes?${new URLSearchParams({ traceId: 'a b/c' })}`, auditor.as);
    expect(bad.status).toBe(400);
    const prefix = await audit.dataChanges(auditor.as, { traceId: traceA.slice(0, -3) });
    expect(prefix.items).toEqual([]);
  });

  it('按应用筛选：企业设置命中配置类日志；范围外的「组织员工」应用对审计管理员为空', async () => {
    const enterprise = await audit.dataChanges(auditor.as, { app: '企业设置', limit: '100' });
    expect(enterprise.items.length).toBeGreaterThan(0);
    expect(enterprise.items.every((item) => item.app === '企业设置')).toBe(true);
    expect((await audit.dataChanges(auditor.as, { app: '组织员工', limit: '100' })).items).toEqual([]);
    expect((await audit.dataChanges(auditor.as, { app: '审批中心', limit: '100' })).items).toEqual([]);
  });

  it('应用不在可选集合里 → 400，不静默返回空', async () => {
    const response = await audit.get(`/data-changes?${new URLSearchParams({ app: '不存在的应用' })}`, auditor.as);
    expect(response.status).toBe(400);
  });

  it('响应带可选应用清单，供前端下拉', async () => {
    const response = await audit.get('/data-changes?limit=1', auditor.as);
    const body = (await response.json()) as { apps: string[] };
    expect(body.apps).toEqual(expect.arrayContaining(['企业设置', '组织员工', '审批中心']));
  });

  it('TraceID 与应用叠加后仍走游标分页：不重不漏', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: Record<string, string> = { traceId: traceA, app: '企业设置', limit: '1' };
      const page = await audit.dataChanges(auditor.as, cursor ? { ...query, cursor } : query);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    const all = await audit.dataChanges(auditor.as, { traceId: traceA, app: '企业设置', limit: '100' });
    expect(seen.length).toBe(all.items.length);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('租户隔离：另一租户同一 TraceID 的日志不会出现', async () => {
    const other = await seedPermissionWorld(world.db);
    await adminWith(other, traceA, 'user_admin');
    const mine = await audit.dataChanges(auditor.as, { traceId: traceA, limit: '100' });
    const theirs = await auditApi(other.db, LIVE, { authorize: undefined }).dataChanges(other.asAdmin, {
      traceId: traceA,
      limit: '100',
    });
    expect(theirs.items.length).toBeGreaterThan(0);
    const mineIds = new Set(mine.items.map((item) => item.id));
    expect(theirs.items.some((item) => mineIds.has(item.id))).toBe(false);
  });
});
