/**
 * AC-SC-self（R3-T05 A1 第 2 轮 P2-2，设计 §8.2、§8.4）：操作日志（审计 operation-logs）没有 before / after 快照，
 * SELF 谓词必须按日志的对象 ID（单对象日志）或 items 行的对象 ID（逐行日志）反查继任记录的目标；
 * 开关 succession.self_successors_visible = false 时本人为目标的记录对本人不可见，计数与内容只含他人；
 * 目标无法确定时 fail-closed（不放行）。四种形态：职位现任 / 组织负责人 × 本人＋他人两条 items / 仅本人对象。
 * 夹具走现有 runCommand + insertAuditEvent + insertOperationLog，不假设 A2 的写接口。
 */
import { randomUUID } from 'node:crypto';
import { insertAuditEvent, insertOperationLog } from '@italent/db';
import { SUCCESSION_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../../apps/api/src/commands.js';
import { auditApi } from './AC-AUD-support.js';
import { permissionWorldOf, recordOperator } from './AC-SC-permission-support.js';
import { successionWorld } from './AC-SC-support.js';

const testDb = useTestDb();
const RECORD = SUCCESSION_OBJECTS.record.code;

async function setVisible(w: Awaited<ReturnType<typeof successionWorld>>, value: boolean) {
  const current = await w.call('GET', 'settings/succession.self_successors_visible');
  const revision = ((await current.json()) as { revision: number }).revision;
  const response = await w.call('PUT', 'settings/succession.self_successors_visible', {
    ifMatch: revision,
    body: { value },
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

describe('AC-SC-self 操作日志的 SELF 谓词（P2-2）', () => {
  it.each(['position', 'org'] as const)(
    '%s 继任：items 逐行日志与单对象日志都不含本人为目标的记录，计数只含他人',
    async (kind) => {
      const w = await successionWorld(testDb().db, `sc-oplog-${kind}`);
      const std = await w.standard();
      const selfTarget = kind === 'position' ? std.keyPosition.id : std.orgA.id;
      const otherTarget = kind === 'position' ? (await w.position(std.orgA.id, '非本人职位')).id : std.orgB.id;
      const employee = kind === 'position' ? std.incumbent : std.head;
      const selfRecord = await w.insertRecord({ type: kind, targetId: selfTarget, successorId: std.successor1.id });
      const otherRecord = await w.insertRecord({ type: kind, targetId: otherTarget, successorId: std.successor2.id });
      const world = await permissionWorldOf(w);
      const operator = await recordOperator(world, {
        userId: await w.userOf(employee),
        seeAll: true,
        audit: true,
      });
      const admin = await recordOperator(world, { seeAll: true, audit: true });
      await setVisible(w, false);

      const batchCommand = randomUUID();
      const singleCommand = randomUUID();
      const ctx = { tenantId: w.tenant.id, userId: w.user.id, timezone: 'Asia/Shanghai' };
      const orgOf = (target: string) => (kind === 'org' ? target : std.orgA.id);
      await runCommand(w.db, ctx, {
        id: batchCommand,
        fingerprint: { probe: 'oplog-batch', kind },
        execute: async (tx, commandId) => {
          for (const [id, target, successor] of [
            [selfRecord, selfTarget, std.successor1.id],
            [otherRecord, otherTarget, std.successor2.id],
          ] as const)
            await insertAuditEvent(tx, {
              tenantId: w.tenant.id,
              actorUserId: w.user.id,
              action: 'succession.record.update',
              objectType: RECORD,
              objectId: id,
              before: null,
              // 快照里不带目标：目标只能由对象 ID 反查
              after: { endReason: '合成说明', successorEmployeeId: successor },
              commandId,
              scope: { orgId: orgOf(target) },
            });
          await insertOperationLog(tx, {
            tenantId: w.tenant.id,
            actorUserId: w.user.id,
            behavior: 'batch_update',
            objectType: RECORD,
            successCount: 2,
            failureCount: 0,
            commandId,
            items: [
              { rowIndex: 0, outcome: 'succeeded', objectId: selfRecord, orgId: orgOf(selfTarget) },
              { rowIndex: 1, outcome: 'succeeded', objectId: otherRecord, orgId: orgOf(otherTarget) },
            ],
          });
          return { status: 200, body: { updated: [selfRecord, otherRecord] } };
        },
      });
      await runCommand(w.db, ctx, {
        id: singleCommand,
        fingerprint: { probe: 'oplog-single', kind },
        execute: async (tx, commandId) => {
          await insertOperationLog(tx, {
            tenantId: w.tenant.id,
            actorUserId: w.user.id,
            behavior: 'download',
            objectType: RECORD,
            objectId: selfRecord,
            successCount: 1,
            failureCount: 0,
            commandId,
          });
          return { status: 200, body: {} };
        },
      });

      const audit = auditApi(w.db, () => new Date(), { authorize: undefined });
      // 带 items 的逐行日志：本人那一行不返回，汇总只计他人（1，不是 2）
      const batch = await audit.operationLogs(operator.as, { objectType: RECORD, commandId: batchCommand });
      expect(batch.items.map((item) => [item.objectId, item.totalCount])).toEqual([[null, 1]]);
      // 仅本人对象的单对象日志：整条不返回
      const single = await audit.operationLogs(operator.as, { objectType: RECORD, commandId: singleCommand });
      expect(single.items).toEqual([]);
      // 数据变更日志同样只剩他人的记录
      const events = await audit.dataChanges(operator.as, { objectType: RECORD, commandId: batchCommand });
      expect(events.items.map((item) => item.objectId)).toEqual([otherRecord]);
      // 非本人的查看人（管理员）两条都看得到
      const all = await audit.operationLogs(admin.as, { objectType: RECORD, commandId: batchCommand });
      expect(all.items.map((item) => item.totalCount)).toEqual([2]);
      expect(
        (await audit.operationLogs(admin.as, { objectType: RECORD, commandId: singleCommand })).items,
      ).toHaveLength(1);
      // 开关恢复后本人也能看到
      await setVisible(w, true);
      const restored = await audit.operationLogs(operator.as, { objectType: RECORD, commandId: batchCommand });
      expect(restored.items.map((item) => item.totalCount)).toEqual([2]);
    },
  );

  it('目标无法确定（对象 ID 不是继任记录、快照无目标）时 fail-closed：不放行', async () => {
    const w = await successionWorld(testDb().db, 'sc-oplog-unknown');
    await w.standard();
    const operator = await recordOperator(await permissionWorldOf(w), { seeAll: true, audit: true });
    const commandId = randomUUID();
    await runCommand(
      w.db,
      { tenantId: w.tenant.id, userId: w.user.id, timezone: 'Asia/Shanghai' },
      {
        id: commandId,
        fingerprint: { probe: 'oplog-unknown' },
        execute: async (tx, cid) => {
          await insertOperationLog(tx, {
            tenantId: w.tenant.id,
            actorUserId: w.user.id,
            behavior: 'download',
            objectType: RECORD,
            objectId: randomUUID(),
            successCount: 1,
            failureCount: 0,
            commandId: cid,
          });
          return { status: 200, body: {} };
        },
      },
    );
    const audit = auditApi(w.db, () => new Date(), { authorize: undefined });
    expect((await audit.operationLogs(operator.as, { objectType: RECORD, commandId })).items).toEqual([]);
  });
});
