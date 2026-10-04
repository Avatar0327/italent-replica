/**
 * AC-ORG-20（DEC-147，`10` §18 W-439～W-442）：组织建成后可在「编辑」（更正、不产生新版本）中修改设立日期，
 * 首版生效日随之变化；「变更」中没有该字段。保存时照搬原站两条拦截——①须早于后一个版本的生效日；
 * ②不得早于上级组织的设立日——另加③不得晚于本组织最早一条任职 / 职位记录的开始日（复刻加严）。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { auditActions, orgPeopleWorld, type OrgPeopleWorld } from './AC-ORG-people-support.js';

const testDb = useTestDb();

interface Target {
  readonly id: string;
  readonly revision: number;
}

function correct(world: OrgPeopleWorld, target: Target, establishedOn: unknown) {
  return world.call('PATCH', `org/organizations/${target.id}/correction`, {
    ifMatch: target.revision,
    body: { establishedOn },
  });
}

async function rejected(response: Response, reason: string, message: string) {
  expect(response.status, await response.clone().text()).toBe(400);
  const body = (await response.json()) as { error: { message: string; details: Record<string, unknown> } };
  expect(body.error).toMatchObject({ details: { reason, fields: { establishedOn: expect.any(String) } } });
  expect(body.error.message).toBe(message);
}

async function versioned(label: string) {
  const world = await orgPeopleWorld(testDb().db, label);
  const org = await world.org('编辑设立部门', world.tenant.id, { establishedOn: '2026-09-01' });
  const renamed = await world.patchOrg(org, { name: '编辑设立部门V2', effectiveDate: '2026-10-08' });
  expect(renamed.status, await renamed.clone().text()).toBe(200);
  return { world, org: { id: org.id, revision: 2 } };
}

describe('AC-ORG-20 在「编辑」中修改设立日期（DEC-147）', () => {
  it('改早：首版生效日随设立日期提前，各版本的设立日期一起更正，不新增版本', async () => {
    const { world, org } = await versioned('org20earlier');
    const response = await correct(world, org, '2026-08-20');
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      id: org.id,
      name: '编辑设立部门',
      establishedOn: '2026-08-20',
      startDate: '2026-08-20',
      stopDate: '9999-12-31',
      revision: 3,
    });
    expect((await world.orgsAt('2026-08-19')).has(org.id)).toBe(false);
    expect((await world.orgsAt('2026-08-20')).get(org.id)).toMatchObject({
      name: '编辑设立部门',
      establishedOn: '2026-08-20',
      startDate: '2026-08-20',
    });
    expect((await world.orgsAt('2026-10-08')).get(org.id)).toMatchObject({
      name: '编辑设立部门V2',
      establishedOn: '2026-08-20',
      startDate: '2026-10-08',
      revision: 3,
    });
    expect(await auditActions(testDb().db, world.tenant.id, org.id)).toContain('org.established-on.correct');
  });

  it('改晚（W-441）：设立日期前查不到，首版自新设立日起生效；再改回原值（W-442）', async () => {
    const { world, org } = await versioned('org20later');
    const later = await correct(world, org, '2026-09-05');
    expect(later.status, await later.clone().text()).toBe(200);
    expect((await world.orgsAt('2026-09-04')).has(org.id)).toBe(false);
    expect((await world.orgsAt('2026-09-05')).get(org.id)).toMatchObject({
      establishedOn: '2026-09-05',
      startDate: '2026-09-05',
    });
    const back = await correct(world, { id: org.id, revision: 3 }, '2026-09-01');
    expect(back.status, await back.clone().text()).toBe(200);
    expect((await world.orgsAt('2026-09-01')).get(org.id)).toMatchObject({
      establishedOn: '2026-09-01',
      startDate: '2026-09-01',
      revision: 4,
    });
  });

  it('①不得晚于或等于后一个版本的生效日（W-439）', async () => {
    const { world, org } = await versioned('org20next');
    for (const establishedOn of ['2026-10-10', '2026-10-08']) {
      await rejected(
        await correct(world, org, establishedOn),
        'ESTABLISHED_ON_NOT_BEFORE_NEXT_VERSION',
        '请将设立日期调整至 2026-10-08 之前——设立日期须早于后一条组织记录的生效日期（2026-10-08）',
      );
    }
    expect((await world.orgsAt('2026-09-01')).get(org.id)).toMatchObject({ establishedOn: '2026-09-01', revision: 2 });
  });

  it('②不得早于上级组织的设立日（W-440）', async () => {
    const world = await orgPeopleWorld(testDb().db, 'org20parent');
    const parent = await world.org('PRM_X 上级', world.tenant.id, { establishedOn: '2026-09-01' });
    const child = await world.org('PRM_X1 下级', parent.id, { establishedOn: '2026-09-01' });
    await rejected(
      await correct(world, child, '2026-08-25'),
      'ESTABLISHED_ON_BEFORE_PARENT',
      '请将设立日期调整至 2026-09-01 及以后——设立日期须晚于等于上级组织【PRM_X 上级】的设立日期（2026-09-01），' +
        '若需调整，请同时调整该组织全部上级组织的设立日期',
    );
    const moved = await correct(world, parent, '2026-08-01');
    expect(moved.status, await moved.clone().text()).toBe(200);
    const ok = await correct(world, child, '2026-08-25');
    expect(ok.status, await ok.clone().text()).toBe(200);
  });

  it('③不得晚于本组织最早一条任职或职位记录的开始日（复刻加严）', async () => {
    const world = await orgPeopleWorld(testDb().db, 'org20records');
    const staffed = await world.org('有任职部门', world.tenant.id, { establishedOn: '2026-09-01' });
    await world.hire('九月十日入职', { departmentId: staffed.id }, '2026-09-10');
    await rejected(
      await correct(world, staffed, '2026-09-11'),
      'ESTABLISHED_ON_AFTER_RECORDS',
      '请将设立日期调整至 2026-09-10 及以前——本组织已有自 2026-09-10 起的任职或职位记录',
    );
    expect((await correct(world, staffed, '2026-09-10')).status).toBe(200);

    const positioned = await world.org('有职位部门', world.tenant.id, { establishedOn: '2026-09-01' });
    const post = await world.job('posts', '职位所属职务', { startDate: '2026-09-01' });
    await world.job('positions', '九月十二日职位', { orgId: positioned.id, postId: post.id, startDate: '2026-09-12' });
    await rejected(
      await correct(world, positioned, '2026-09-13'),
      'ESTABLISHED_ON_AFTER_RECORDS',
      '请将设立日期调整至 2026-09-12 及以前——本组织已有自 2026-09-12 起的任职或职位记录',
    );
  });

  it('下级组织挂靠早于新设立日时同样拒绝（层级完整性，复刻加严）', async () => {
    const world = await orgPeopleWorld(testDb().db, 'org20child');
    const parent = await world.org('有下级部门', world.tenant.id, { establishedOn: '2026-09-01' });
    await world.org('九月三日下级', parent.id, { establishedOn: '2026-09-03' });
    await rejected(
      await correct(world, parent, '2026-09-05'),
      'ESTABLISHED_ON_AFTER_CHILD',
      '请将设立日期调整至 2026-09-03 及以前——已有下级组织自 2026-09-03 起挂在本组织下',
    );
  });

  it('设立日期必填、须为日期；revision 不符 409；同一命令重放不重复更正', async () => {
    const { world, org } = await versioned('org20guard');
    for (const establishedOn of [null, '2026-02-30', 20260901]) {
      const response = await correct(world, org, establishedOn);
      expect(response.status, await response.clone().text()).toBe(400);
    }
    const unknownField = await world.call('PATCH', `org/organizations/${org.id}/correction`, {
      ifMatch: org.revision,
      body: { establishedOn: '2026-08-31', name: '不可在此修改' },
    });
    expect(unknownField.status).toBe(400);
    expect((await correct(world, { id: org.id, revision: 1 }, '2026-08-31')).status).toBe(409);
    const key = randomUUID();
    const send = () =>
      world.call('PATCH', `org/organizations/${org.id}/correction`, {
        ifMatch: org.revision,
        idempotencyKey: key,
        body: { establishedOn: '2026-08-31' },
      });
    const first = await send();
    expect(first.status, await first.clone().text()).toBe(200);
    const replay = await send();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await first.json());
    expect((await world.orgsAt('2026-08-31')).get(org.id)).toMatchObject({ revision: 3 });
  });

  it('「变更」中没有设立日期：原样提交放行，改动或清空一律 400，提示到「编辑」中修改', async () => {
    const { world, org } = await versioned('org20change');
    const same = await world.patchOrg(org, {
      establishedOn: '2026-09-01',
      remarks: '原样提交',
      effectiveDate: '2026-10-09',
    });
    expect(same.status, await same.clone().text()).toBe(200);
    for (const establishedOn of ['2026-08-01', null]) {
      const changed = await world.patchOrg({ id: org.id, revision: 3 }, { establishedOn, effectiveDate: '2026-10-10' });
      expect(changed.status).toBe(400);
      expect(await changed.json()).toMatchObject({ error: { details: { reason: 'ESTABLISHED_ON_EDIT_ONLY' } } });
    }
  });

  it('改早不得落入上级停用期（DEC-129：启用组织不能挂在不可用的上级下）', async () => {
    const world = await orgPeopleWorld(testDb().db, 'org20disabled');
    const parent = await world.org('曾停用上级', world.tenant.id, { establishedOn: '2026-08-01' });
    const disabled = await world.patchOrg(parent, { enabled: false, effectiveDate: '2026-08-10' });
    expect(disabled.status, await disabled.clone().text()).toBe(200);
    const enabled = await world.patchOrg(
      { id: parent.id, revision: 2 },
      { enabled: true, effectiveDate: '2026-09-01' },
    );
    expect(enabled.status, await enabled.clone().text()).toBe(200);
    const child = await world.org('重新启用后下级', parent.id, { establishedOn: '2026-09-01' });
    const response = await correct(world, child, '2026-08-20');
    expect(response.status, await response.clone().text()).toBe(400);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'PARENT_UNAVAILABLE' } } });
  });
});
