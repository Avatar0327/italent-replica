/** D4 / SP-15：通过装配登记公开端口验收；不在测试中复制 B5 求值实现。 */
import { randomUUID } from 'node:crypto';
import { sql, type DbHandle } from '@italent/db';
import { STANDARD_PROFILES } from '@italent/domain';
import { createTestDb } from '@italent/testkit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SUCCESSION_PORTS, installSuccessionPorts } from '../../apps/api/src/modules/succession/ports.js';
import { orgHealthComputePort } from '../../apps/api/src/modules/talent-review/health-port.js';
import type { TalentReviewSyncPort } from '../../apps/api/src/modules/talent-review/sync-port.js';
import { installProfile } from '../../apps/api/src/modules/permission/standard-profiles.js';
import { overrideSetting } from '../../apps/api/src/modules/tenant-settings/service.js';
import { successionWorld, SC_NOW, SC_TODAY, type SuccessionWorld } from './AC-SC-support.js';
import { levelBody } from './AC-SC-levels-support.js';

// #282 health-metrics.ts 的 HealthReads 接口形状；只替代来源读取，不复制 B5 的计算实现。
type HealthReads = Pick<
  TalentReviewSyncPort,
  'greenRate' | 'readReviewFields' | 'readSuccessionEntries' | 'listReviewFields'
>;
function healthReadsDouble() {
  return {
    greenRate: vi
      .fn<HealthReads['greenRate']>()
      .mockImplementation(
        async (_tx, input) =>
          new Map(
            input.orgIds.map((orgId) => [
              orgId,
              { status: 'value' as const, rate: 0.75, green: 3, placed: 4, source: null },
            ]),
          ),
      ),
    readReviewFields: vi.fn<HealthReads['readReviewFields']>().mockResolvedValue(new Map()),
    readSuccessionEntries: vi.fn<HealthReads['readSuccessionEntries']>().mockResolvedValue([]),
    listReviewFields: vi.fn<HealthReads['listReviewFields']>().mockResolvedValue([]),
  } satisfies HealthReads;
}
let handle: DbHandle, w: SuccessionWorld, orgId: string;
let level: { id: string; code: string; name: string; color: string; displayOrder: number };
beforeAll(async () => {
  handle = await createTestDb();
  w = await successionWorld(handle.db, 'sc-health-port');
  orgId = (await w.org('端口计算组织')).id;
  await w.asTenant(async (tx) => {
    await installProfile(
      tx,
      { tenantId: w.tenant.id, actorUserId: null, now: SC_NOW, commandId: randomUUID() },
      STANDARD_PROFILES.find((p) => p.code === 'standard_succession_runner')!,
    );
    await tx.execute(sql`INSERT INTO permission_grants(tenant_id,user_id,profile_id)
      SELECT ${w.tenant.id}::uuid,${w.user.id}::uuid,id FROM permission_profiles
      WHERE tenant_id=${w.tenant.id}::uuid AND code='standard_succession_runner' ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO permission_identity_scopes
      (tenant_id,profile_id,app_code,target_kind,target_code,see_all)
      SELECT ${w.tenant.id}::uuid,id,'SuccessionAndDevelopment','entity','Succession.HealthResult',true
      FROM permission_profiles WHERE tenant_id=${w.tenant.id}::uuid AND code='standard_succession_runner'
      ON CONFLICT (tenant_id,profile_id,app_code,target_kind,target_code) DO UPDATE SET see_all=true`);
    await overrideSetting(
      tx,
      {
        tenantId: w.tenant.id,
        userId: w.user.id,
        key: 'succession.system_principal_user_id',
        expectedRevision: 0,
        now: SC_NOW,
        commandId: randomUUID(),
      },
      w.user.id,
    );
  });
  const response = await w.request('POST', '/health-levels', {
    ifMatch: 0,
    body: {
      ...levelBody('health'),
      rules: {
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
      },
    },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  level = (await response.json()) as typeof level;
}, 180_000);
afterAll(async () => {
  await handle?.close();
});

describe('AC-SC-health-sync 计算端口装配', () => {
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
      const reads = healthReadsDouble(),
        projectId = randomUUID();
      // reviewReads 为 #282 已有登记位；依赖未合并时不修改当前 ports.ts 的契约。
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
        expect(reads.greenRate).toHaveBeenCalledWith(
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
