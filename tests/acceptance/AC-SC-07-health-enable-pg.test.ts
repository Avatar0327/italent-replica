import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { describe, expect, it } from 'vitest';
import { successionWorld, SC_BASE, SC_NOW, type SuccessionWorld } from './AC-SC-support.js';
import { enableHealthRunner, useHealthDb } from './AC-SC-07-health-support.js';
import { tenantApi } from './support/tenant-api.js';
import { commandHash } from '../../apps/api/src/commands.js';
import { createPermissionAuthorizer } from '../../apps/api/src/modules/permission/authorizer.js';
import { objectCatalog } from '../../apps/api/src/modules/permission/catalog.js';
import { runCalcPage } from '../../apps/api/src/modules/succession/calc-worker.js';
import { mutateLevel } from '../../apps/api/src/modules/succession/levels-write.js';
import { rowsOf } from '../../apps/api/src/modules/succession/read-sql.js';

const db = useHealthDb();
const rules = {
  expression: '1',
  rows: [{ rowNo: 1, population: 'incumbents', fieldSource: 'org', measure: 'count', comparator: 'eq', threshold: 1 }],
};
async function level(w: SuccessionWorld, code: string, enabled: boolean) {
  const res = await w.request('POST', '/health-levels', {
    ifMatch: 0,
    body: { code, name: code, color: '#336699', enabled, rules },
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()).id as string;
}
async function legacy(w: SuccessionWorld, fieldSource = 'org', measure = 'count') {
  const id = await level(w, 'LEGACY', false);
  await w.asTenant(async (tx) => {
    await tx.execute(sql`UPDATE succession_health_level_rows SET population='all',
      field_source=${fieldSource},measure=${measure} WHERE level_id=${id}::uuid`);
  });
  return id;
}
function snapshot(w: SuccessionWorld) {
  return w.asTenant(async (tx) => ({
    levels: rowsOf(await tx.execute(sql`SELECT * FROM succession_health_levels ORDER BY id`)),
    rules: rowsOf(await tx.execute(sql`SELECT * FROM succession_health_level_rows ORDER BY id`)),
    settings: rowsOf(await tx.execute(sql`SELECT * FROM succession_rule_settings WHERE kind='org_health'`)),
  }));
}
async function rejected(res: Response) {
  expect(res.status, await res.clone().text()).toBe(400);
  const body = await res.json();
  expect(body.error).toMatchObject({
    code: 'VALIDATION_FAILED',
    details: { reason: 'HEALTH_RULE_COMBINATION_UNSUPPORTED', rowNo: 1 },
  });
  expect(body.error.message).toContain('暂不支持');
}
// 现有部分更新协议使用 PUT + patch schema；DEC-466 不新增 HTTP 路由。
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-SC-07 DEC-466 启用边界真 PG', () => {
  it.each(['org', 'review', 'succession'].flatMap((source) => ['count', 'ratio'].map((measure) => [source, measure])))(
    '%s × %s：只启用旧禁用等级拒绝，正常等级仍计算成功',
    async (source, measure) => {
      const w = await successionWorld(db().db, 'health-enable');
      const org = await w.org('合成启用组织');
      await w.setHead(org, await w.hire('合成负责人', { departmentId: org.id }));
      const good = await level(w, 'GOOD', true);
      const id = await legacy(w, source, measure);
      await enableHealthRunner(w);
      const before = await snapshot(w);
      await rejected(await w.request('PUT', `/health-levels/${id}`, { ifMatch: 1, body: { enabled: true } }));
      // 请求事务已结束；独立事务核对 enabled / revision 以及规则、集合版本均未变化。
      expect(await snapshot(w)).toEqual(before);
      const api = tenantApi(w.db, {
        authorize: createPermissionAuthorizer(w.db, objectCatalog, () => SC_NOW),
        clock: () => SC_NOW,
      });
      const response = await api.request('POST', `${SC_BASE}/maps/org/compute-health`, {
        tenant: w.tenant.id,
        user: w.user.id,
        ifMatch: 0,
        body: {},
      });
      expect(response.status, await response.clone().text()).toBe(202);
      const { runId } = await response.json();
      expect(await runCalcPage(w.db, w.tenant.id, runId, undefined, SC_NOW)).toBe('succeeded');
      const committed = await w.asTenant(async (tx) => ({
        result: rowsOf(
          await tx.execute(sql`SELECT level_id,method,revision FROM succession_health_results
          WHERE org_id=${org.id}::uuid`),
        ),
        outcome: rowsOf(
          await tx.execute(sql`SELECT outcome FROM succession_calc_run_objects
          WHERE run_id=${runId}::uuid AND object_id=${org.id}::uuid`),
        ),
      }));
      expect(committed.result).toEqual([{ level_id: good, method: 'computed', revision: 1 }]);
      expect(committed.outcome).toEqual([{ outcome: 'written' }]);
    },
    120_000,
  );

  it.each([false, true])(
    '旧启用成功台账重放拒绝：当前 enabled=%s',
    async (enabled) => {
      const w = await successionWorld(db().db, 'health-enable-replay');
      const id = await legacy(w);
      const commandId = randomUUID();
      const body = { enabled: true };
      const path = `/health-levels/${id}`;
      const hash = commandHash(w.user.id, {
        method: 'PUT',
        path: `${SC_BASE}${path}`,
        expectedRevision: 1,
        input: { id, body },
      });
      await w.asTenant(async (tx) => {
        await tx.execute(sql`UPDATE succession_health_levels SET enabled=${enabled} WHERE id=${id}::uuid`);
        await tx.execute(sql`INSERT INTO command_ledger
        (tenant_id,command_id,request_hash,response_status,response_body)
        VALUES (${w.tenant.id}::uuid,${commandId},${hash},200,
          ${JSON.stringify({ kind: 'record', ids: [id], commandId })}::jsonb)`);
      });
      const before = await snapshot(w);
      await rejected(await w.request('PUT', path, { ifMatch: 1, idempotencyKey: commandId, body }));
      expect(await snapshot(w)).toEqual(before);
    },
    120_000,
  );

  it('入口检查后规则变化：命令事务重放前重新判定', async () => {
    const w = await successionWorld(db().db, 'health-enable-replay-current');
    const id = await level(w, 'LEGACY', false);
    const commandId = randomUUID();
    const body = { enabled: true };
    const path = `${SC_BASE}/health-levels/${id}`;
    const hash = commandHash(w.user.id, { method: 'PUT', path, expectedRevision: 1, input: { id, body } });
    await w.asTenant(async (tx) => {
      await tx.execute(sql`INSERT INTO command_ledger
        (tenant_id,command_id,request_hash,response_status,response_body)
        VALUES (${w.tenant.id}::uuid,${commandId},${hash},200,
          ${JSON.stringify({ kind: 'record', ids: [id], commandId })}::jsonb)`);
    });
    let checks = 0;
    const api = tenantApi(w.db, {
      clock: () => SC_NOW,
      authorize: async (request) => {
        if (request.resource === 'Succession.HealthLevel' && request.action === 'object.update' && ++checks === 2) {
          // 在入口检查完成、命令事务重验授权时提交旧规则，证明不会复用入口快照。
          await w.asTenant(async (tx) => {
            await tx.execute(sql`UPDATE succession_health_level_rows SET population='all' WHERE level_id=${id}::uuid`);
          });
        }
        return true;
      },
    });
    await rejected(
      await api.request('PUT', path, {
        tenant: w.tenant.id,
        user: w.user.id,
        ifMatch: 1,
        idempotencyKey: commandId,
        body,
      }),
    );
    expect(checks).toBe(2);
    const saved = await snapshot(w);
    expect(saved.levels[0]).toMatchObject({ enabled: false, revision: 1 });
  }, 120_000);

  it('持锁更新独立拒绝继承的禁用规则，不依赖路由预检', async () => {
    const w = await successionWorld(db().db, 'health-enable-locked');
    const id = await legacy(w);
    const before = await snapshot(w);
    await expect(
      w.asTenant((tx) =>
        mutateLevel(
          tx,
          { db: w.db, authorize: () => true, clock: () => SC_NOW },
          {
            tenantId: w.tenant.id,
            userId: w.user.id,
            timezone: 'Asia/Shanghai',
            expectedRevision: 1,
            now: SC_NOW,
            commandId: randomUUID(),
          },
          'health',
          'update',
          id,
          { enabled: true },
        ),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'HEALTH_RULE_COMBINATION_UNSUPPORTED' } });
    expect(await snapshot(w)).toEqual(before);
  }, 120_000);

  it.each(['disable', 'delete', 'clear', 'replace'])(
    '修复路径 %s 保持可用',
    async (repair) => {
      const w = await successionWorld(db().db, 'health-enable-repair');
      const id = await legacy(w);
      await w.asTenant(async (tx) => {
        await tx.execute(sql`UPDATE succession_health_levels SET enabled=true WHERE id=${id}::uuid`);
      });
      const body =
        repair === 'disable' ? { enabled: false } : { enabled: true, rules: repair === 'clear' ? null : rules };
      const response = await w.request(repair === 'delete' ? 'DELETE' : 'PUT', `/health-levels/${id}`, {
        ifMatch: 1,
        ...(repair === 'delete' ? {} : { body }),
      });
      expect(response.status, await response.clone().text()).toBe(200);
      const saved = await snapshot(w);
      if (repair === 'delete') expect(saved.levels).toEqual([]);
      else {
        expect(saved.levels[0]).toMatchObject({ enabled: repair !== 'disable', revision: 2 });
        if (repair === 'clear') expect(saved.rules).toEqual([]);
        if (repair === 'replace') expect(saved.rules[0]).toMatchObject({ population: 'incumbents' });
      }
    },
    120_000,
  );
});
