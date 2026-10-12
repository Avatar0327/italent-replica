import { sql } from '@italent/db';
import { overrideSetting } from '../../apps/api/src/modules/tenant-settings/service.js';
import { randomUUID } from 'node:crypto';
import { SC_NOW, type SuccessionWorld } from './AC-SC-support.js';
import { STANDARD_PROFILES } from '@italent/domain';
import { installProfile } from '../../apps/api/src/modules/permission/standard-profiles.js';

/** 显式给计算主体 Map 看全部；不改变预置身份的默认值。 */
export async function enableStatsRunner(w: SuccessionWorld) {
  await w.asTenant(async (tx) => {
    await installProfile(
      tx,
      { tenantId: w.tenant.id, actorUserId: null, now: SC_NOW, commandId: randomUUID() },
      STANDARD_PROFILES.find((p) => p.code === 'standard_succession_runner')!,
    );
    await tx.execute(sql`INSERT INTO permission_grants(tenant_id,user_id,profile_id)
      SELECT ${w.tenant.id}::uuid,${w.user.id}::uuid,id FROM permission_profiles
      WHERE code='standard_succession_runner'`);
    await tx.execute(sql`INSERT INTO permission_identity_scopes
      (tenant_id,profile_id,app_code,target_kind,target_code,see_all)
      SELECT ${w.tenant.id}::uuid,id,'SuccessionAndDevelopment','entity','Succession.Map',true
      FROM permission_profiles WHERE code='standard_succession_runner'
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
}
