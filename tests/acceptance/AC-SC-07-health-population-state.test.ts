import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SuccessionLevelRow, SyncNomination } from '@italent/domain';
import { successionWorld, SC_NOW } from './AC-SC-support.js';
import { enableHealthRunner, useHealthDb } from './AC-SC-07-health-support.js';
import { healthPrincipal } from '../../apps/api/src/modules/succession/health-principal.js';
import { healthMetricReader } from '../../apps/api/src/modules/succession/health-metrics.js';
import { createHealthHandler } from '../../apps/api/src/modules/succession/health-worker.js';
import { runCalcPage } from '../../apps/api/src/modules/succession/calc-worker.js';
import { createInMemoryTalentReviewSyncPort } from '../../apps/api/src/modules/talent-review/sync-port-memory.js';
import { sql, eq, successionCalcRuns, successionCalcRunObjects } from '@italent/db';

const db = useHealthDb();
const fields = ['successor_count', null, 'readiness_code'] as const;
const states = ['empty_incumbents', 'empty_custom', 'no_matching_nominees', 'source_zero', 'module_absent'] as const;
const cases = fields.flatMap((fieldCode) => states.map((state) => ({ fieldCode, state })));
// 每个用例走配置、计算排队、生产 worker、结果读取；仅本组明确长 HTTP 链路的 120s 上限。
describe('AC-SC-07 空人口 / 原始来源 / 匹配结果独立矩阵', () => {
  it.each(cases)(
    '$fieldCode × $state：empty 与真实零不混淆',
    async ({ fieldCode, state }) => {
      const w = await successionWorld(db().db, `health-pop-${state}`),
        org = await w.org('人口状态组织');
      const head = await w.hire('合成负责人候选', { departmentId: org.id });
      const nominee = await w.hire('合成继任候选', { departmentId: org.id });
      await enableHealthRunner(w);
      if (state === 'no_matching_nominees' || state === 'source_zero') await w.setHead(org, head);
      let populationId: string | null = null;
      if (state === 'empty_custom') {
        // 此矩阵验证无人命中，不把来源字段未授权混进人口状态。
        await w.asTenant(async (tx) => {
          await tx.execute(sql`INSERT INTO permission_profile_apps(tenant_id,profile_id,app_code)
            SELECT ${w.tenant.id}::uuid,id,'TenantBase' FROM permission_profiles
            WHERE code='standard_succession_runner' ON CONFLICT DO NOTHING`);
          await tx.execute(sql`INSERT INTO permission_profile_objects
            (tenant_id,profile_id,object_code,can_create,can_update,can_delete)
            SELECT ${w.tenant.id}::uuid,id,'TenantBase.EmployeeInformation',false,false,false
            FROM permission_profiles WHERE code='standard_succession_runner'`);
          await tx.execute(sql`INSERT INTO permission_profile_fields
            (tenant_id,profile_id,object_code,field_code,can_view,can_edit)
            SELECT ${w.tenant.id}::uuid,id,'TenantBase.EmployeeInformation','entryDate',true,false
            FROM permission_profiles WHERE code='standard_succession_runner'`);
          await tx.execute(sql`INSERT INTO permission_identity_scopes
            (tenant_id,profile_id,app_code,target_kind,target_code,see_all)
            SELECT ${w.tenant.id}::uuid,id,'TenantBase','entity','TenantBase.EmployeeInformation',true
            FROM permission_profiles WHERE code='standard_succession_runner'`);
        });
        const custom = await w.request('POST', '/populations', {
          ifMatch: 0,
          body: {
            code: 'NO_MEMBER',
            name: '无人命中',
            rules: {
              expression: '1',
              rows: [
                {
                  rowNo: 1,
                  kind: 'field',
                  field: { object: 'employee', code: 'entry_date', path: 'employee.entry_date', kind: 'date' },
                  operator: 'eq',
                  values: ['1900-01-01'],
                },
              ],
            },
          },
        });
        expect(custom.status, await custom.clone().text()).toBe(201);
        populationId = (await custom.json()).id;
      }
      const nomination: SyncNomination = {
        nominationId: randomUUID(),
        objectId: randomUUID(),
        employeeId: nominee.id,
        kind: 'org',
        direction: 'successor',
        orgId: org.id,
        positionId: null,
        successorEmployeeId: nominee.id,
        readinessId: null,
        readinessCode: 'READY',
        sortNo: 1,
        createdAt: SC_NOW,
        syncEligible: true,
        formValues: {},
      };
      const raw = state === 'source_zero' || state === 'module_absent' ? [] : [nomination];
      const status = state === 'module_absent' ? ('module_absent' as const) : ('value' as const);
      const port = Object.assign(createInMemoryTalentReviewSyncPort({ tenantId: w.tenant.id }), {
        readSuccessionEntries: async (_tx: unknown, args: { orgIds: readonly string[] }) =>
          args.orgIds.map((id) => ({
            employeeId: null,
            orgId: id,
            positionId: null,
            status,
            source: null,
            nominations: raw.filter((n) => n.orgId === id),
          })),
      });
      const row: SuccessionLevelRow = {
        rowNo: 1,
        population: state === 'empty_custom' ? 'custom' : 'incumbents',
        populationId,
        fieldSource: 'succession',
        fieldCode,
        measure: 'successor_count',
        filterOperator: null,
        filterValues: [],
        comparator: 'eq',
        threshold: 0,
        thresholdHigh: null,
        isPercent: false,
      };
      const saved = await w.request('POST', '/health-levels', {
        ifMatch: 0,
        body: {
          code: 'ZERO',
          name: '零人数等级',
          color: '#336699',
          rules: { expression: '1', rows: [row] },
        },
      });
      expect(saved.status, await saved.clone().text()).toBe(201);
      const levelId = (await saved.json()).id;
      const queued = await w.request('POST', '/maps/org/compute-health', { ifMatch: 0, body: {} });
      expect(queued.status).toBe(202);
      const { runId } = await queued.json();
      let expected: { status: string; value?: number } = { status: 'value', value: 0 };
      if (state === 'empty_incumbents' || state === 'empty_custom') expected = { status: 'empty' };
      if (state === 'module_absent') expected = { status: 'module_absent' };
      const observed = await w.asTenant(async (tx) => {
        const [run] = await tx.select().from(successionCalcRuns).where(eq(successionCalcRuns.id, runId)),
          [object] = await tx
            .select()
            .from(successionCalcRunObjects)
            .where(eq(successionCalcRunObjects.objectId, org.id));
        return healthMetricReader(
          { tx, run: run!, now: SC_NOW },
          object!,
          await healthPrincipal(tx, w.tenant.id, false),
          port,
        )(row);
      });
      expect(await runCalcPage(w.db, w.tenant.id, runId, [createHealthHandler('org_health', port)], SC_NOW)).toBe(
        'succeeded',
      );
      const results = await (await w.request('GET', '/health-results')).json();
      const result = results.items.find((item: { orgId: string }) => item.orgId === org.id);
      expect(result).toMatchObject({
        orgId: org.id,
        method: 'computed',
        revision: 1,
        levelId: state === 'no_matching_nominees' || state === 'source_zero' ? levelId : null,
      });
      expect(observed).toEqual(expected);
    },
    120_000,
  );
});
