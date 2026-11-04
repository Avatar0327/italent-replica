/** AC-APV-F380 / DEC-691 D5·D6：任意身份展开为审批人；合成数据，租户写入均用 withTenant。 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { sql, withTenant } from '@italent/db';
import { describe, expect, it, vi } from 'vitest';
import { relationWorld, source, resolved, save, type RelationWorld } from './AC-APV-F318c-support.js';
import { permissionAdmin } from './AC-APV-support.js';
import { BASE, createProfile, grant, makeGrantable } from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';
import { eligibleDesignerPeople } from '../../apps/api/src/modules/approval/designer-people.js';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { limitApprovers, resolveSource } from '../../apps/api/src/modules/approval/source-resolver.js';
import { acceptCandidates } from '../../apps/web/src/approval/designer/source-candidates.js';

const database = useTestDb();
const identity = (id: string) => source('identity', id);

/** 同一租户只开通一次管理员（重复开通会撞唯一约束）。 */
const admins = new WeakMap<RelationWorld, ReturnType<typeof permissionAdmin>>();
const adminOf = (w: RelationWorld) => admins.get(w) ?? admins.set(w, permissionAdmin(w)).get(w)!;
/** 建自定义身份并（可选）手工授予若干账号，返回身份与各授权行。 */
async function profileWith(w: RelationWorld, code: string, users: string[]) {
  const admin = await adminOf(w);
  const profile = await createProfile(admin, `${code}${uniqueSuffix()}`);
  await makeGrantable(admin, [profile.id]);
  const grants: { id: string; revision: number }[] = [];
  for (const userId of users) {
    const response = await grant(admin, userId, profile.id);
    expect(response.status, await response.clone().text()).toBe(201);
    grants.push((await response.json()) as { id: string; revision: number });
  }
  return { admin, profile, grants };
}
/** 可信夹具：直接写入租户的标准身份行（开通流程之外的合成数据）。 */
async function standardProfile(w: RelationWorld, code: string) {
  const id = randomUUID();
  await withTenant(w.db, w.tenant.id, (tx) =>
    tx.execute(sql`INSERT INTO permission_profiles (id,tenant_id,code,name,source)
      VALUES (${id}::uuid,${w.tenant.id},${code},${`标准${code}`},'standard')`),
  );
  return id;
}

describe('AC-APV-F380 身份展开', () => {
  it('手工授权身份：展开全部有效成员，撤权实时生效，不按数据范围反筛', async () => {
    const w = await relationWorld(database().db, 'f380-manual');
    const { admin, profile, grants } = await profileWith(w, 'f380m', [w.head.userId, w.near.userId, w.subject.userId]);
    expect(await resolved(w, identity(profile.id))).toEqual([w.head.userId, w.near.userId, w.subject.userId].sort());
    const revoked = await admin.api.request('POST', `${BASE}/grants/${grants[2]!.id}/revoke`, {
      ...admin.asAdmin,
      ifMatch: grants[2]!.revision,
    });
    expect(revoked.status).toBe(200);
    expect(await resolved(w, identity(profile.id))).toEqual([w.head.userId, w.near.userId].sort());
  });

  it('无有效授权的身份解析为空；账号未绑定在职人员的授权不作为审批人', async () => {
    const w = await relationWorld(database().db, 'f380-empty');
    const { profile } = await profileWith(w, 'f380e', [w.exceptionAdmin]);
    expect(await resolved(w, identity(profile.id))).toEqual([]);
    const none = await profileWith(w, 'f380n', []);
    expect(await resolved(w, identity(none.profile.id))).toEqual([]);
  });

  it('标准自动持有“员工”按全体在职内部账号成立；同编码自定义身份只认授权行', async () => {
    const w = await relationWorld(database().db, 'f380-employee');
    const employee = await standardProfile(w, 'employee_self_service');
    const everyone = [w.head.userId, w.near.userId, w.subject.userId].sort();
    expect(await resolved(w, identity(employee))).toEqual(everyone);
    const custom = await profileWith(w, 'employee_self_service_x', [w.head.userId]);
    expect(await resolved(w, identity(custom.profile.id))).toEqual([w.head.userId]);
  });

  it('经理自助是即时派生身份：负责人成立且不依赖授权行，授权成员并入', async () => {
    const w = await relationWorld(database().db, 'f380-manager');
    const { admin } = await profileWith(w, 'f380x', []);
    const profile = await createProfile(admin, 'department_manager_self_service');
    expect(await resolved(w, identity(profile.id))).toEqual([w.head.userId, w.near.userId].sort());
    await makeGrantable(admin, [profile.id]);
    expect((await grant(admin, w.subject.userId, profile.id)).status).toBe(201);
    expect(await resolved(w, identity(profile.id))).toEqual([w.head.userId, w.near.userId, w.subject.userId].sort());
  });

  it('D5 身份取全部成员而交接 HR 管理员命名值仍只取第一人', async () => {
    const w = await relationWorld(database().db, 'f380-hr-admin');
    const hr = await standardProfile(w, 'standard_hr_admin');
    const admin = await adminOf(w);
    await makeGrantable(admin, [hr]);
    for (const user of [w.head.userId, w.near.userId]) expect((await grant(admin, user, hr)).status).toBe(201);
    expect(await resolved(w, identity(hr))).toHaveLength(2);
    expect(await resolved(w, source('identity', 'handover_hr_admin'))).toHaveLength(1);
  });

  it('D6 保存校验：身份必须存在于本租户，未映射者 422，不静默当空人', async () => {
    const w = await relationWorld(database().db, 'f380-save');
    const other = await relationWorld(database().db, 'f380-save-other');
    const mine = await profileWith(w, 'f380s', [w.head.userId]);
    const foreign = await profileWith(other, 'f380f', [other.head.userId]);
    expect((await save(w, [identity(mine.profile.id)])).status).toBe(201);
    for (const value of [foreign.profile.id, randomUUID(), 'not-a-profile', `${mine.profile.id}:descendants`]) {
      const response = await save(w, [identity(value)]);
      expect(response.status, value).toBe(422);
      expect((await response.json()).error.message).not.toContain('待 F-318c');
    }
    expect(await resolved(w, identity(foreign.profile.id))).toEqual([]);
  });

  it('单人节点解析出多名成员明确 422 提示改用会签；会签可保存并派单', async () => {
    const w = await relationWorld(database().db, 'f380-single');
    const { profile } = await profileWith(w, 'f380o', [w.head.userId, w.near.userId]);
    await w.publishedProcess({ nodes: [{ key: 'one', approver: identity(profile.id) }] });
    const response = await w.submitRaw(await w.application(w.subject.employeeId, { departmentId: w.staff }));
    expect(response.status).toBe(422);
    expect((await response.json()).error.message).toContain('会签');
  });

  it('成员超过 200 时来源层不截断，会签合并后真实派单只取 100', async () => {
    const w = await relationWorld(database().db, 'f380-many');
    const { profile } = await profileWith(w, 'f380b', []);
    const users: string[] = [];
    for (let i = 0; i < 201; i++) users.push((await w.person(`合成成员${i}`, w.staff)).userId);
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`INSERT INTO permission_grants (tenant_id,user_id,profile_id,source,status)
        SELECT ${w.tenant.id},u::uuid,${profile.id}::uuid,'manual','active'
        FROM unnest(${`{${users.join(',')}}`}::text[]) u`),
    );
    expect(await resolved(w, identity(profile.id))).toEqual([...users].sort());
    await w.publishedProcess({
      nodes: [{ key: 'many', kind: 'countersign', approvers: [identity(profile.id)], transitionRule: { type: 'all' } }],
    });
    const instance = await w.submit(await w.application(w.subject.employeeId, { departmentId: w.staff }));
    const ids = w.pending(instance).map((t) => t.assigneeUserId);
    expect(ids).toHaveLength(100);
    expect(ids.every((id) => users.includes(id!))).toBe(true);
  }, 300_000);

  it('AC-APV-F380：501 名有效成员正序与逆序返回时，同一 seed 抽取相同 100 人', async () => {
    const w = await relationWorld(database().db, 'f380-stable');
    const { profile } = await profileWith(w, 'f380stable', []);
    const users: string[] = [];
    for (let i = 0; i < 501; i++) users.push((await w.person(`合成稳定成员${i}`, w.staff)).userId);
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`INSERT INTO permission_grants (tenant_id,user_id,profile_id,source,status)
        SELECT ${w.tenant.id},u::uuid,${profile.id}::uuid,'manual','active'
        FROM unnest(${`{${users.join(',')}}`}::text[]) u`),
    );
    const eligible = await withTenant(w.db, w.tenant.id, (tx) =>
      eligibleDesignerPeople(tx, w.tenant.id, { userIds: users, limit: 501, offset: 0, asOf: '2026-10-01' }),
    );
    expect(eligible).toHaveLength(501);
    // 用真实资格查询顺序及其逆序造输入，避免随机 UUID 恰好使两次抽样重合。
    const order = new Map(eligible.map((person, index) => [person.userId, index]));
    const sample = (direction: 1 | -1) =>
      withTenant(w.db, w.tenant.id, async (tx) => {
        const execute = tx.execute.bind(tx);
        let reordered = 0;
        // 只改变真实成员查询的返回顺序；资格查询、500 人切批与固定 seed 抽样均执行生产逻辑。
        const spy = vi.spyOn(tx, 'execute').mockImplementation((async (query) => {
          const result = await execute(query);
          const rows = rowsOf<{ user_id: string }>(result);
          if (rows.length && Object.keys(rows[0]!).length === 1 && 'user_id' in rows[0]!) {
            rows.sort((a, b) => direction * (order.get(a.user_id)! - order.get(b.user_id)!));
            reordered += rows.length;
          }
          return result;
        }) as typeof tx.execute);
        try {
          const candidates = await resolveSource(
            tx,
            {
              tenantId: w.tenant.id,
              asOf: '2026-10-01',
              initiatorUserId: w.hr.id,
              subjectEmployeeId: w.subject.employeeId,
              latestDepartmentId: w.child,
              recordDepartmentId: w.child,
            },
            identity(profile.id),
          );
          expect(reordered).toBe(501);
          expect(candidates.map((candidate) => candidate.userId).sort()).toEqual([...users].sort());
          const sampled = limitApprovers(candidates, (candidate) => candidate.userId, 'f380-instance:1:many');
          expect(sampled).toHaveLength(100);
          return sampled.map((candidate) => candidate.userId).sort();
        } finally {
          spy.mockRestore();
        }
      });
    const ascending = await sample(1);
    const descending = await sample(-1);
    expect(descending, '同一成员集合和 seed 的最终 100 人集合必须一致').toEqual(ascending);
  }, 300_000);

  it('身份候选：仅流程编辑者可读、最少字段、分页搜索、跨租户不回显', async () => {
    const w = await relationWorld(database().db, 'f380-candidates');
    const other = await relationWorld(database().db, 'f380-candidates-other');
    const mine = await profileWith(w, 'f380c', []);
    const foreign = await profileWith(other, 'f380d', []);
    const get = (query: string, allow = true, type = 'identity') =>
      tenantApi(w.db, { authorize: (q) => allow && q.action === 'admin.process_matrix', clock: w.clock }).request(
        'GET',
        `/api/tenant/approval/designer/source-candidates?type=${type}&asOf=2026-10-01&${query}`,
        w.as(w.hr.id),
      );
    expect((await get('', false)).status).toBe(403);
    const listed = await get(`ids=${mine.profile.id},${foreign.profile.id}`);
    expect(listed.status, await listed.clone().text()).toBe(200);
    const found = await listed.json();
    expect(found.items.map((item: { id: string }) => item.id)).toEqual([mine.profile.id]);
    expect(Object.keys(found.items[0]).sort()).toEqual(['enabled', 'id', 'name', 'parentId']);
    const keyword = await (await get(`keyword=${encodeURIComponent(`身份${mine.profile.code}`)}`)).json();
    expect(keyword.items.map((item: { id: string }) => item.id)).toContain(mine.profile.id);
    expect((await get('pageSize=1')).status).toBe(200);
    // F-396：前端候选解析（acceptCandidates）直接吃后端真实响应，身份与部门两类都要被接受且逐项不丢字段。
    expect(acceptCandidates(found).items).toEqual(found.items);
    const departments = await (await get('', true, 'department')).json();
    expect(departments.items.length).toBeGreaterThan(0);
    expect(acceptCandidates(departments).items).toEqual(departments.items);
  });
});
