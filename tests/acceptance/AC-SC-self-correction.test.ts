/**
 * AC-SC-self（R3-T05 A1 第 2 轮 P2-1，设计 §4.1、§8.4）：现任按“有效任职快照”取值——合法的任职更正
 * （PATCH /employment/records/:id）把职位改成 P2 后，现任 / SELF 判断都跟着变；合法清空 positionId = null 后
 * 原职位也没有现任（区分“没有快照”与“快照显式为 null”，不能回退到原始记录的旧值）。
 * 覆盖同根出口：详情 / 列表 / 计数、`incumbents` 派生字段、T06 `listIncumbents`、数据变更日志的列表与详情。
 */
import { randomUUID } from 'node:crypto';
import { insertAuditEvent } from '@italent/db';
import { SUCCESSION_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { permissionWorldOf, recordOperator } from './AC-SC-permission-support.js';
import { SC_TODAY, type RecordList, type RecordView, type SuccessionWorld, successionWorld } from './AC-SC-support.js';
import { listIncumbents } from '../../apps/api/src/modules/succession/ports.js';

const testDb = useTestDb();
const RECORD = SUCCESSION_OBJECTS.record.code;

describe('AC-SC-self 任职更正后的现任与 SELF（P2-1）', () => {
  let w: SuccessionWorld;
  let std: Awaited<ReturnType<SuccessionWorld['standard']>>;
  let newPosition: { id: string };
  const ids = {} as Record<'oldRecord' | 'newRecord', string>;
  let self: Awaited<ReturnType<typeof recordOperator>>;

  const correct = async (positionId: string | null) => {
    const business = await w.call('GET', `employment/businesses/${std.incumbent.recordId}`);
    expect(business.status).toBe(200);
    const revision = ((await business.json()) as { revision: number }).revision;
    const response = await w.call('PATCH', `employment/records/${std.incumbent.recordId}`, {
      ifMatch: revision,
      body: { fields: { positionId } },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const effective = (await (await w.call('GET', `employment/records/${std.incumbent.recordId}`)).json()) as {
      fields: { positionId: string | null };
    };
    expect(effective.fields.positionId).toBe(positionId);
  };
  const setVisible = async (value: boolean | null) => {
    const current = await w.call('GET', 'settings/succession.self_successors_visible');
    const revision = ((await current.json()) as { revision: number }).revision;
    const response =
      value === null
        ? await w.call('DELETE', 'settings/succession.self_successors_visible/override', { ifMatch: revision })
        : await w.call('PUT', 'settings/succession.self_successors_visible', { ifMatch: revision, body: { value } });
    expect(response.status, await response.clone().text()).toBe(200);
  };
  const detail = async (id: string) => (await (await w.request('GET', `/records/${id}`)).json()) as RecordView;
  const incumbentsOf = async (positionId: string) =>
    (await w.asTenant((tx) => listIncumbents({ tx, tenantId: w.tenant.id, asOf: SC_TODAY }, [positionId]))).get(
      positionId,
    ) ?? [];

  beforeAll(async () => {
    w = await successionWorld(testDb().db, 'sc-correction');
    std = await w.standard();
    newPosition = await w.position(std.orgA.id, '更正后的新职位');
    ids.oldRecord = await w.insertRecord({
      type: 'position',
      targetId: std.keyPosition.id,
      successorId: std.successor1.id,
    });
    ids.newRecord = await w.insertRecord({
      type: 'position',
      targetId: newPosition.id,
      successorId: std.successor2.id,
    });
    self = await recordOperator(await permissionWorldOf(w), {
      userId: await w.userOf(std.incumbent),
      seeAll: true,
      audit: true,
    });
    await w.asTenant(async (tx) => {
      for (const [id, position, successor] of [
        [ids.oldRecord, std.keyPosition.id, std.successor1.id],
        [ids.newRecord, newPosition.id, std.successor2.id],
      ] as const)
        await insertAuditEvent(tx, {
          tenantId: w.tenant.id,
          actorUserId: w.user.id,
          action: 'succession.record.create',
          objectType: RECORD,
          objectId: id,
          before: null,
          after: {
            successionType: 'position',
            targetOrgId: null,
            targetPositionId: position,
            successorEmployeeId: successor,
          },
          commandId: randomUUID(),
          scope: { orgId: std.orgA.id },
        });
    });
  });

  it('更正前：现任在原职位；开关 false 时本人原职位的记录 404、新职位的记录可见', async () => {
    expect((await detail(ids.oldRecord)).incumbents?.map((p) => p.employeeId)).toEqual([std.incumbent.id]);
    await setVisible(false);
    try {
      expect((await self.request('GET', `/records/${ids.oldRecord}`)).status).toBe(404);
      expect((await self.request('GET', `/records/${ids.newRecord}`)).status).toBe(200);
    } finally {
      await setVisible(null);
    }
  });

  it('更正职位 P1 → P2：详情 / 列表 / 计数、incumbents、T06 端口、数据变更日志都按 P2 判断', async () => {
    await correct(newPosition.id);
    expect((await detail(ids.oldRecord)).incumbents).toEqual([]);
    expect((await detail(ids.newRecord)).incumbents?.map((p) => p.employeeId)).toEqual([std.incumbent.id]);
    expect((await incumbentsOf(std.keyPosition.id)).map((p) => p.employeeId)).toEqual([]);
    expect((await incumbentsOf(newPosition.id)).map((p) => p.employeeId)).toEqual([std.incumbent.id]);

    await setVisible(false);
    try {
      const hidden = await self.request('GET', `/records/${ids.newRecord}`);
      expect(hidden.status, '本人当前职位的继任记录必须隐藏').toBe(404);
      expect((await self.request('GET', `/records/${ids.oldRecord}`)).status).toBe(200);
      const list = (await (await self.request('GET', '/records')).json()) as RecordList;
      expect(list.items.map((item) => item.id)).toEqual([ids.oldRecord]);
      expect(list.total).toBe(1);
      const audit = auditApi(w.db, () => new Date(), { authorize: undefined });
      const changes = await audit.dataChanges(self.as, { objectType: RECORD, limit: '50' });
      expect(changes.items.map((item) => item.objectId)).toEqual([ids.oldRecord]);
      const visibleId = changes.items[0]!.id;
      expect((await audit.dataChange(self.as, visibleId)).objectId).toBe(ids.oldRecord);
    } finally {
      await setVisible(null);
    }
  });

  it('合法清空 positionId = null：原职位与新职位都没有现任，本人没有任何职位继任被隐藏', async () => {
    await correct(null);
    for (const id of [ids.oldRecord, ids.newRecord]) expect((await detail(id)).incumbents, id).toEqual([]);
    expect(await incumbentsOf(std.keyPosition.id)).toEqual([]);
    expect(await incumbentsOf(newPosition.id)).toEqual([]);
    await setVisible(false);
    try {
      for (const id of [ids.oldRecord, ids.newRecord])
        expect((await self.request('GET', `/records/${id}`)).status, id).toBe(200);
      const list = (await (await self.request('GET', '/records')).json()) as RecordList;
      expect(list.total).toBe(2);
    } finally {
      await setVisible(null);
    }
  });
});
