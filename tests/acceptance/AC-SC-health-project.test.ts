/** SP-16：版本来自目标项目行；来源替身负责真实的 CAS / 手工值保护协议。 */
import { describe, expect, it, vi } from 'vitest';
import { createInMemoryTalentReviewSyncPort } from '../../apps/api/src/modules/talent-review/sync-port-memory.js';
import { writeProjectHealth } from '../../apps/api/src/modules/succession/health-project.js';
import { syncFixture, FX } from './support/sync-port-contract.js';

describe('AC-SC-health-sync SP-16 项目回写', () => {
  it('读不到版本不推测为 0；forbidden 与缺行响应均不进入写入', async () => {
    const port = createInMemoryTalentReviewSyncPort(syncFixture());
    const input = {
      tenantId: FX.tenant,
      context: { projectId: FX.project, meetingId: null },
      credential: { kind: 'assign' as const, userId: FX.actor, commandId: 'denied' },
      rows: [{ orgId: FX.g1, status: 'empty' as const, levelId: null, levelCode: null }],
    };
    const write = vi.spyOn(port, 'recordOrgHealth');
    vi.spyOn(port, 'readOrgHealthRows')
      .mockResolvedValueOnce([{ status: 'forbidden', orgId: FX.g1, context: input.context }])
      .mockResolvedValueOnce([]);
    await expect(port.transaction((tx) => writeProjectHealth(tx, port, input))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(port.transaction((tx) => writeProjectHealth(tx, port, input))).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(write).not.toHaveBeenCalled();
  });
  it.each([null, FX.meeting])('取目标会议 %s 的当前版本，不能用本地结果版本', async (meetingId) => {
    const fixture = syncFixture();
    const context = { projectId: FX.project, meetingId };
    const port = createInMemoryTalentReviewSyncPort({
      ...fixture,
      healthRows: [
        {
          ...fixture.healthRows![0]!,
          context,
          revision: 23,
        },
      ],
    });
    const read = vi.spyOn(port, 'readOrgHealthRows'),
      write = vi.spyOn(port, 'recordOrgHealth');
    const result = await port.transaction((tx) =>
      writeProjectHealth(tx, port, {
        tenantId: FX.tenant,
        context,
        credential: { kind: 'assign', userId: FX.actor, commandId: `assign-${meetingId ?? 'project'}` },
        rows: [
          { orgId: FX.g1, status: 'value', levelId: FX.readyLater, levelCode: 'RN3' },
          { orgId: FX.g2, status: 'empty', levelId: null, levelCode: null },
        ],
      }),
    );
    expect(read).toHaveBeenCalledWith(expect.anything(), {
      tenantId: FX.tenant,
      context,
      orgIds: [FX.g1, FX.g2],
      viewer: { kind: 'user', userId: FX.actor },
    });
    expect(write.mock.calls[0]![1]).toMatchObject({
      context,
      rows: [
        { orgId: FX.g1, expectedRevision: 23 },
        { orgId: FX.g2, expectedRevision: 0 },
      ],
    });
    expect(result.items.map((i) => i.outcome)).toEqual(['written', 'written']);
    expect(read.mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0]!);
  });

  it('读版本后他人赋值，回写只返回 REVISION_CONFLICT，保持新手工值', async () => {
    const port = createInMemoryTalentReviewSyncPort(syncFixture());
    const context = { projectId: FX.project, meetingId: null };
    const read = port.readOrgHealthRows.bind(port);
    const readSpy = vi.spyOn(port, 'readOrgHealthRows');
    const result = await port.transaction((tx) =>
      writeProjectHealth(tx, port, {
        tenantId: FX.tenant,
        context,
        credential: { kind: 'reset', userId: FX.actor, commandId: 'reset-race' },
        rows: [{ orgId: FX.g1, status: 'empty', levelId: null, levelCode: null }],
        calculate: async (tx) => {
          expect(readSpy).toHaveBeenCalledTimes(1);
          await port.recordOrgHealth(tx, {
            tenantId: FX.tenant,
            context,
            credential: { kind: 'assign', userId: FX.actor, commandId: 'other' },
            rows: [{ orgId: FX.g1, expectedRevision: 3, status: 'value', levelId: FX.readyLater, levelCode: 'RN3' }],
          });
          return [{ orgId: FX.g1, status: 'empty', levelId: null, levelCode: null }];
        },
      }),
    );
    expect(result.items).toEqual([
      {
        orgId: FX.g1,
        outcome: 'REVISION_CONFLICT',
        currentRevision: 4,
        currentLevelId: FX.readyLater,
        currentManual: true,
      },
    ]);
    expect(
      await port.transaction((tx) =>
        read(tx, { tenantId: FX.tenant, context, orgIds: [FX.g1], viewer: { kind: 'user', userId: FX.actor } }),
      ),
    ).toEqual([
      expect.objectContaining({
        revision: 4,
        manual: true,
        levelId: FX.readyLater,
      }),
    ]);
  });

  it('compute 用 principal 读，保留手工值；reset 同次写清 manual', async () => {
    const port = createInMemoryTalentReviewSyncPort(syncFixture());
    const context = { projectId: FX.project, meetingId: null };
    const read = vi.spyOn(port, 'readOrgHealthRows');
    const rows = [{ orgId: FX.g1, status: 'empty' as const, levelId: null, levelCode: null }];
    const computed = await port.transaction((tx) =>
      writeProjectHealth(tx, port, {
        tenantId: FX.tenant,
        context,
        rows,
        credential: { kind: 'compute', principalUserId: FX.principal, calcRunId: FX.run, commandId: 'compute' },
      }),
    );
    expect(computed.items[0]).toMatchObject({ outcome: 'MANUAL_KEPT', currentRevision: 3, currentManual: true });
    expect(read.mock.calls[0]![1].viewer).toEqual({ kind: 'principal', userId: FX.principal });
    const reset = await port.transaction((tx) =>
      writeProjectHealth(tx, port, {
        tenantId: FX.tenant,
        context,
        rows,
        credential: { kind: 'reset', userId: FX.actor, commandId: 'reset' },
        calculate: async () => rows,
      }),
    );
    expect(reset.items[0]).toMatchObject({ outcome: 'written', currentRevision: 4, currentManual: false });
  });
});
