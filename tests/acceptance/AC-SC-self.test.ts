/**
 * AC-SC-self（R3-T05 A1，设计 §5.5 SC-R7、§8.4 SELF 谓词；Q-SC-17）：持继任身份、且本人是目标负责人 / 现任的查看人，
 * 在 `succession.self_successors_visible = false` 时，“是本人的”记录在所有出口都不返回、不计数——
 * 列表、详情（404）、审计日志；谓词在 SQL 里实现（succession_self_target_sql），列表 / 审计共用。开关为 true（缺省）时照常可见。
 */
import { randomUUID } from 'node:crypto';
import { insertAuditEvent, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { permissionWorldOf, recordOperator } from './AC-SC-permission-support.js';
import { SC_TODAY, type RecordList, type SuccessionWorld, successionWorld } from './AC-SC-support.js';
import { errorCode } from './support/tenant-api.js';
import type { PermissionWorld } from './AC-PRM-support.js';
import { SUCCESSION_OBJECTS } from '@italent/domain';

const testDb = useTestDb();

describe('AC-SC-self SELF 谓词（设计 §8.4）', () => {
  let w: SuccessionWorld;
  let world: PermissionWorld;
  let std: Awaited<ReturnType<SuccessionWorld['standard']>>;
  const ids = {} as Record<'org' | 'position' | 'orgB', string>;

  beforeAll(async () => {
    w = await successionWorld(testDb().db, 'sc-self');
    std = await w.standard();
    world = await permissionWorldOf(w);
    ids.org = await w.insertRecord({ type: 'org', targetId: std.orgA.id, successorId: std.successor1.id });
    ids.position = await w.insertRecord({
      type: 'position',
      targetId: std.keyPosition.id,
      successorId: std.successor2.id,
    });
    ids.orgB = await w.insertRecord({ type: 'org', targetId: std.orgB.id, successorId: std.successor1.id });
  });

  const setVisible = async (value: boolean | null) => {
    const current = await w.call('GET', 'settings/succession.self_successors_visible');
    const revision = ((await current.json()) as { revision: number }).revision;
    const response =
      value === null
        ? await w.call('DELETE', 'settings/succession.self_successors_visible/override', { ifMatch: revision })
        : await w.call('PUT', 'settings/succession.self_successors_visible', { ifMatch: revision, body: { value } });
    expect(response.status, await response.clone().text()).toBe(200);
  };

  const selfSql = async (userId: string, type: string, org: string | null, position: string | null) =>
    w.asTenant(
      async (tx) =>
        resultRows<{ self: boolean }>(
          await tx.execute(sql`SELECT succession_self_target_sql(${w.tenant.id}::uuid, ${userId}::uuid, ${type},
          ${org}::uuid, ${position}::uuid, ${SC_TODAY}::date) AS self`),
        )[0]!.self,
    );

  it('SQL 谓词：组织负责人是本人的组织继任；职位现任是本人的职位继任；其他人、范围外目标、未绑定员工的用户都不是', async () => {
    const head = await w.userOf(std.head);
    const incumbent = await w.userOf(std.incumbent);
    const other = await w.userOf(std.successor1);
    expect(await selfSql(head, 'org', std.orgA.id, null)).toBe(true);
    expect(await selfSql(head, 'org', std.orgB.id, null)).toBe(false);
    expect(await selfSql(head, 'position', null, std.keyPosition.id)).toBe(false);
    expect(await selfSql(incumbent, 'position', null, std.keyPosition.id)).toBe(true);
    expect(await selfSql(incumbent, 'org', std.orgA.id, null)).toBe(false);
    expect(await selfSql(other, 'org', std.orgA.id, null)).toBe(false);
    expect(await selfSql(w.user.id, 'org', std.orgA.id, null)).toBe(false);
  });

  it('开关 true（缺省）：负责人和现任都能看到自己的继任者', async () => {
    const head = await recordOperator(world, { userId: await w.userOf(std.head), seeAll: true });
    const list = (await (await head.request('GET', '/records')).json()) as RecordList;
    expect(list.items.map((item) => item.id).sort()).toEqual([ids.org, ids.position, ids.orgB].sort());
  });

  it('开关 false：负责人看不到 A 部的继任记录（列表不含、total 不计、详情 404），其他记录照常', async () => {
    const head = await recordOperator(world, { userId: await w.userOf(std.head), seeAll: true });
    await setVisible(false);
    try {
      const list = (await (await head.request('GET', '/records?status=all')).json()) as RecordList;
      expect(list.items.map((item) => item.id).sort()).toEqual([ids.position, ids.orgB].sort());
      expect(list.total).toBe(2);
      const hidden = await head.request('GET', `/records/${ids.org}`);
      expect([hidden.status, await errorCode(hidden)]).toEqual([404, 'NOT_FOUND']);
      expect((await head.request('GET', `/records/${ids.position}`)).status).toBe(200);
    } finally {
      await setVisible(null);
    }
  });

  it('开关 false：职位现任看不到自己职位的继任记录；非本人（管理员、不相关的人）不受影响', async () => {
    const incumbent = await recordOperator(world, { userId: await w.userOf(std.incumbent), seeAll: true });
    const bystander = await recordOperator(world, { seeAll: true });
    await setVisible(false);
    try {
      const mine = (await (await incumbent.request('GET', '/records')).json()) as RecordList;
      expect(mine.items.map((item) => item.id).sort()).toEqual([ids.org, ids.orgB].sort());
      expect((await incumbent.request('GET', `/records/${ids.position}`)).status).toBe(404);
      const other = (await (await bystander.request('GET', '/records')).json()) as RecordList;
      expect(other.total).toBe(3);
    } finally {
      await setVisible(null);
    }
  });

  it('审计：开关 false 时，目标是本人的记录日志对本人不可见，其余日志照常；开关 true 时可见', async () => {
    const record = SUCCESSION_OBJECTS.record.code;
    await withTenant(w.db, w.tenant.id, async (tx) => {
      for (const [objectId, orgId, type] of [
        [ids.org, std.orgA.id, 'org'],
        [ids.orgB, std.orgB.id, 'org'],
      ] as const)
        await insertAuditEvent(tx, {
          tenantId: w.tenant.id,
          actorUserId: w.user.id,
          action: 'succession.record.create',
          objectType: record,
          objectId,
          before: null,
          after: { successionType: type, targetOrgId: orgId, targetPositionId: null },
          commandId: randomUUID(),
          scope: { orgId },
        });
    });
    const head = await recordOperator(world, { userId: await w.userOf(std.head), seeAll: true, audit: true });
    const audit = auditApi(world.db, () => new Date(), { authorize: undefined });
    const seen = async () =>
      (await audit.dataChanges(head.as, { objectType: record, limit: '50' })).items.map(
        (item) => (item as unknown as { objectId: string }).objectId,
      );
    expect((await seen()).sort()).toEqual([ids.org, ids.orgB].sort());
    await setVisible(false);
    try {
      expect(await seen()).toEqual([ids.orgB]);
    } finally {
      await setVisible(null);
    }
  });
});
