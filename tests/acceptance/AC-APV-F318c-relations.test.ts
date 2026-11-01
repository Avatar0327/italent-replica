/** AC-APV-F318c / DEC-691 D1-D4,D7-D8：七类组织 / 任职来源，不含延期的身份 c2。 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  relationWorld,
  orgVersion,
  dimensions,
  source,
  resolved,
  job,
  stopJob,
  change,
} from './AC-APV-F318c-support.js';

const database = useTestDb();
describe('AC-APV-F318c 业务日关系解析', () => {
  it('D1 包含下级分别取最近负责人，未勾选只从选中节点取人；重复负责人去重', async () => {
    const w = await relationWorld(database().db, 'c-org');
    expect(await resolved(w, source('department', w.root))).toEqual([w.head.userId]);
    expect(await resolved(w, source('department', w.root, ':descendants'))).toEqual(
      [w.head.userId, w.near.userId].sort(),
    );
    await w.setOrgRoles(w.child, { head: w.head.employeeId });
    expect(await resolved(w, source('department', w.root, ':descendants'))).toEqual([w.head.userId]);
  });
  it('D2 穿越空人和停用组织，允许越过所选根；到维度根仍无人则为空', async () => {
    const w = await relationWorld(database().db, 'c-up');
    const leaf = await w.org('合成叶子', w.child);
    await orgVersion(w, w.child, { enabled: false });
    expect(await resolved(w, source('department', leaf))).toEqual([w.head.userId]);
    await w.setOrgRoles(w.root, { head: null });
    expect(await resolved(w, source('department', leaf))).toEqual([]);
  });
  it('D2 负责人当前不合格则向上，不绕过外部成员 / 无账号资格', async () => {
    const w = await relationWorld(database().db, 'c-eligibility');
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`DELETE FROM permission_user_person_links
      WHERE tenant_id=${w.tenant.id} AND employee_id=${w.near.employeeId}`),
    );
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`UPDATE tenant_memberships SET
      user_type='external',business_identity='合成外部' WHERE tenant_id=${w.tenant.id} AND user_id=${w.near.userId}`),
    );
    expect(await resolved(w, source('department', w.child))).toEqual([w.head.userId]);
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`DELETE FROM permission_user_person_links
      WHERE tenant_id=${w.tenant.id} AND employee_id=${w.head.employeeId}`),
    );
    expect(await resolved(w, source('department', w.child))).toEqual([]);
  });
  it('D7 历史负责人现已离职仍排除，继续向上找实时合格账号', async () => {
    const w = await relationWorld(database().db, 'c-departed');
    const employee = await w.json<{ revision: number }>(
      await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${w.near.employeeId}`),
    );
    await w.json(
      await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${w.near.employeeId}/businesses`, {
        ifMatch: employee.revision,
        body: { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-01', fields: {} },
      }),
      201,
    );
    expect(await resolved(w, source('department', w.child), '2026-08-01')).toEqual([w.head.userId]);
  });
  it.each([
    ['business_org', 'business'],
    ['profit_center', 'product'],
    ['reserve4', 'reserve4'],
    ['reserve5', 'reserve5'],
  ] as const)('五维 %s 使用自己的父链和后代，不借行政或成本中心', async (type, dimension) => {
    const w = await relationWorld(database().db, `c-${type}`);
    await dimensions(w);
    await orgVersion(w, w.root, {}, { [dimension]: w.tenant.id });
    await orgVersion(w, w.child, { personInChargeId: null }, { [dimension]: w.root, admin: w.staff });
    expect(await resolved(w, source(type, w.child))).toEqual([w.head.userId]);
    expect(await resolved(w, source('department', w.child))).toEqual([]);
    expect(await resolved(w, source(type, w.root, ':descendants'))).toEqual([w.head.userId]);
    await dimensions(w, false);
    expect(await resolved(w, source(type, w.child))).toEqual([]);
  });
  it('D7 负责人及父链取业务日版本，不取最新；未来尚不存在的组织不倒灌', async () => {
    const w = await relationWorld(database().db, 'c-org-date');
    await orgVersion(w, w.root, { startDate: '2026-09-01', personInChargeId: w.near.employeeId });
    expect(await resolved(w, source('department', w.root), '2026-08-01')).toEqual([w.head.userId]);
    expect(await resolved(w, source('department', w.root), '2026-10-01')).toEqual([w.near.userId]);
    expect(await resolved(w, source('department', w.root), '1900-01-01')).toEqual([]);
    await w.setOrgRoles(w.child, { head: null });
    await orgVersion(w, w.child, { startDate: '2026-09-01' }, { admin: w.staff });
    expect(await resolved(w, source('department', w.child), '2026-08-01')).toEqual([w.head.userId]);
    expect(await resolved(w, source('department', w.child), '2026-10-01')).toEqual([]);
  });
  it('D3 职位 / 普通职务取全部当日主职；历史与最新不同；D4 停用不回退旧启用版', async () => {
    const w = await relationWorld(database().db, 'c-job-date');
    const post = await job(w, 'posts');
    const position = await job(w, 'positions', { postId: post.id, orgId: w.staff });
    await change(w, w.head.employeeId, { positionId: position.id, postId: post.id }, '2026-07-01');
    await change(w, w.head.employeeId, { positionId: null, postId: null }, '2026-09-01');
    expect(await resolved(w, source('position', position.id), '2026-08-01')).toEqual([w.head.userId]);
    expect(await resolved(w, source('job', post.id), '2026-08-01')).toEqual([w.head.userId]);
    expect(await resolved(w, source('position', position.id))).toEqual([]);
    await stopJob(w, 'position', position.id, '2026-08-15');
    expect(await resolved(w, source('position', position.id), '2026-08-20')).toEqual([]);
    expect(await resolved(w, source('position', position.id), '2026-08-01')).toEqual([w.head.userId]);
  });
  it('D3 相对职务只取最近一层全部主职任职者，近远都有时不叠加远层', async () => {
    const w = await relationWorld(database().db, 'c-relative');
    const post = await job(w, 'posts');
    const near2 = await w.person('合成同层丙', w.child, { postId: post.id });
    await change(w, w.near.employeeId, { postId: post.id }, '2026-07-01');
    await change(w, w.head.employeeId, { departmentId: w.root, postId: post.id }, '2026-07-01');
    expect(await resolved(w, source('job', post.id, ':relative'))).toEqual([w.near.userId, near2.userId].sort());
    expect(await resolved(w, source('job', post.id))).toEqual([w.near.userId, near2.userId, w.head.userId].sort());
    await change(w, w.subject.employeeId, { departmentId: w.staff }, '2026-09-01');
    expect(await resolved(w, source('job', post.id, ':relative'))).toEqual([]);
    expect(await resolved(w, source('job', post.id, ':relative'), '2026-08-01')).toEqual(
      [w.near.userId, near2.userId].sort(),
    );
  });
});
