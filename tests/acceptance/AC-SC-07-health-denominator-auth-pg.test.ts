import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { successionWorld, SC_NOW, SC_BASE } from './AC-SC-support.js';
import { enableHealthRunner, useHealthDb } from './AC-SC-07-health-support.js';
import { tenantApi } from './support/tenant-api.js';
import { createPermissionAuthorizer } from '../../apps/api/src/modules/permission/authorizer.js';
import { objectCatalog } from '../../apps/api/src/modules/permission/catalog.js';
import { runCalcPage } from '../../apps/api/src/modules/succession/calc-worker.js';
import { rowsOf } from '../../apps/api/src/modules/succession/read-sql.js';
import * as ports from '../../apps/api/src/modules/succession/ports.js';
import { createInMemoryTalentReviewSyncPort } from '../../apps/api/src/modules/talent-review/sync-port-memory.js';

const db = useHealthDb();
afterEach(() => vi.restoreAllMocks());
const sources = [
  { source: '组织', fieldSource: 'org', fieldCode: 'on_duty_count' },
  { source: '盘点', fieldSource: 'review', fieldCode: 'score' },
  { source: '继任', fieldSource: 'succession', fieldCode: 'successor_count' },
  { source: '无字段', fieldSource: 'review', fieldCode: null },
] as const;
const cases = sources.flatMap((source) =>
  ['no_view', 'hidden_field', 'empty_scope', 'allowed'].flatMap((access) =>
    [false, true].map((reset) => ({ ...source, access, reset })),
  ),
);
// DEC-455①：真实授权、HTTP 排队、默认生产 kind；只替换尚未接线的 T04 取数端口。
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-SC-07 负责人分母授权矩阵', () => {
  it.each(cases)(
    '$source × $access × 重置=$reset：提交后核对等级与 revision',
    async (test) => {
      const { access, reset } = test;
      const w = await successionWorld(db().db, 'health-denominator-auth');
      const org = await w.org('合成分母组织');
      const person = await w.hire('合成负责人', { departmentId: org.id });
      await w.setHead(org, person);
      await enableHealthRunner(w);
      await w.asTenant(async (tx) => {
        await tx.execute(sql`INSERT INTO talent_review_fields
          (tenant_id,code,name,kind,field_group,precision)
          VALUES (${w.tenant.id}::uuid,'score','合成分数','number','result',2)`);
      });
      const port = createInMemoryTalentReviewSyncPort({
        tenantId: w.tenant.id,
        fields: [
          { code: 'score', label: '分数', group: '盘点', kind: 'number', systemWritten: true, formulaUsable: true },
        ],
      });
      const reads = Object.assign(Object.create(port) as typeof port, {
        readReviewFields: vi.fn(
          async () =>
            new Map([
              [
                person.id,
                {
                  source: null,
                  values: { score: { status: 'value' as const, value: 1 } },
                },
              ],
            ]),
        ),
        readSuccessionEntries: vi.fn(async () => [
          {
            employeeId: null,
            orgId: org.id,
            positionId: null,
            status: 'value' as const,
            source: null,
            nominations: [
              {
                nominationId: randomUUID(),
                objectId: randomUUID(),
                employeeId: person.id,
                kind: 'org' as const,
                direction: 'successor' as const,
                orgId: org.id,
                positionId: null,
                successorEmployeeId: person.id,
                readinessId: null,
                readinessCode: 'READY',
                sortNo: 1,
                createdAt: SC_NOW,
                syncEligible: true,
                formValues: {},
              },
            ],
          },
        ]),
      });
      vi.spyOn(ports, 'successionReviewReads').mockReturnValue(reads);
      const old = await w.request('POST', '/health-levels', {
        ifMatch: 0,
        body: { code: 'OLD', name: '原等级', color: '#336699', enabled: false },
      });
      expect(old.status).toBe(201);
      const originalLevelId = (await old.json()).id;
      const grade = await w.request('POST', '/health-levels', {
        ifMatch: 0,
        body: {
          code: 'MATCH',
          name: '全部人数除以负责人人数',
          color: '#669933',
          rules: {
            expression: '1',
            rows: [
              {
                rowNo: 1,
                population: 'all',
                fieldSource: test.fieldSource,
                fieldCode: test.fieldCode,
                measure: 'count_over_incumbents',
                comparator: 'eq',
                threshold: 1,
              },
            ],
          },
        },
      });
      expect(grade.status, await grade.clone().text()).toBe(201);
      const matchedLevelId = (await grade.json()).id;
      const method = reset ? 'manual' : 'computed';
      await w.asTenant(async (tx) => {
        await tx.execute(sql`INSERT INTO succession_health_results(tenant_id,org_id,level_id,method,revision)
        VALUES (${w.tenant.id}::uuid,${org.id}::uuid,${originalLevelId}::uuid,${method},1)`);
        await tx.execute(sql`DELETE FROM permission_profile_fields WHERE object_code='TenantBase.Organization'`);
        await tx.execute(sql`DELETE FROM permission_profile_objects WHERE object_code='TenantBase.Organization'`);
        await tx.execute(sql`UPDATE permission_identity_scopes SET see_all=false
        WHERE app_code='TenantBase' AND target_code='TenantBase.Organization'`);
        if (access !== 'no_view') {
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
          if (access !== 'hidden_field')
            await tx.execute(sql`INSERT INTO permission_profile_fields
            (tenant_id,profile_id,object_code,field_code,can_view,can_edit)
            SELECT ${w.tenant.id}::uuid,id,'TenantBase.Organization','personInChargeId',true,false
            FROM permission_profiles WHERE code='standard_succession_runner'`);
          if (access !== 'empty_scope')
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
      ).toBe(access !== 'no_view');
      const api = tenantApi(w.db, { authorize, clock: () => SC_NOW });
      const queued = await api.request(
        'POST',
        `${SC_BASE}/${reset ? 'health-results/reset' : 'maps/org/compute-health'}`,
        {
          tenant: w.tenant.id,
          user: w.user.id,
          ifMatch: 0,
          body: reset ? { items: [{ orgId: org.id, expectedRevision: 1 }] } : {},
        },
      );
      expect(queued.status, await queued.clone().text()).toBe(202);
      const { runId } = await queued.json();
      const status = await runCalcPage(w.db, w.tenant.id, runId, undefined, SC_NOW);
      // worker 结束后另开事务，证明没有覆盖原等级，也没有清除手工标记或增加 revision。
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
        WHERE org_id=${org.id}::uuid`),
        ),
      }));
      if (access === 'allowed') {
        expect(committed.result).toEqual([{ level_id: matchedLevelId, method: 'computed', revision: 2 }]);
        expect(committed.outcome).toEqual([{ outcome: 'written' }]);
        expect(committed.failures).toEqual([]);
        expect(status).toBe('succeeded');
      } else {
        expect(committed.result).toEqual([{ level_id: originalLevelId, method, revision: 1 }]);
        expect(committed.outcome).toEqual([{ outcome: 'failed' }]);
        expect(committed.failures).toEqual([{ code: 'FIELD_FORBIDDEN', row_no: 1 }]);
        expect(status).toBe('partial');
        expect(committed.cache).toEqual([]);
        expect(reads.readReviewFields).not.toHaveBeenCalled();
        expect(reads.readSuccessionEntries).not.toHaveBeenCalled();
      }
    },
    120_000,
  );
});
