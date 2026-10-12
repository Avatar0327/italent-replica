import { randomUUID } from 'node:crypto';
import { sql, type DbHandle } from '@italent/db';
import { createTestDb } from '@italent/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { riskWorld } from './AC-SC-risk-support.js';
import { bootstrapTenantAdmin } from '@italent/api';
import { cmd, tenantApi } from './support/tenant-api.js';
import { SC_NOW, SC_TODAY } from './AC-SC-support.js';
import { riskPeople } from '../../apps/api/src/modules/succession/risk-people.js';
import { rowsOf } from '../../apps/api/src/modules/succession/read-sql.js';
import { resolveDataScope } from '../../apps/api/src/modules/permission/scope-resolver.js';
import { scopeAllows } from '../../apps/api/src/modules/permission/module-access.js';

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-SC-risk 实际来源上下文（真 PG / 真实授权器）', () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await createTestDb();
  }, 300000);
  afterAll(async () => handle?.close());
  it.each(['count', 'count_over_incumbents', 'count_over_successors'])(
    '%s：来源范围非空但不含当前目标时失败；授权目标后允许真实空值',
    async (measure) => {
      const w = await riskWorld(handle.db);
      const created = await w.call('POST', 'org/organizations', {
        ifMatch: 0,
        body: { name: '范围外组织', parents: { admin: { parentId: w.tenant.id } } },
      });
      expect(created.status).toBe(201);
      const outside = (await created.json()) as { id: string };
      const target = await w.newPosition(outside.id, '空关键职位');
      await bootstrapTenantAdmin(w.db, { tenantId: w.tenant.id, userId: w.user.id }, cmd());
      const pw = {
        api: tenantApi(w.db, { authorize: undefined, clock: () => SC_NOW }),
        asAdmin: { tenant: w.tenant.id, user: w.user.id },
      };
      const setScope = async (orgId: string, revision: number) => {
        const mou = await pw.api.request('POST', '/api/tenant/permission/mous', {
          ...pw.asAdmin,
          ifMatch: 0,
          body: { code: randomUUID(), name: '来源范围', orgRanges: [{ orgId, includeDescendants: false }] },
        });
        expect(mou.status).toBe(201);
        const response = await pw.api.request(
          'PUT',
          `/api/tenant/permission/scopes/${w.user.id}/SuccessionAndDevelopment`,
          {
            ...pw.asAdmin,
            ifMatch: revision,
            body: { kind: 'mou', mouId: ((await mou.json()) as { id: string }).id },
          },
        );
        expect(response.status).toBe(200);
      };
      await setScope(w.org.id, 0);
      const submit = async () => {
        const response = await pw.api.request('POST', '/api/tenant/succession/maps/position/compute-risk', {
          ...pw.asAdmin,
          ifMatch: 0,
          body: { rootOrgId: outside.id, showKeyPositions: true, showPositionsWithoutSuccessor: true },
        });
        expect(response.status).toBe(202);
        return ((await response.json()) as { runId: string }).runId;
      };
      const result = () =>
        w.asTenant(async (tx) =>
          rowsOf(
            await tx.execute(sql`
        SELECT level_id,method,revision FROM succession_risk_results WHERE position_id=${target.id}::uuid`),
          ),
        );
      expect(await w.run(await submit())).toBe('succeeded');
      const before = await result();
      expect(before).toEqual([{ level_id: null, method: 'computed', revision: 1 }]);
      const readiness = await w.readiness('合成准备度');
      const updated = await w.request('PUT', `/risk-levels/${w.levelId}`, {
        ifMatch: 1,
        body: {
          rules: {
            expression: '1',
            rows: [
              {
                rowNo: 1,
                subject: 'successor',
                fieldCode: 'readiness_id',
                filterOperator: 'eq',
                filterValues: [readiness.id],
                measure,
                comparator: 'is_empty',
              },
            ],
          },
        },
      });
      expect(updated.status).toBe(200);
      const evidence = await w.asTenant(async (tx) => {
        const scope = await resolveDataScope(tx, {
          tenantId: w.tenant.id,
          userId: w.user.id,
          asOf: SC_TODAY,
          appCode: 'SuccessionAndDevelopment',
          objectCode: 'Succession.Record',
        });
        const people = await riskPeople(
          tx,
          {
            tenantId: w.tenant.id,
            userId: w.user.id,
            positionId: target.id,
            asOf: SC_TODAY,
            today: SC_TODAY,
            partTime: false,
          },
          ['readiness_id'],
        );
        return { nonempty: scope.hasDataPermission, allowed: scopeAllows(scope, { orgId: outside.id }), people };
      });
      expect(evidence.nonempty).toBe(true);
      expect(evidence.allowed).toBe(false);
      expect(evidence.people.incumbents).toEqual([]);
      expect(evidence.people.successors).toEqual([]);
      const runId = await submit();
      expect(
        await w.asTenant(async (tx) =>
          rowsOf(
            await tx.execute(sql`
        SELECT object_id FROM succession_calc_run_objects WHERE run_id=${runId}::uuid`),
          ),
        ),
      ).toEqual([{ object_id: target.id }]);
      expect(await w.run(runId)).toBe('partial');
      expect(evidence.people.sources.readiness_id).toEqual({ status: 'forbidden' });
      expect(await result()).toEqual(before);
      expect(
        await w.asTenant(async (tx) =>
          rowsOf(
            await tx.execute(sql`
        SELECT code,row_no FROM succession_calc_run_failures WHERE run_id=${runId}::uuid`),
          ),
        ),
      ).toEqual([{ code: 'FIELD_FORBIDDEN', row_no: 1 }]);
      await setScope(outside.id, 1);
      expect(await w.run(await submit())).toBe('succeeded');
      expect(await result()).toEqual([{ level_id: w.levelId, method: 'computed', revision: 2 }]);
    },
  );
});
