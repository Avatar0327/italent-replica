/**
 * AC-SC-01（R3-T05 A1，设计 §6.3）：给 R3-T06 人才池的两个读端口——listActiveSuccessors(ctx, filter)、
 * listIncumbents(ctx, positionIds)。可信端口（同准备度字典端口）：在调用方的租户事务内执行，不做查看人权限判断与字段裁剪，
 * 只做业务口径——asOf 当日生效、未删除、现任 = 主职且非离职 / 调出 / 退休 / 待入职。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { listActiveSuccessors, listIncumbents } from '../../apps/api/src/modules/succession/ports.js';
import { SC_TODAY, successionWorld } from './AC-SC-support.js';

const testDb = useTestDb();

describe('AC-SC-01 继任读端口（给 T06）', () => {
  it('listActiveSuccessors：asOf 当日生效、未删除，可按目标 / 继任者 / 类型过滤；租户隔离', async () => {
    const w = await successionWorld(testDb().db, 'sc-port-a');
    const std = await w.standard();
    const level = await w.readiness('储备');
    const orgActive = await w.insertRecord({
      type: 'org',
      targetId: std.orgA.id,
      successorId: std.successor1.id,
      readinessId: level.id,
      backupType: 'deputy',
      startDate: '2026-08-01',
    });
    const posActive = await w.insertRecord({
      type: 'position',
      targetId: std.keyPosition.id,
      successorId: std.successor2.id,
      startDate: '2026-09-20',
    });
    await w.insertRecord({
      type: 'org',
      targetId: std.orgA.id,
      successorId: std.successor2.id,
      startDate: '2026-01-01',
      endDate: '2026-09-01',
    });
    await w.insertRecord({ type: 'org', targetId: std.orgB.id, successorId: std.successor1.id, deleted: true });
    const other = await successionWorld(testDb().db, 'sc-port-b');
    const otherStd = await other.standard();
    await other.insertRecord({ type: 'org', targetId: otherStd.orgA.id, successorId: otherStd.successor1.id });

    const call = (filter: Parameters<typeof listActiveSuccessors>[1], asOf = SC_TODAY) =>
      w.asTenant((tx) => listActiveSuccessors({ tx, tenantId: w.tenant.id, asOf }, filter));

    const all = await call({});
    expect(all.map((row) => row.recordId).sort()).toEqual([orgActive, posActive].sort());
    const org = all.find((row) => row.recordId === orgActive)!;
    expect(org).toEqual({
      recordId: orgActive,
      successionType: 'org',
      targetOrgId: std.orgA.id,
      targetPositionId: null,
      successorEmployeeId: std.successor1.id,
      readinessId: level.id,
      backupType: 'deputy',
      startDate: '2026-08-01',
    });
    expect((await call({ successionType: 'position' })).map((row) => row.recordId)).toEqual([posActive]);
    expect((await call({ targetOrgIds: [std.orgA.id] })).map((row) => row.recordId)).toEqual([orgActive]);
    expect((await call({ targetPositionIds: [std.keyPosition.id] })).map((row) => row.recordId)).toEqual([posActive]);
    expect((await call({ successorEmployeeIds: [std.successor2.id] })).map((row) => row.recordId)).toEqual([posActive]);
    expect(await call({ targetOrgIds: [] })).toEqual([]);
    // asOf 9-01：被结束的那条仍生效（区间半开，9-01 起已结束）
    const earlier = await call({ successionType: 'org' }, '2026-08-31');
    expect(earlier).toHaveLength(2);
    expect(await call({ successorEmployeeIds: [std.successor1.id] }, '2026-07-01')).toEqual([]);
  });

  it('listIncumbents：按职位分组的现任（主职、在职口径），空输入返回空；不含其他职位与其他租户', async () => {
    const w = await successionWorld(testDb().db, 'sc-port-c');
    const std = await w.standard();
    const second = await w.hire('第二现任', { departmentId: std.orgA.id, positionId: std.keyPosition.id });
    const emptyPosition = await w.position(std.orgA.id, '空缺岗位');
    const call = (positionIds: readonly string[]) =>
      w.asTenant((tx) => listIncumbents({ tx, tenantId: w.tenant.id, asOf: SC_TODAY }, positionIds));
    const result = await call([std.keyPosition.id, emptyPosition.id]);
    expect(
      result
        .get(std.keyPosition.id)
        ?.map((person) => person.employeeId)
        .sort(),
    ).toEqual([std.incumbent.id, second.id].sort());
    expect(result.get(std.keyPosition.id)?.[0]).toMatchObject({ name: expect.any(String) });
    expect(result.get(emptyPosition.id) ?? []).toEqual([]);
    expect((await call([])).size).toBe(0);
    // 入职前一天没有现任
    const before = await w.asTenant((tx) =>
      listIncumbents({ tx, tenantId: w.tenant.id, asOf: '2026-09-30' }, [std.keyPosition.id]),
    );
    expect(before.get(std.keyPosition.id) ?? []).toEqual([]);
  });
});
