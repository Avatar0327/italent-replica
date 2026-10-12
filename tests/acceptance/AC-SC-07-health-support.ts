import { sql } from '@italent/db';
import type { SuccessionWorld } from './AC-SC-support.js';
import { enableStatsRunner } from './AC-SC-stats-support.js';
export async function enableHealthRunner(w: SuccessionWorld) {
  await enableStatsRunner(w);
  await w.asTenant(async (tx) => {
    await tx.execute(sql`INSERT INTO permission_identity_scopes
      (tenant_id,profile_id,app_code,target_kind,target_code,see_all)
      SELECT ${w.tenant.id}::uuid,id,'SuccessionAndDevelopment','entity','Succession.HealthResult',true
      FROM permission_profiles WHERE code='standard_succession_runner'`);
  });
}
