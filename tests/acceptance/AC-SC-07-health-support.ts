import { sql, type DbHandle } from '@italent/db';
import { createTestDb } from '@italent/testkit';
import { beforeAll, afterAll } from 'vitest';
import type { SuccessionWorld } from './AC-SC-support.js';
import { enableStatsRunner } from './AC-SC-stats-support.js';
export async function enableHealthRunner(w: SuccessionWorld) {
  await enableStatsRunner(w);
  await w.asTenant(async (tx) => {
    await tx.execute(sql`INSERT INTO permission_identity_scopes
      (tenant_id,profile_id,app_code,target_kind,target_code,see_all)
      SELECT ${w.tenant.id}::uuid,id,'SuccessionAndDevelopment','entity','Succession.HealthResult',true
      FROM permission_profiles WHERE code='standard_succession_runner'`);
    // 正向计算用例显式授予组织源读权；目标结果写权不代表源读取权。
    await tx.execute(sql`INSERT INTO permission_profile_apps(tenant_id,profile_id,app_code)
      SELECT ${w.tenant.id}::uuid,id,'TenantBase' FROM permission_profiles
      WHERE code='standard_succession_runner' ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO permission_profile_objects
      (tenant_id,profile_id,object_code,can_create,can_update,can_delete)
      SELECT ${w.tenant.id}::uuid,id,'TenantBase.Organization',false,false,false
      FROM permission_profiles WHERE code='standard_succession_runner'`);
    await tx.execute(sql`INSERT INTO permission_profile_fields
      (tenant_id,profile_id,object_code,field_code,can_view,can_edit)
      SELECT ${w.tenant.id}::uuid,id,'TenantBase.Organization','personInChargeId',true,false
      FROM permission_profiles WHERE code='standard_succession_runner'`);
    await tx.execute(sql`INSERT INTO permission_identity_scopes
      (tenant_id,profile_id,app_code,target_kind,target_code,see_all)
      SELECT ${w.tenant.id}::uuid,id,'TenantBase','entity','TenantBase.Organization',true
      FROM permission_profiles WHERE code='standard_succession_runner'`);
  });
}
/** 百余份迁移、333 张表：本机多窗口验证曾超过 60s；仅本组建库给 180s，不重试或跳过迁移。 */
export function useHealthDb() {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await createTestDb();
  }, 180_000);
  afterAll(async () => {
    await handle?.close();
  });
  return () => handle;
}
