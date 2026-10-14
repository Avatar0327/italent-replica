/**
 * AC-SC-self（R3-T05 A1 第 3 轮 P3，设计 §8.4）：残缺审计快照 fail-closed——审计行快照里的 successionType 不合法，
 * 或缺少与类型对应的目标 UUID（职位继任缺 targetPositionId、组织继任缺 targetOrgId），而又无法按对象 ID 反查到继任记录时，
 * 目标确定不了，数据变更日志的列表与详情都不返回（不能因为“没有目标”就当成“不是本人的”放行）。
 * 对照：快照完整的日志照常可见。
 */
import { randomUUID } from 'node:crypto';
import { insertAuditEvent, sql } from '@italent/db';
import { SUCCESSION_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { permissionWorldOf, recordOperator } from './AC-SC-permission-support.js';
import { successionWorld } from './AC-SC-support.js';

const testDb = useTestDb();
const RECORD = SUCCESSION_OBJECTS.record.code;

describe('AC-SC-self 残缺审计快照 fail-closed', () => {
  it('类型不合法 / 缺对应目标 UUID 且反查不到记录：列表不含、详情 404；完整快照照常可见', async () => {
    const w = await successionWorld(testDb().db, 'sc-partial');
    const std = await w.standard();
    const world = await permissionWorldOf(w);
    const viewer = await recordOperator(world, { seeAll: true, audit: true });
    const cases = {
      positionWithoutTarget: { successionType: 'position', targetOrgId: std.orgA.id },
      orgWithoutTarget: { successionType: 'org', targetPositionId: std.keyPosition.id },
      positionWithBadTarget: { successionType: 'position', targetPositionId: 'not-a-uuid' },
      bogusType: { successionType: 'team', targetOrgId: std.orgA.id },
      complete: { successionType: 'org', targetOrgId: std.orgA.id },
    } as const;
    const objectIds = Object.fromEntries(Object.keys(cases).map((key) => [key, randomUUID()])) as Record<
      keyof typeof cases,
      string
    >;
    await w.asTenant(async (tx) => {
      for (const [key, after] of Object.entries(cases))
        await insertAuditEvent(tx, {
          tenantId: w.tenant.id,
          actorUserId: w.user.id,
          action: 'succession.record.create',
          objectType: RECORD,
          objectId: objectIds[key as keyof typeof cases],
          before: null,
          after,
          commandId: randomUUID(),
          scope: { orgId: std.orgA.id },
        });
    });
    const audit = auditApi(w.db, () => new Date(), { authorize: undefined });
    const listed = await audit.dataChanges(viewer.as, { objectType: RECORD, limit: '50' });
    expect(listed.items.map((item) => item.objectId)).toEqual([objectIds.complete]);
    await audit.dataChange(viewer.as, listed.items[0]!.id);
    // 被过滤掉的日志：先按 ID 取到（管理员绕过过滤的探针不存在），这里用 SQL 取 ID 再走详情接口，必须 404
    const hiddenIds = await w.asTenant(async (tx) => {
      const rows = await tx.execute(
        sql`SELECT id FROM audit_events WHERE object_type = ${RECORD} AND object_id <> ${objectIds.complete}`,
      );
      return (Array.isArray(rows) ? rows : (rows as { rows: { id: string }[] }).rows).map(
        (row) => (row as { id: string }).id,
      );
    });
    expect(hiddenIds).toHaveLength(4);
    for (const id of hiddenIds) expect((await audit.get(`/data-changes/${id}`, viewer.as)).status, id).toBe(404);
  });
});
