import { sql } from '@italent/db';
import { describe, expect, it } from 'vitest';
import { successionWorld, SC_NOW, SC_BASE, type SuccessionWorld } from './AC-SC-support.js';
import { enableHealthRunner, useHealthDb } from './AC-SC-07-health-support.js';
import { tenantApi } from './support/tenant-api.js';
import { createPermissionAuthorizer } from '../../apps/api/src/modules/permission/authorizer.js';
import { objectCatalog } from '../../apps/api/src/modules/permission/catalog.js';
import { runCalcPage } from '../../apps/api/src/modules/succession/calc-worker.js';
import { rowsOf } from '../../apps/api/src/modules/succession/read-sql.js';

const db = useHealthDb();
const combinations = ['org', 'review', 'succession'].flatMap((fieldSource) =>
  ['count', 'ratio'].flatMap((measure) =>
    [false, true].flatMap((reset) =>
      [false, true].map((authorized) => ({ fieldSource, measure, reset, authorized, layout: 'ordinary' })),
    ),
  ),
);
const cases = [
  ...combinations,
  ...['unreferenced', 'later_level'].flatMap((layout) =>
    [false, true].map((reset) => ({ fieldSource: 'review', measure: 'count', reset, authorized: true, layout })),
  ),
];
async function sourceRights(w: SuccessionWorld, authorized: boolean) {
  await w.asTenant(async (tx) => {
    if (!authorized) {
      await tx.execute(sql`DELETE FROM permission_profile_fields
        WHERE object_code IN ('TenantBase.Organization','TenantBase.EmployeeInformation')`);
      await tx.execute(sql`DELETE FROM permission_profile_objects
        WHERE object_code IN ('TenantBase.Organization','TenantBase.EmployeeInformation')`);
      return;
    }
    await tx.execute(sql`INSERT INTO permission_profile_objects
      (tenant_id,profile_id,object_code,can_create,can_update,can_delete)
      SELECT ${w.tenant.id}::uuid,id,'TenantBase.EmployeeInformation',false,false,false
      FROM permission_profiles WHERE code='standard_succession_runner' ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO permission_profile_fields
      (tenant_id,profile_id,object_code,field_code,can_view,can_edit)
      SELECT ${w.tenant.id}::uuid,id,'TenantBase.EmployeeInformation','name',true,false
      FROM permission_profiles WHERE code='standard_succession_runner' ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO permission_identity_scopes
      (tenant_id,profile_id,app_code,target_kind,target_code,see_all)
      SELECT ${w.tenant.id}::uuid,id,'TenantBase','entity','TenantBase.EmployeeInformation',true
      FROM permission_profiles WHERE code='standard_succession_runner' ON CONFLICT DO NOTHING`);
  });
}
// DEC-460 限制按组合生效，不因主体恰好有读取权而放开；既有规则通过 SQL 模拟历史存量。
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-SC-07 DEC-460 L2 既有规则真 PG', () => {
  it.each(cases)(
    '$fieldSource × $measure × 重置=$reset × 授权=$authorized × $layout：失败不落库',
    async (test) => {
      const w = await successionWorld(db().db, 'health-l2-worker');
      const org = await w.org('合成 L2 组织');
      const person = await w.hire('合成在职负责人', { departmentId: org.id });
      await w.setHead(org, person);
      await enableHealthRunner(w);
      const supported = {
        rowNo: 1,
        population: 'incumbents',
        fieldSource: 'org',
        fieldCode: null,
        measure: test.measure,
        comparator: 'eq',
        threshold: 1,
      };
      const save = async (code: string, enabled: boolean, rows?: object[]) => {
        const response = await w.request('POST', '/health-levels', {
          ifMatch: 0,
          body: {
            code,
            name: code,
            color: '#336699',
            enabled,
            ...(rows ? { rules: { expression: '1', rows } } : {}),
          },
        });
        expect(response.status, await response.clone().text()).toBe(201);
        return (await response.json()).id as string;
      };
      const originalLevelId = await save('OLD', false);
      if (test.layout === 'later_level') await save('EARLY_MATCH', true, [supported]);
      const rowNo = test.layout === 'unreferenced' ? 2 : 1;
      const levelId = await save(
        'LEGACY',
        true,
        test.layout === 'unreferenced' ? [supported, { ...supported, rowNo }] : [supported],
      );
      const method = test.reset ? 'manual' : 'computed';
      await w.asTenant(async (tx) => {
        await tx.execute(sql`UPDATE succession_health_level_rows SET population='all',field_source=${test.fieldSource}
        WHERE level_id=${levelId}::uuid AND row_no=${rowNo}`);
        await tx.execute(sql`INSERT INTO succession_health_results(tenant_id,org_id,level_id,method,revision)
        VALUES (${w.tenant.id}::uuid,${org.id}::uuid,${originalLevelId}::uuid,${method},1)`);
      });
      await sourceRights(w, test.authorized);
      const authorize = createPermissionAuthorizer(w.db, objectCatalog, () => SC_NOW);
      for (const resource of ['TenantBase.Organization', 'TenantBase.EmployeeInformation'])
        expect(await authorize({ tenantId: w.tenant.id, userId: w.user.id, action: 'object.view', resource })).toBe(
          test.authorized,
        );
      const api = tenantApi(w.db, { authorize, clock: () => SC_NOW });
      const queued = await api.request(
        'POST',
        `${SC_BASE}/${test.reset ? 'health-results/reset' : 'maps/org/compute-health'}`,
        {
          tenant: w.tenant.id,
          user: w.user.id,
          ifMatch: 0,
          body: test.reset ? { items: [{ orgId: org.id, expectedRevision: 1 }] } : {},
        },
      );
      expect(queued.status, await queued.clone().text()).toBe(202);
      const { runId } = await queued.json();
      const status = await runCalcPage(w.db, w.tenant.id, runId, undefined, SC_NOW);
      // 必须等 worker 事务结束，再在独立事务确认持久化状态，不依赖页内对象或返回码。
      const committed = await w.asTenant(async (tx) => ({
        result: rowsOf(
          await tx.execute(sql`SELECT level_id,method,revision FROM succession_health_results
        WHERE org_id=${org.id}::uuid`),
        ),
        outcome: rowsOf(
          await tx.execute(sql`SELECT outcome FROM succession_calc_run_objects
        WHERE run_id=${runId}::uuid AND object_id=${org.id}::uuid`),
        ),
        failure: rowsOf(
          await tx.execute(sql`SELECT code,level_id,row_no FROM succession_calc_run_failures
        WHERE run_id=${runId}::uuid AND object_id=${org.id}::uuid`),
        ),
      }));
      expect(committed.result).toEqual([{ level_id: originalLevelId, method, revision: 1 }]);
      expect(committed.outcome).toEqual([{ outcome: 'failed' }]);
      expect(committed.failure).toEqual([{ code: 'FIELD_FORBIDDEN', level_id: levelId, row_no: rowNo }]);
      expect(status).toBe('partial');
    },
    120_000,
  );
});
