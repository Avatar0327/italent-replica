import { sql } from '@italent/db';
import { describe, expect, it } from 'vitest';
import { successionWorld, SC_NOW, SC_TODAY, SC_BASE } from './AC-SC-support.js';
import { enableHealthRunner, useHealthDb } from './AC-SC-07-health-support.js';
import { tenantApi } from './support/tenant-api.js';
import { createPermissionAuthorizer } from '../../apps/api/src/modules/permission/authorizer.js';
import { objectCatalog } from '../../apps/api/src/modules/permission/catalog.js';
import { runCalcPage } from '../../apps/api/src/modules/succession/calc-worker.js';
import { rowsOf } from '../../apps/api/src/modules/succession/read-sql.js';

const db = useHealthDb();
const cases = [
  { name: '无组织查看权：负责人非空计数', fieldCode: 'person_in_charge_id', hiddenField: false, cached: false },
  { name: '有组织查看权但负责人字段不可见', fieldCode: 'person_in_charge_id', hiddenField: true, cached: false },
  { name: '无组织查看权：在岗缓存命中 7', fieldCode: 'on_duty_count', hiddenField: false, cached: true },
  { name: '无组织查看权：在岗缓存未命中，现算 1', fieldCode: 'on_duty_count', hiddenField: false, cached: false },
  {
    name: '有组织查看权但源组织范围为空，缓存命中 7',
    fieldCode: 'on_duty_count',
    hiddenField: false,
    cached: true,
    emptyScope: true,
  },
];
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-SC-07 P2-2 组织源授权真 PG 回归', () => {
  it.each(cases)(
    '$name：对象 FIELD_FORBIDDEN，独立事务确认原结果不变',
    async (test) => {
      const w = await successionWorld(db().db, 'health-source-auth'),
        org = await w.org('合成源授权组织'),
        person = await w.hire('合成负责人', { departmentId: org.id });
      await w.setHead(org, person);
      await enableHealthRunner(w);
      const old = await w.request('POST', '/health-levels', {
        ifMatch: 0,
        body: { code: 'OLD', name: '原健康等级', color: '#336699', enabled: false },
      });
      expect(old.status).toBe(201);
      const originalLevelId = (await old.json()).id;
      const grade = await w.request('POST', '/health-levels', {
        ifMatch: 0,
        body: {
          code: 'MATCH',
          name: '源值错误命中等级',
          color: '#669933',
          rules: {
            expression: '1',
            rows: [
              {
                rowNo: 1,
                population: 'all',
                fieldSource: 'org',
                fieldCode: test.fieldCode,
                measure: test.fieldCode === 'on_duty_count' ? 'average' : 'count',
                comparator: 'eq',
                threshold: test.cached ? 7 : 1,
              },
            ],
          },
        },
      });
      expect(grade.status, await grade.clone().text()).toBe(201);
      await w.asTenant(async (tx) => {
        await tx.execute(sql`INSERT INTO succession_health_results(tenant_id,org_id,level_id,method,revision)
        VALUES (${w.tenant.id}::uuid,${org.id}::uuid,${originalLevelId}::uuid,'computed',1)`);
        await tx.execute(sql`DELETE FROM permission_profile_fields WHERE object_code='TenantBase.Organization'`);
        await tx.execute(sql`DELETE FROM permission_profile_objects WHERE object_code='TenantBase.Organization'`);
        await tx.execute(sql`UPDATE permission_identity_scopes SET see_all=false
        WHERE app_code='TenantBase' AND target_code='TenantBase.Organization'`);
        if (test.hiddenField || test.emptyScope) {
          await tx.execute(sql`INSERT INTO permission_profile_apps(tenant_id,profile_id,app_code)
          SELECT ${w.tenant.id}::uuid,id,'TenantBase' FROM permission_profiles
          WHERE code='standard_succession_runner' ON CONFLICT DO NOTHING`);
          await tx.execute(sql`INSERT INTO permission_profile_objects
          (tenant_id,profile_id,object_code,can_create,can_update,can_delete)
          SELECT ${w.tenant.id}::uuid,id,'TenantBase.Organization',false,false,false
          FROM permission_profiles WHERE code='standard_succession_runner'`);
          await tx.execute(sql`INSERT INTO permission_profile_fields
          (tenant_id,profile_id,object_code,field_code,can_view,can_edit)
          SELECT ${w.tenant.id}::uuid,id,'TenantBase.Organization','name',true,false
          FROM permission_profiles WHERE code='standard_succession_runner'`);
          if (!test.emptyScope)
            await tx.execute(sql`INSERT INTO permission_identity_scopes
          (tenant_id,profile_id,app_code,target_kind,target_code,see_all)
          SELECT ${w.tenant.id}::uuid,id,'TenantBase','entity','TenantBase.Organization',true
          FROM permission_profiles WHERE code='standard_succession_runner'
          ON CONFLICT (tenant_id,profile_id,app_code,target_kind,target_code) DO UPDATE SET see_all=true`);
        }
      });
      const authorize = createPermissionAuthorizer(w.db, objectCatalog, () => SC_NOW);
      expect(
        await authorize({
          tenantId: w.tenant.id,
          userId: w.user.id,
          action: 'object.view',
          resource: 'TenantBase.Organization',
        }),
      ).toBe(Boolean(test.hiddenField || test.emptyScope));
      const api = tenantApi(w.db, { authorize, clock: () => SC_NOW });
      const queued = await api.request('POST', `${SC_BASE}/maps/org/compute-health`, {
        tenant: w.tenant.id,
        user: w.user.id,
        ifMatch: 0,
        body: {},
      });
      expect(queued.status, await queued.clone().text()).toBe(202);
      const { runId } = await queued.json();
      if (test.cached)
        await w.asTenant(async (tx) => {
          await tx.execute(sql`INSERT INTO succession_org_stats
        (tenant_id,org_id,stat_date,on_duty_count,slot_key,computed_at,run_id)
        VALUES (${w.tenant.id}::uuid,${org.id}::uuid,${SC_TODAY}::date,7,'synthetic-cache',
          ${SC_NOW.toISOString()}::timestamptz,${runId}::uuid)`);
        });
      const status = await runCalcPage(w.db, w.tenant.id, runId, undefined, SC_NOW);
      // worker 已结束；另开事务读取结果和对象回执，不能靠页内未提交状态证明保留。
      const committed = await w.asTenant(async (tx) => ({
        result: rowsOf(
          await tx.execute(sql`SELECT level_id,method,revision FROM succession_health_results
        WHERE tenant_id=${w.tenant.id}::uuid AND org_id=${org.id}::uuid`),
        ),
        outcome: rowsOf(
          await tx.execute(sql`SELECT outcome FROM succession_calc_run_objects
        WHERE run_id=${runId}::uuid AND object_id=${org.id}::uuid`),
        ),
        failures: rowsOf(
          await tx.execute(sql`SELECT code,row_no FROM succession_calc_run_failures
        WHERE run_id=${runId}::uuid AND object_id=${org.id}::uuid`),
        ),
        cache: rowsOf(
          await tx.execute(sql`SELECT on_duty_count FROM succession_org_stats
        WHERE org_id=${org.id}::uuid AND stat_date=${SC_TODAY}::date`),
        ),
      }));
      expect(committed.result).toEqual([{ level_id: originalLevelId, method: 'computed', revision: 1 }]);
      expect(committed.outcome).toEqual([{ outcome: 'failed' }]);
      expect(committed.failures).toEqual([{ code: 'FIELD_FORBIDDEN', row_no: 1 }]);
      expect(status).toBe('partial');
      expect(committed.cache).toEqual(test.cached ? [{ on_duty_count: 7 }] : []);
    },
    120_000,
  );
});
