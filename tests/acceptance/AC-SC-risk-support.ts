import { sql } from '@italent/db';
import type { Db } from '@italent/db';
import { expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { successionWorld, SC_NOW, SC_TODAY } from './AC-SC-support.js';
import { enableStatsRunner } from './AC-SC-stats-support.js';
import { enqueueCalcRun, runCalcPage } from '../../apps/api/src/modules/succession/calc-worker.js';
import { rowsOf } from '../../apps/api/src/modules/succession/read-sql.js';
export async function riskWorld(db: Db) {
  const w = await successionWorld(db, `risk-${randomUUID()}`);
  const org = await w.org('风险计算组织');
  const position = await w.position(org.id, '风险职位');
  const successor = await w.hire('合成继任者', { departmentId: org.id });
  await w.insertRecord({ type: 'position', targetId: position.id, successorId: successor.id });
  await enableStatsRunner(w);
  await w.asTenant((tx) =>
    tx.execute(sql`INSERT INTO permission_identity_scopes
    (tenant_id,profile_id,app_code,target_kind,target_code,see_all)
    SELECT ${w.tenant.id}::uuid,id,'SuccessionAndDevelopment','entity','Succession.RiskResult',true
    FROM permission_profiles WHERE code='standard_succession_runner'
    ON CONFLICT (tenant_id,profile_id,app_code,target_kind,target_code) DO UPDATE SET see_all=true`),
  );
  const response = await w.request('POST', '/risk-levels', {
    ifMatch: 0,
    body: {
      code: 'AUTO',
      name: '自动风险',
      color: '#123456',
      rules: {
        expression: '1',
        rows: [
          {
            rowNo: 1,
            subject: 'successor',
            measure: 'count',
            comparator: 'ge',
            threshold: 1,
          },
        ],
      },
    },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const levelId = ((await response.json()) as { id: string }).id;
  const assign = (revision: number, value: string | null = levelId) =>
    w.request('PUT', `/risk-results/${position.id}`, { ifMatch: revision, body: { levelId: value } });
  const enqueue = () =>
    w.asTenant((tx) =>
      enqueueCalcRun(
        tx,
        {
          tenantId: w.tenant.id,
          kind: 'position_risk',
          trigger: 'manual',
          requestedBy: w.user.id,
          commandId: randomUUID(),
          businessDate: SC_TODAY,
          objects: [{ objectType: 'position', objectId: position.id }],
        },
        SC_NOW,
      ),
    );
  const run = (id: string) => runCalcPage(db, w.tenant.id, id, undefined, SC_NOW);
  const result = () =>
    w.asTenant(
      async (tx) =>
        rowsOf<{ level_id: string | null; method: string; revision: number }>(
          await tx.execute(
            sql`SELECT level_id,method,revision FROM succession_risk_results WHERE position_id=${position.id}::uuid`,
          ),
        )[0]!,
    );
  return { ...w, newPosition: w.position, org, position, levelId, assign, enqueue, run, result };
}
