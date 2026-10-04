/**
 * AC-ORG-13 / AC-ORG-14（DEC-129，`10` §9）：停用上级组织时级联停用整支下级；整支（含本组织与各级下级）
 * 在停用日及以后仍有在职人员或启用中的职位时拒绝停用，错误列出所在组织与人数 / 职位数，不做自动转移。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { auditActions, orgPeopleWorld } from './AC-ORG-people-support.js';

const testDb = useTestDb();

describe('AC-ORG-13 停用组织时级联停用整支下级（DEC-129）', () => {
  it('停用上级：各级下级同一停用日起停用，停用日前仍启用；同级组织不受影响；每个下级追加一个版本并留审计', async () => {
    const { db } = testDb();
    const world = await orgPeopleWorld(db, 'org13cascade');
    const a = await world.org('级联上级');
    const b = await world.org('级联下级', a.id);
    const c = await world.org('级联孙级', b.id);
    const sibling = await world.org('同级部门');
    const response = await world.patchOrg(a, { enabled: false, effectiveDate: '2026-10-02' });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ id: a.id, enabled: false, revision: 2 });
    const before = await world.orgsAt('2026-10-01');
    const after = await world.orgsAt('2026-10-02');
    for (const org of [a, b, c]) {
      expect(before.get(org.id)).toMatchObject({ enabled: true });
      expect(after.get(org.id)).toMatchObject({ enabled: false, startDate: '2026-10-02', revision: 2 });
    }
    expect(after.get(b.id)).toMatchObject({ name: b.name, fullName: b.fullName });
    expect(after.get(sibling.id)).toMatchObject({ enabled: true, revision: 1 });
    for (const org of [b, c]) expect(await auditActions(db, world.tenant.id, org.id)).toContain('org.disable.cascade');
  });

  it('下级已先停用的不再追加版本，只停用仍启用的部分', async () => {
    const world = await orgPeopleWorld(testDb().db, 'org13partial');
    const a = await world.org('部分级联上级');
    const b = await world.org('先停用下级', a.id);
    const c = await world.org('先停用下级的下级', b.id);
    const d = await world.org('仍启用下级', a.id);
    expect((await world.patchOrg(b, { enabled: false, effectiveDate: '2026-10-02' })).status).toBe(200);
    const response = await world.patchOrg(a, { enabled: false, effectiveDate: '2026-10-03' });
    expect(response.status, await response.clone().text()).toBe(200);
    const after = await world.orgsAt('2026-10-03');
    expect(after.get(b.id)).toMatchObject({ enabled: false, startDate: '2026-10-02', revision: 2 });
    expect(after.get(c.id)).toMatchObject({ enabled: false, startDate: '2026-10-02', revision: 2 });
    expect(after.get(d.id)).toMatchObject({ enabled: false, startDate: '2026-10-03', revision: 2 });
  });

  it('设置失效日期同样视为不可用：整支下级自失效日次日起停用', async () => {
    const world = await orgPeopleWorld(testDb().db, 'org13expire');
    const a = await world.org('将失效上级');
    const b = await world.org('将失效下级', a.id);
    const response = await world.patchOrg(a, { stopDate: '2026-10-09', effectiveDate: '2026-10-02' });
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await world.orgsAt('2026-10-09')).get(b.id)).toMatchObject({ enabled: true });
    expect((await world.orgsAt('2026-10-10')).get(b.id)).toMatchObject({ enabled: false, startDate: '2026-10-10' });
  });

  it('整支下级已有未来生效的变更时拒绝停用（不覆盖未来版本），所有组织不变', async () => {
    const world = await orgPeopleWorld(testDb().db, 'org13future');
    const a = await world.org('有未来下级的上级');
    const b = await world.org('有未来变更的下级', a.id);
    expect((await world.patchOrg(b, { name: '下级未来改名', effectiveDate: '2026-10-10' })).status).toBe(200);
    const response = await world.patchOrg(a, { enabled: false, effectiveDate: '2026-10-02' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'ORG_FUTURE_VERSION_EXISTS' } });
    const later = await world.orgsAt('2026-10-10');
    expect(later.get(a.id)).toMatchObject({ enabled: true, revision: 1 });
    expect(later.get(b.id)).toMatchObject({ enabled: true, revision: 2, name: '下级未来改名' });
  });

  it('停用（或已排定停用）的上级下不能新建或启用组织；上级重新启用后可以', async () => {
    const world = await orgPeopleWorld(testDb().db, 'org13parent');
    const a = await world.org('停用后的上级');
    const b = await world.org('随上级停用的下级', a.id);
    expect((await world.patchOrg(a, { enabled: false, effectiveDate: '2026-10-05' })).status).toBe(200);
    const underDisabled = await world.call('POST', 'org/organizations', {
      ifMatch: 0,
      body: { name: '停用上级下新建', establishedOn: '2026-10-06', parents: { admin: { parentId: a.id } } },
    });
    expect(underDisabled.status).toBe(400);
    expect(await underDisabled.json()).toMatchObject({ error: { details: { reason: 'PARENT_UNAVAILABLE' } } });
    const beforeScheduled = await world.call('POST', 'org/organizations', {
      ifMatch: 0,
      body: { name: '排定停用前新建', parents: { admin: { parentId: a.id } } },
    });
    expect(beforeScheduled.status).toBe(400);
    const reenableChild = await world.patchOrg(
      { id: b.id, revision: 2 },
      { enabled: true, effectiveDate: '2026-10-06' },
    );
    expect(reenableChild.status).toBe(400);
    expect(
      (await world.patchOrg({ id: a.id, revision: 2 }, { enabled: true, effectiveDate: '2026-10-06' })).status,
    ).toBe(200);
    const reenabled = await world.patchOrg({ id: b.id, revision: 2 }, { enabled: true, effectiveDate: '2026-10-07' });
    expect(reenabled.status, await reenabled.clone().text()).toBe(200);
  });
});

describe('AC-ORG-14 整支内有在职人员或启用中的职位时拒绝停用（DEC-129）', () => {
  it('列出所在组织与人数 / 职位数，不做自动转移，组织与任职都不变', async () => {
    const world = await orgPeopleWorld(testDb().db, 'org14reject');
    const a = await world.org('有人整支上级');
    const b = await world.org('有职位下级', a.id);
    const c = await world.org('有人员孙级', b.id);
    const post = await world.job('posts', '整支职务');
    await world.job('positions', '下级启用职位', { orgId: b.id, postId: post.id });
    const first = await world.hire('整支员工一', { departmentId: c.id });
    await world.hire('整支员工二', { departmentId: c.id });
    const response = await world.patchOrg(a, { enabled: false, effectiveDate: '2026-10-02' });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string; details: Record<string, unknown> } };
    expect(body.error).toMatchObject({
      code: 'CONFLICT',
      details: {
        reason: 'ORG_SUBTREE_NOT_EMPTY',
        effectiveDate: '2026-10-02',
        organizations: [
          { orgId: b.id, code: b.code, name: b.name, employeeCount: 0, positionCount: 1 },
          { orgId: c.id, code: c.code, name: c.name, employeeCount: 2, positionCount: 0 },
        ],
      },
    });
    const after = await world.orgsAt('2026-10-02');
    for (const org of [a, b, c]) expect(after.get(org.id)).toMatchObject({ enabled: true, revision: 1 });
    const records = await world.employmentRecords(first.id, '2026-10-02');
    expect(records).toHaveLength(1);
    expect(records[0]!.fields).toMatchObject({ departmentId: c.id });
  });

  it('停用本组织本身也校验：在停用日或之后才调入的人员同样计入', async () => {
    const world = await orgPeopleWorld(testDb().db, 'org14future');
    const target = await world.org('将调入部门');
    const origin = await world.org('原所在部门');
    const mover = await world.hire('未来调入员工', { departmentId: origin.id });
    await world.business(
      mover.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-20', fields: { departmentId: target.id } },
      mover.revision,
    );
    const response = await world.patchOrg(target, { enabled: false, effectiveDate: '2026-10-02' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        details: {
          reason: 'ORG_SUBTREE_NOT_EMPTY',
          organizations: [{ orgId: target.id, employeeCount: 1, positionCount: 0 }],
        },
      },
    });
  });

  it('人员在停用日前已离职、职位在停用日前已失效时不再计入，可以停用', async () => {
    const world = await orgPeopleWorld(testDb().db, 'org14cleared');
    const a = await world.org('已清空上级');
    const b = await world.org('已清空下级', a.id);
    const post = await world.job('posts', '已失效职务');
    await world.job('positions', '已失效职位', { orgId: b.id, postId: post.id, stopDate: '2026-10-01' });
    const leaver = await world.hire('已离职员工', { departmentId: b.id });
    await world.business(leaver.id, { kind: 'leave', mode: 'direct', lastWorkDate: '2026-10-01' }, leaver.revision);
    const response = await world.patchOrg(a, { enabled: false, effectiveDate: '2026-10-02' });
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await world.orgsAt('2026-10-02')).get(b.id)).toMatchObject({ enabled: false });
  });
});
