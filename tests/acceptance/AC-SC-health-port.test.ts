/** D4 / SP-15：B5 真实求值与缓存；T04 来源使用协议规定的 SP-18 实现。 */
import { randomUUID } from 'node:crypto';
import { sql, type DbHandle } from '@italent/db';
import { createTestDb } from '@italent/testkit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SUCCESSION_PORTS, installSuccessionPorts } from '../../apps/api/src/modules/succession/ports.js';
import { orgHealthComputePort } from '../../apps/api/src/modules/talent-review/health-port.js';
import { successionWorld, SC_TODAY, type SuccessionWorld } from './AC-SC-support.js';
import { levelBody } from './AC-SC-levels-support.js';
import { runProjectHealthCommand } from '../../apps/api/src/modules/succession/health-project.js';
import { createInMemoryTalentReviewSyncPort } from '../../apps/api/src/modules/talent-review/sync-port-memory.js';
import { AppError } from '../../apps/api/src/errors.js';
import { rowsOf } from './support/f048.js';
import { enableHealthRunner } from './AC-SC-07-health-support.js';

let handle: DbHandle, w: SuccessionWorld, orgId: string;
let level: { id: string; code: string; name: string; color: string; displayOrder: number };
const greenRules = {
  expression: '1',
  rows: [
    {
      rowNo: 1,
      population: 'all',
      fieldSource: 'org',
      fieldCode: null,
      measure: 'green_rate',
      comparator: 'ge',
      threshold: 0.5,
    },
  ],
};
function reviewSource(projectId: string, meetingId: string | null) {
  return createInMemoryTalentReviewSyncPort({
    tenantId: w.tenant.id,
    sources: [
      {
        projectId,
        meetingId,
        code: 'D4_SOURCE',
        status: 'in_progress',
        periodStartDate: '2026-01-01',
        periodEndDate: '2026-12-31',
        businessDate: SC_TODAY,
        objects: [
          {
            employeeId: randomUUID(),
            orgId,
            fields: {},
            succession: [],
            placement: { matrixId: randomUUID(), placement: 1, countsGreen: true },
          },
        ],
      },
    ],
  });
}
async function setRules(rules: object) {
  const current = await (await w.request('GET', `/health-levels/${level.id}`)).json();
  const changed = await w.request('PUT', `/health-levels/${level.id}`, {
    ifMatch: current.revision,
    body: { rules },
  });
  expect(changed.status, await changed.clone().text()).toBe(200);
}
const compute = (projectId = randomUUID(), meetingId: string | null = null) =>
  w.asTenant((tx) =>
    SUCCESSION_PORTS.orgHealthCompute!.compute(tx, {
      tenantId: w.tenant.id,
      principalUserId: w.user.id,
      context: { projectId, meetingId },
      orgIds: [orgId],
      businessDate: SC_TODAY,
    }),
  );
beforeAll(async () => {
  handle = await createTestDb();
  w = await successionWorld(handle.db, 'sc-health-port');
  orgId = (await w.org('端口计算组织')).id;
  await w.hire('端口统计员工', { departmentId: orgId });
  await enableHealthRunner(w);
  const response = await w.request('POST', '/health-levels', {
    ifMatch: 0,
    body: { ...levelBody('health'), rules: greenRules },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  level = await response.json();
}, 180_000);
afterAll(async () => {
  await handle?.close();
});

describe('AC-SC-health-sync 计算端口装配', () => {
  it.each([true, false])('在岗人数缓存命中=%s：真实 B5 宿主有合法 run，计算结束没有待执行地图任务', async (hit) => {
    const originalOrgId = orgId;
    orgId = (await w.org('缓存独立组织')).id;
    await w.hire('缓存合成员工', { departmentId: orgId });
    await setRules({
      expression: '1',
      rows: [{ ...greenRules.rows[0], fieldCode: 'on_duty_count', measure: 'average', threshold: 1 }],
    });
    try {
      if (hit) await compute();
      const runs = () =>
        w.asTenant(async (tx) =>
          rowsOf<{ id: string; status: string; date: string }>(
            await tx.execute(sql`SELECT id,status,business_date::text AS date FROM succession_calc_runs
          WHERE tenant_id=${w.tenant.id}::uuid AND kind='org_health'`),
          ),
        );
      const oldIds = new Set((await runs()).map((r) => r.id));
      expect(await compute()).toEqual([{ orgId, levelId: level.id, levelCode: level.code, failures: [] }]);
      expect((await runs()).filter((r) => !oldIds.has(r.id))).toEqual([
        { id: expect.any(String), status: 'succeeded', date: SC_TODAY },
      ]);
      expect(
        await w.asTenant(async (tx) =>
          rowsOf(
            await tx.execute(sql`
        SELECT s.on_duty_count,r.status FROM succession_org_stats s JOIN succession_calc_runs r
        ON r.tenant_id=s.tenant_id AND r.id=s.run_id WHERE s.org_id=${orgId}::uuid`),
          ),
        ),
      ).toEqual([{ on_duty_count: 1, status: 'succeeded' }]);
    } finally {
      orgId = originalOrgId;
      await setRules(greenRules);
    }
  });
  it('SP-16 命令台账重放不重读版本，撤权后先 guard 再出结果', async () => {
    const port = createInMemoryTalentReviewSyncPort({ tenantId: w.tenant.id });
    const context = { projectId: randomUUID(), meetingId: null };
    const read = vi
      .spyOn(port, 'readOrgHealthRows')
      .mockResolvedValue([{ status: 'absent', context, orgId, revision: 0 }]);
    const write = vi.spyOn(port, 'recordOrgHealth').mockResolvedValue({
      items: [{ orgId, outcome: 'written', currentRevision: 1, currentLevelId: level.id, currentManual: true }],
    });
    let allowed = true;
    const guard = {
      before: vi.fn(async () => {
        if (!allowed) throw new AppError('FORBIDDEN', '已撤权');
      }),
    };
    const input = {
      tenantId: w.tenant.id,
      context,
      credential: { kind: 'assign' as const, userId: w.user.id, commandId: randomUUID() },
      rows: [{ orgId, status: 'value' as const, levelId: level.id, levelCode: level.code }],
    };
    const run = () =>
      runProjectHealthCommand(
        w.db,
        { tenantId: w.tenant.id, userId: w.user.id, timezone: 'Asia/Shanghai' },
        port,
        input,
        guard,
        null,
      );
    const first = await run();
    expect(await run()).toEqual(first);
    expect(read).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(guard.before).toHaveBeenCalledTimes(2);
    allowed = false;
    await expect(run()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(write).toHaveBeenCalledTimes(1);
  });
  it('宿主失败只返回失败码和行定位，不带中文文案或内部异常', async () => {
    const projectId = randomUUID();
    const reads = reviewSource(projectId, null);
    reads.denyViewer(w.user.id, { orgIds: [orgId] });
    Reflect.set(SUCCESSION_PORTS, 'reviewReads', reads);
    try {
      expect(
        await w.asTenant((tx) =>
          SUCCESSION_PORTS.orgHealthCompute!.compute(tx, {
            tenantId: w.tenant.id,
            principalUserId: w.user.id,
            context: { projectId, meetingId: null },
            orgIds: [orgId],
            businessDate: SC_TODAY,
          }),
        ),
      ).toEqual([
        {
          orgId,
          levelId: null,
          levelCode: null,
          failures: [{ code: 'FIELD_FORBIDDEN', params: { levelId: level.id, rowNo: 1 } }],
        },
      ]);
    } finally {
      Reflect.deleteProperty(SUCCESSION_PORTS, 'reviewReads');
    }
  });
  it('SUCCESSION_PORTS 登记可重复装配的 compute + listLevels 模块单例', () => {
    expect(SUCCESSION_PORTS.orgHealthCompute).toBeDefined();
    expect(SUCCESSION_PORTS.orgHealthCompute?.compute).toBeTypeOf('function');
    expect(SUCCESSION_PORTS.orgHealthCompute?.listLevels).toBeTypeOf('function');
    installSuccessionPorts();
    installSuccessionPorts();
    expect(orgHealthComputePort()).toBe(SUCCESSION_PORTS.orgHealthCompute);
  });

  it('listLevels 按 SP-15 返回等级 ID / code / name / color / sortNo / enabled', async () => {
    const port = SUCCESSION_PORTS.orgHealthCompute;
    expect(port).toBeDefined();
    if (!port) throw new Error('D4 尚未登记计算端口');
    expect(await w.asTenant((tx) => port.listLevels(tx, { tenantId: w.tenant.id }))).toEqual([
      {
        id: level.id,
        code: level.code,
        name: level.name,
        color: level.color,
        sortNo: level.displayOrder,
        enabled: true,
      },
    ]);
  });

  it.each([null, '00000000-0000-4000-8000-000000000061'])(
    'compute 保留项目 / 会议 %s 上下文并返回码而非文案',
    async (meetingId) => {
      const port = SUCCESSION_PORTS.orgHealthCompute;
      expect(port).toBeDefined();
      if (!port) throw new Error('D4 尚未登记计算端口');
      const projectId = randomUUID();
      const reads = reviewSource(projectId, meetingId);
      const green = vi.spyOn(reads, 'greenRate');
      const prior = Reflect.get(SUCCESSION_PORTS, 'reviewReads');
      Reflect.set(SUCCESSION_PORTS, 'reviewReads', reads);
      try {
        expect(
          await w.asTenant((tx) =>
            port.compute(tx, {
              tenantId: w.tenant.id,
              principalUserId: w.user.id,
              context: { projectId, meetingId },
              orgIds: [orgId],
              businessDate: SC_TODAY,
            }),
          ),
        ).toEqual([{ orgId, levelId: level.id, levelCode: level.code, failures: [] }]);
        expect(green).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            tenantId: w.tenant.id,
            orgIds: [orgId],
            viewer: { kind: 'principal', userId: w.user.id },
            context: {
              triggerProjectId: projectId,
              ...(meetingId ? { triggerMeetingId: meetingId } : {}),
              asOf: SC_TODAY,
            },
          }),
        );
      } finally {
        if (prior === undefined) Reflect.deleteProperty(SUCCESSION_PORTS, 'reviewReads');
        else Reflect.set(SUCCESSION_PORTS, 'reviewReads', prior);
      }
    },
  );
});
